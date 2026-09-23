/*
 * File: parser.ts
 * Project: glmproxy
 * Streaming parser for <tool_call> tags - OpenAI Compatible
 * Supports both JSON and Hermes-style XML <parameter> formats.
 */

import { v4 as uuidv4 } from 'uuid';
import { robustParseJSON } from '../utils/json.ts';
import { logger } from '../core/logger.js';
import type { ParsedToolCall } from './types';
import type { FunctionToolDefinition } from './types';

export interface ParserResult {
  text: string;
  toolCalls: ParsedToolCall[];
}

// ─── XML Helpers ───────────────────────────────────────────────────────────────

// Múltiplos formatos de "open tag" suportados, do mais específico ao genérico.
// - <tool_call> ......... </tool_call>        (formato injetado pelo nosso prompt; Qwen/GLM-4.7)
// - <tool_call_block> ... </tool_call_block>  (wrapper que o GLM-5.1 às vezes usa)
// - <invoke name="x"> ... </invoke>           (formato Claude/Anthropic; GLM-5.1, modelos "thinking")
// O `\b` garante que <tool_call> NÃO casa dentro de <tool_call_block>.
const TOOL_OPENERS: ReadonlyArray<{ re: RegExp; close: string }> = [
  { re: /<tool_call_block\b[^>]*>/i, close: '</tool_call_block>' },
  { re: /<tool_call\b[^>]*>/i, close: '</tool_call>' },
  { re: /<invoke\b[^>]*>/i, close: '</invoke>' },
];
const DEFAULT_TOOL_END = '</tool_call>';

interface OpenerMatch { index: number; openTag: string; close: string }

/** Acha o open tag de tool-call mais à esquerda no buffer, entre todos os formatos. */
function findOpener(buffer: string): OpenerMatch | null {
  let best: OpenerMatch | null = null;
  for (const o of TOOL_OPENERS) {
    const m = buffer.match(o.re);
    if (m && m.index !== undefined && (best === null || m.index < best.index)) {
      best = { index: m.index, openTag: m[0], close: o.close };
    }
  }
  return best;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function coerceParameterValue(rawValue: string): unknown {
  const value = decodeXmlEntities(rawValue.trim());
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return JSON.parse(value); } catch {}
  }
  return value;
}

/**
 * Extract tool name from the opening tag attribute or a <name> child element.
 */
function extractToolName(openTag: string, block: string): string {
  const combined = `${openTag}\n${block}`;
  // Lê name="..." de <tool_call>, <invoke> (Claude) ou <function> (variantes).
  const attrMatch = combined.match(/<(?:tool_call|invoke|function)\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
  if (attrMatch) return attrMatch[1];

  const nameTagMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameTagMatch) return decodeXmlEntities(nameTagMatch[1].trim());

  return '';
}

/**
 * Infer tool name by matching parameter keys against tool definitions.
 * Only returns a name if exactly one tool matches all argument keys.
 */
function inferToolNameFromParameters(args: Record<string, unknown>, tools: FunctionToolDefinition[]): string {
  const argKeys = Object.keys(args);
  if (argKeys.length === 0 || !Array.isArray(tools)) return '';

  const matches = tools.filter((tool) => {
    const fn = tool?.type === 'function' ? tool.function : (tool as any)?.function;
    const properties = fn?.parameters?.properties || {};
    return argKeys.every(k => Object.prototype.hasOwnProperty.call(properties, k));
  });

  if (matches.length === 1) {
    const fn = matches[0]?.type === 'function' ? matches[0].function : (matches[0] as any)?.function;
    return fn?.name || '';
  }

  return '';
}

/**
 * Parse Hermes-style XML <parameter name="...">value</parameter> format.
 */
function parseXmlParameterToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};
  const parameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Try to recover a tool call from a block that may have unclosed <parameter> tags
 * (e.g. stream was cut off before </parameter> or </tool_call>).
 */
function parseRecoverableXmlToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe = /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = closedParameterRe.exec(block)) !== null) {
    args[match[1]] = coerceParameterValue(match[2]);
    lastClosedEnd = closedParameterRe.lastIndex;
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(/<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*)$/i);
  if (unclosedMatch) {
    args[unclosedMatch[1]] = coerceParameterValue(unclosedMatch[2]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

// ─── Partial Tag Detection ─────────────────────────────────────────────────────

const TOOL_START_LITERAL = '<tool_call>';
// Prefixos de open tags que devemos segurar se chegarem partidos no fim do chunk.
const PARTIAL_LITERALS = ['<tool_call_block', '<tool_call', '<invoke'];

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  let best = -1;
  const consider = (idx: number) => { if (idx !== -1 && (best === -1 || idx < best)) best = idx; };

  for (const lit of PARTIAL_LITERALS) {
    // Open tag começado mas sem o `>` de fechamento (ainda chegando).
    const idx = lower.lastIndexOf(lit);
    if (idx !== -1 && lower.indexOf('>', idx) === -1) consider(idx);
    // Prefixo parcial no fim do buffer (ex.: `<tool`, `<inv`).
    for (let i = 1; i < lit.length; i++) {
      if (lower.endsWith(lit.substring(0, i))) consider(buffer.length - i);
    }
  }
  return best;
}

// ─── Bare-JSON tool call (sem tags) ──────────────────────────────────────────────
// Alguns modelos (GLM-5.1) às vezes emitem o JSON do tool-call SEM o wrapper
// `<tool_call>`. Recuperamos isso de forma conservadora: só quando há tools ativas
// e o nome casa com uma tool conhecida (evita falso-positivo em JSON normal).

const BARE_JSON_RE = /\{\s*"(?:name|tool|tool_name|function)"\s*:/;

// Teto de retenção de um bare-JSON ainda aberto. Args legítimos podem ser
// grandes (ex.: tool de edit escrevendo um arquivo inteiro), mas acima disso
// liberamos como texto para não congelar o streaming indefinidamente.
const MAX_BARE_HOLD = 100_000;

// Um `{` solto no fim do buffer só é retido por uma janela curta — o
// suficiente para decidir se vira `{"name": ...` quando o resto do chunk
// chegar. Prosa/código com `{` sem `}` não pode congelar o streaming.
const OPEN_BRACE_WINDOW = 32;

/**
 * Índice de um objeto JSON ainda ABERTO no fim do buffer (último `{` sem `}`
 * depois dele). Evita que um `{` no limite do chunk vaze como texto e quebre a
 * detecção de bare-JSON na próxima chamada.
 */
function findOpenBraceIndex(buffer: string): number {
  const lastOpen = buffer.lastIndexOf('{');
  if (lastOpen === -1) return -1;
  if (buffer.indexOf('}', lastOpen) !== -1) return -1; // já fechou neste buffer
  return lastOpen;
}

/** Conta ocorrências de ``` (toggles de code fence) num trecho de texto. */
function countFenceTicks(text: string): number {
  let count = 0;
  let i = 0;
  while ((i = text.indexOf('```', i)) !== -1) {
    count++;
    i += 3;
  }
  return count;
}

/** Extrai a primeira string JSON balanceada começando em `start` (respeita strings/escapes). */
function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null; // não fechou (stream cortado)
}

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private currentClose = DEFAULT_TOOL_END;
  private emittedToolCallCount = 0;
  private pendingLeadIn = '';
  private tools: FunctionToolDefinition[] = [];
  // Paridade de ``` no texto já consumido: dentro de um code fence, JSON cru é
  // exemplo de código, não tool call.
  private fenceOpen = false;

  /**
   * @param tools - Optional array of tool definitions for name inference
   */
  constructor(tools: FunctionToolDefinition[] = []) {
    this.tools = tools;
  }

  /**
   * Update the tools list (e.g. if received after construction).
   */
  setTools(tools: FunctionToolDefinition[]): void {
    this.tools = tools;
  }

  feed(chunk: string): ParserResult {
    this.buffer += chunk;
    const result: ParserResult = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const match = findOpener(this.buffer);
        if (match) {
          // Text before the tool call tag
          const textBefore = this.buffer.substring(0, match.index);
          // Once a tool call appears, hold the lead-in text.
          // OpenAI-compatible clients expect the whole assistant turn to be
          // a structured tool_calls message when tools are invoked.
          this.trackFences(textBefore);
          this.pendingLeadIn += textBefore;
          this.insideTool = true;
          this.currentOpenTag = match.openTag;
          this.currentClose = match.close;
          this.buffer = this.buffer.substring(match.index + match.openTag.length);
          continue;
        } else {
          // No full open tag found.
          // 1) Tool-call em JSON cru (sem tags, ex.: GLM-5.1): se o JSON já
          //    FECHOU no buffer, resolve agora — emite o tool call (nome
          //    conhecido) ou libera como texto (JSON comum), sem esperar o
          //    flush nem congelar o streaming.
          const bj = this.tools.length > 0 ? this.findBareJsonCandidate() : -1;
          if (bj !== -1) {
            const jsonStr = extractBalancedJson(this.buffer, bj);
            if (jsonStr) {
              const before = this.buffer.substring(0, bj);
              this.trackFences(before + jsonStr);
              this.buffer = this.buffer.substring(bj + jsonStr.length);
              const tc = this.tryParseKnownToolJson(jsonStr);
              if (tc) {
                // Turno vira tool_calls: lead-in suprimido (igual ao caminho com tags).
                this.pendingLeadIn = '';
                result.toolCalls.push(tc);
                this.emittedToolCallCount++;
              } else if (this.emittedToolCallCount === 0) {
                // JSON legítimo da resposta: devolve como texto.
                result.text += before + jsonStr;
              }
              continue;
            }
          }

          // 2) Hold conservador: (a) open tag partido no fim do chunk;
          //    (b) bare-JSON ainda aberto (até MAX_BARE_HOLD); (c) `{` recém-
          //    chegado no fim do buffer (janela curta, fora de code fence).
          const partialIdx = findPartialToolOpenIndex(this.buffer);
          let holdIdx = partialIdx;
          if (this.tools.length > 0) {
            if (bj !== -1 && this.buffer.length - bj <= MAX_BARE_HOLD && (holdIdx === -1 || bj < holdIdx)) {
              holdIdx = bj;
            }
            const ob = findOpenBraceIndex(this.buffer);
            if (ob !== -1 && this.buffer.length - ob <= OPEN_BRACE_WINDOW && !this.isInsideFence(ob) &&
                (holdIdx === -1 || ob < holdIdx)) {
              holdIdx = ob;
            }
          }
          const flushIndex = holdIdx === -1 ? this.buffer.length : holdIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
            this.trackFences(textToEmit);
            // Only emit as content if no tool calls have been emitted yet
            if (this.emittedToolCallCount === 0) {
              result.text += textToEmit;
            }
            this.buffer = this.buffer.substring(flushIndex);
          }
          break;
        }
      } else {
        // Inside tool: look for the matching close tag of the opener we entered.
        const lowerBuffer = this.buffer.toLowerCase();
        const endIdx = lowerBuffer.indexOf(this.currentClose);
        if (endIdx !== -1) {
          const content = this.buffer.substring(0, endIdx);
          this.buffer = this.buffer.substring(endIdx + this.currentClose.length);
          this.processToolContent(content, result);
          this.insideTool = false;
          this.currentOpenTag = TOOL_START_LITERAL;
          this.currentClose = DEFAULT_TOOL_END;
        } else {
          break; // Wait for more data
        }
      }
    }

    return result;
  }

  flush(): ParserResult {
    const result: ParserResult = { text: '', toolCalls: [] };
    if (!this.buffer && !this.pendingLeadIn) return result;

    if (this.insideTool) {
      // Stream ended with unclosed <tool_call>. Try to recover.
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        const recovered = this.tryRecoverToolCall(trimmed);
        if (recovered) {
          result.toolCalls.push(recovered);
          this.emittedToolCallCount++;
          this.pendingLeadIn = '';
        } else {
          // Recovery failed. Restore lead-in text if no tools were emitted.
          logger.warn('[parser] Dropping unrecoverable unclosed tool call at end of stream');
          if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
            result.text += this.pendingLeadIn;
          }
          this.pendingLeadIn = '';
        }
      } else {
        // Empty tool call block - restore lead-in
        if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
          result.text += this.pendingLeadIn;
        }
        this.pendingLeadIn = '';
      }
    } else {
      // Última tentativa: tool-call em JSON cru retido no buffer (ainda aberto
      // porque o stream cortou — robustParseJSON repara chaves faltantes).
      const bare = this.tools.length > 0 ? this.tryParseBareToolJson(this.buffer) : null;
      if (bare) {
        result.toolCalls.push(bare);
        this.emittedToolCallCount++;
        this.pendingLeadIn = '';
      } else if (this.emittedToolCallCount === 0) {
        result.text += this.buffer;
      }
    }

    this.buffer = '';
    this.insideTool = false;
    this.currentOpenTag = TOOL_START_LITERAL;
    this.currentClose = DEFAULT_TOOL_END;
    this.fenceOpen = false;
    return result;
  }

  /**
   * Recupera um tool-call em JSON cru (sem tags) do texto. Conservador:
   * só retorna se o nome casar com uma tool conhecida, evitando falso-positivo
   * quando o assistente legitimamente escreve um objeto JSON na resposta.
   * Se o JSON não fechou (stream cortado), tenta reparar via robustParseJSON.
   */
  private tryParseBareToolJson(text: string): ParsedToolCall | null {
    const idx = text.search(BARE_JSON_RE);
    if (idx === -1) return null;
    const jsonStr = extractBalancedJson(text, idx) ?? text.substring(idx);
    return this.tryParseKnownToolJson(jsonStr);
  }

  /** Parseia uma string JSON como tool call, exigindo nome de tool conhecida. */
  private tryParseKnownToolJson(jsonStr: string): ParsedToolCall | null {
    let parsed: any;
    try { parsed = robustParseJSON(jsonStr); } catch { return null; }
    const tc = this.parseToolCall(parsed);
    if (!tc) return null;
    const known = this.tools.some((t) => {
      const fn = t?.type === 'function' ? t.function : (t as any)?.function;
      return (fn?.name || (t as any)?.name) === tc.name;
    });
    return known ? tc : null;
  }

  /**
   * Primeiro match de BARE_JSON_RE no buffer que esteja FORA de code fence —
   * `{"name": ...}` dentro de ``` é exemplo de código, não tool call.
   */
  private findBareJsonCandidate(): number {
    let from = 0;
    while (from < this.buffer.length) {
      const m = this.buffer.substring(from).match(BARE_JSON_RE);
      if (!m || m.index === undefined) return -1;
      const idx = from + m.index;
      if (!this.isInsideFence(idx)) return idx;
      from = idx + 1;
    }
    return -1;
  }

  /** Atualiza a paridade de code fence com texto que saiu do buffer. */
  private trackFences(text: string): void {
    if (countFenceTicks(text) % 2 === 1) this.fenceOpen = !this.fenceOpen;
  }

  /** A posição `upTo` do buffer está dentro de um code fence? */
  private isInsideFence(upTo: number): boolean {
    const toggles = countFenceTicks(this.buffer.substring(0, upTo));
    return toggles % 2 === 1 ? !this.fenceOpen : this.fenceOpen;
  }

  getEmittedToolCallCount(): number {
    return this.emittedToolCallCount;
  }

  isInsideTool(): boolean {
    return this.insideTool;
  }

  /**
   * Get any lead-in text that was captured before tool calls.
   * Useful for fallback content when tool calls fail to parse.
   */
  getPendingLeadIn(): string {
    return this.pendingLeadIn;
  }

  // ─── Internal Methods ──────────────────────────────────────────────────────

  private processToolContent(content: string, result: ParserResult): void {
    const t = content.trim();
    if (!t) {
      // Empty tool call - malformed. Restore lead-in if possible.
      logger.warn('[parser] Dropping empty tool call block');
      if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
        result.text += this.pendingLeadIn;
      }
      this.pendingLeadIn = '';
      return;
    }

    // 1) Try Hermes-style XML <parameter> format first
    const xmlParsed = parseXmlParameterToolCall(t, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      result.toolCalls.push({
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      });
      this.emittedToolCallCount++;
      this.pendingLeadIn = '';
      return;
    }

    // 2) Try JSON array format
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        for (const item of arr) {
          const tc = this.parseToolCall(item);
          if (tc) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = '';
        return;
      } catch {
        // Fall through to JSON object parsing
      }
    }

    // 3) Try JSON object format (single or multiple)
    if (t.startsWith('{') || t.includes('"name"')) {
      const tcs = this.parseToolContent(t);
      if (tcs.length > 0) {
        for (const tc of tcs) {
          // Check for tool name from opening tag attribute
          if (!tc.name || tc.name === '') {
            const attrName = extractToolName(this.currentOpenTag, t);
            if (attrName) tc.name = attrName;
          }
          if (tc.name) {
            result.toolCalls.push(tc);
            this.emittedToolCallCount++;
          }
        }
        this.pendingLeadIn = '';
        return;
      }
    }

    // 4) Tool call is malformed and unrecoverable.
    // Never leak internal XML to user-visible content.
    // Restore lead-in text if no tools were emitted.
    logger.warn('[parser] Dropping malformed tool call block', { 
      contentPreview: t.substring(0, 500), 
      hasName: t.includes('"name"') || t.includes('"tool"') || t.includes('tool_name'),
      hasArgs: t.includes('"arguments"') || t.includes('"args"') || t.includes('"parameters"') || t.includes('"input"'),
      first100Chars: t.substring(0, 100)
    });
    if (this.emittedToolCallCount === 0 && this.pendingLeadIn.trim().length > 0) {
      result.text += this.pendingLeadIn;
    }
    this.pendingLeadIn = '';
  }

  private tryRecoverToolCall(block: string): ParsedToolCall | null {
    // Try full parse first
    const xmlParsed = parseXmlParameterToolCall(block, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      return {
        id: `call_${uuidv4()}`,
        name: xmlParsed.name,
        arguments: xmlParsed.arguments,
      };
    }

    // Try recoverable (unclosed parameters)
    const recovered = parseRecoverableXmlToolCall(block, this.currentOpenTag, this.tools);
    if (recovered) {
      return {
        id: `call_${uuidv4()}`,
        name: recovered.name,
        arguments: recovered.arguments,
      };
    }

    // Try JSON (single or multiple)
    const jsonParsed = this.parseToolContent(block);
    if (jsonParsed.length > 0) {
      const first = jsonParsed[0];
      const attrName = extractToolName(this.currentOpenTag, block);
      if (attrName && !first.name) first.name = attrName;
      if (first.name) return first;
    }

    return null;
  }

  private parseToolContent(str: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    
    // Try parsing as single JSON first
    try {
      const parsed = robustParseJSON(str);
      if (parsed && typeof parsed === 'object') {
        const tc = this.parseToolCall(parsed);
        if (tc) calls.push(tc);
      }
    } catch {}
    
    // Always try line-by-line parsing for multi-JSON content (independent of single parse)
    if (str.includes('\n')) {
      const lines = str.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}'));
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') {
            const tc = this.parseToolCall(parsed);
            if (tc && !calls.some(c => c.name === tc.name && JSON.stringify(c.arguments) === JSON.stringify(tc.arguments))) {
              calls.push(tc);
            }
          }
        } catch {}
      }
    }
    
    return calls;
  }

  private parseToolCall(parsed: any): ParsedToolCall | null {
    if (!parsed || typeof parsed !== 'object') return null;
    
    const name = parsed.name || parsed.function?.name || parsed.tool_name || parsed.tool;
    if (!name || typeof name !== 'string' || name.length === 0) return null;
    
    let args = parsed.arguments || parsed.function?.arguments || parsed.args || parsed.parameters || parsed.input || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); }
      catch { args = {}; }
    }
    if (typeof args !== 'object' || args === null) args = {};

    return {
      id: parsed.id || parsed.tool_call_id || `call_${uuidv4()}`,
      name,
      arguments: args,
    };
  }
}
