/*
 * File: parser.ts
 * Project: deepseekproxy
 * Streaming parser for tool calls - OpenAI Compatible
 *
 * Formatos suportados (do instruído ao improvisado — ver pesquisa em issues
 * do vLLM/Cline/RooCode/sglang e templates oficiais da HF):
 *   1. <tool_call>{"name":...,"arguments":...}</tool_call>   (formato injetado pelo nosso prompt)
 *   2. <tool_call_block>, <invoke name="x"> + <parameter>     (wrappers vistos em outros modelos)
 *   3. Tokens NATIVOS do template DeepSeek V3/R1 e V3.1:
 *        <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>nome
 *        ```json
 *        {args}
 *        ```
 *        <｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *      (V3.1: nome<｜tool▁sep｜>{args} sem fence). Caracteres especiais:
 *      ｜ = U+FF5C (fullwidth bar), ▁ = U+2581 (lower one eighth block).
 *   4. DSML (geração atual do chat.deepseek.com):
 *        <｜DSML｜function_calls><｜DSML｜invoke name="x">
 *        <｜DSML｜parameter name="p" string="true">valor</｜DSML｜parameter>...
 *      e a variante degradada sem prefixo: <function_calls><invoke name="x">...
 *   5. JSON cru/fenced sem tags ({"name":...,"arguments":...}) — só com tools
 *      ativas e nome conhecido (evita falso positivo em JSON normal).
 *   6. Narração "[调用 X]" / "[Calling tool X]" — último recurso, só com nome
 *      de tool conhecido.
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

// ─── Open/close tags ───────────────────────────────────────────────────────────

// Tokens nativos do DeepSeek (caracteres exatos: ｜ U+FF5C, ▁ U+2581).
const DS_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const DS_CALLS_END = '<｜tool▁calls▁end｜>';
const DS_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const DS_CALL_END = '<｜tool▁call▁end｜>';
const DS_SEP = '<｜tool▁sep｜>';

type OpenerKind = 'generic' | 'native' | 'invoke-block';

// Múltiplos formatos de "open tag", do mais específico ao genérico.
// O `\b` garante que <tool_call> NÃO casa dentro de <tool_call_block>.
// `close` em minúsculas: a busca é feita sobre o buffer lowercased.
const TOOL_OPENERS: ReadonlyArray<{ re: RegExp; close: string; kind: OpenerKind }> = [
  { re: /<｜tool▁calls▁begin｜>/, close: DS_CALLS_END.toLowerCase(), kind: 'native' },
  { re: /<｜tool▁call▁begin｜>/, close: DS_CALL_END.toLowerCase(), kind: 'native' },
  { re: /<｜DSML｜function_calls>/i, close: '</｜dsml｜function_calls>', kind: 'invoke-block' },
  { re: /<｜DSML｜invoke\b[^>]*>/i, close: '</｜dsml｜invoke>', kind: 'generic' },
  { re: /<function_calls>/i, close: '</function_calls>', kind: 'invoke-block' },
  { re: /<tool_call_block\b[^>]*>/i, close: '</tool_call_block>', kind: 'generic' },
  { re: /<tool_call\b[^>]*>/i, close: '</tool_call>', kind: 'generic' },
  { re: /<invoke\b[^>]*>/i, close: '</invoke>', kind: 'generic' },
];
const TOOL_START_LITERAL = '<tool_call>';
const DEFAULT_TOOL_END = '</tool_call>';

interface OpenerMatch { index: number; openTag: string; close: string; kind: OpenerKind }

/** Acha o open tag de tool-call mais à esquerda no buffer, entre todos os formatos. */
function findOpener(buffer: string): OpenerMatch | null {
  let best: OpenerMatch | null = null;
  for (const o of TOOL_OPENERS) {
    const m = buffer.match(o.re);
    if (m && m.index !== undefined && (best === null || m.index < best.index)) {
      best = { index: m.index, openTag: m[0], close: o.close, kind: o.kind };
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
  // Lê name="..." de <tool_call>, <invoke>, <｜DSML｜invoke> ou <function>.
  const attrMatch = combined.match(/<(?:｜DSML｜)?(?:tool_call|invoke|function)\b[^>]*\bname\s*=\s*["']([^"']+)["']/i);
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

// <parameter name="x">v</parameter> — com ou sem prefixo ｜DSML｜. O atributo
// string="true|false" do DSML decide se o valor é string crua ou JSON tipado.
const PARAMETER_RE = /<(?:｜DSML｜)?parameter\b([^>]*)\bname\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/(?:｜DSML｜)?parameter>/gi;

function parameterValue(attrsBefore: string, attrsAfter: string, raw: string): unknown {
  const attrs = `${attrsBefore} ${attrsAfter}`;
  const stringAttr = attrs.match(/\bstring\s*=\s*["'](true|false)["']/i);
  if (stringAttr) {
    const decoded = decodeXmlEntities(raw.trim());
    if (stringAttr[1].toLowerCase() === 'true') return decoded;
    try { return JSON.parse(decoded); } catch { return coerceParameterValue(raw); }
  }
  return coerceParameterValue(raw);
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
  const parameterRe = new RegExp(PARAMETER_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = parameterRe.exec(block)) !== null) {
    args[match[2]] = parameterValue(match[1], match[3], match[4]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Try to recover a tool call from a block that may have unclosed <parameter> tags
 * (e.g. stream was cut off before </parameter> or the close tag).
 */
function parseRecoverableXmlToolCall(
  block: string,
  openTag: string,
  tools: FunctionToolDefinition[]
): { name: string; arguments: Record<string, unknown> } | null {
  const args: Record<string, unknown> = {};

  // First, extract all properly closed parameters
  const closedParameterRe = new RegExp(PARAMETER_RE.source, 'gi');
  let match: RegExpExecArray | null;
  let lastClosedEnd = 0;
  while ((match = closedParameterRe.exec(block)) !== null) {
    args[match[2]] = parameterValue(match[1], match[3], match[4]);
    lastClosedEnd = closedParameterRe.lastIndex;
  }

  // Then look for an unclosed parameter at the tail
  const tail = block.substring(lastClosedEnd);
  const unclosedMatch = tail.match(/<(?:｜DSML｜)?parameter\b([^>]*)\bname\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*)$/i);
  if (unclosedMatch) {
    args[unclosedMatch[2]] = parameterValue(unclosedMatch[1], unclosedMatch[3], unclosedMatch[4]);
  }

  if (Object.keys(args).length === 0) return null;

  const toolName = extractToolName(openTag, block) || inferToolNameFromParameters(args, tools);
  if (!toolName) return null;

  return { name: toolName, arguments: args };
}

/**
 * Bloco com MÚLTIPLOS <invoke name="x">...</invoke> (com ou sem ｜DSML｜),
 * como dentro de <function_calls> / <｜DSML｜function_calls>.
 */
function parseInvokeBlocks(block: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const out: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const invokeRe = /<(?:｜DSML｜)?invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/(?:｜DSML｜)?invoke>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(block)) !== null) {
    const name = m[1];
    const inner = m[2];
    const args: Record<string, unknown> = {};
    const parameterRe = new RegExp(PARAMETER_RE.source, 'gi');
    let pm: RegExpExecArray | null;
    while ((pm = parameterRe.exec(inner)) !== null) {
      args[pm[2]] = parameterValue(pm[1], pm[3], pm[4]);
    }
    if (name) out.push({ name, arguments: args });
  }
  return out;
}

/** Remove um code fence ```json ... ``` (ou ``` simples) ao redor do texto. */
function stripCodeFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/**
 * Segmentos no formato NATIVO do template DeepSeek:
 *   V3/R1: function<｜tool▁sep｜>nome\n```json\n{args}\n```
 *   V3.1:  nome<｜tool▁sep｜>{args}
 * `block` é o conteúdo entre os tokens begin/end (pode conter vários
 * <｜tool▁call▁begin｜>...<｜tool▁call▁end｜> quando o opener foi o wrapper).
 */
function parseNativeToolCalls(block: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const out: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // Wrapper: extrai cada segmento call▁begin..call▁end; senão o bloco inteiro é um segmento.
  const segments: string[] = [];
  if (block.includes(DS_CALL_BEGIN)) {
    const re = /<｜tool▁call▁begin｜>([\s\S]*?)(?:<｜tool▁call▁end｜>|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) segments.push(m[1]);
  } else {
    segments.push(block);
  }

  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue;
    const sepIdx = s.indexOf(DS_SEP);
    let name = '';
    let argsStr = '';
    if (sepIdx !== -1) {
      const left = s.slice(0, sepIdx).trim();
      const right = s.slice(sepIdx + DS_SEP.length).trim();
      if (/^(function|tool)$/i.test(left)) {
        // V3: o nome vem DEPOIS do sep, na primeira linha; args no fence.
        const nl = right.search(/[\r\n]/);
        name = (nl === -1 ? right : right.slice(0, nl)).trim();
        argsStr = nl === -1 ? '' : right.slice(nl);
      } else {
        // V3.1: nome antes do sep, args crus depois.
        name = left;
        argsStr = right;
      }
    } else {
      continue;
    }

    if (!name || !/^[\w.\-]+$/.test(name)) continue;
    let args: Record<string, unknown> = {};
    const cleaned = stripCodeFence(argsStr);
    if (cleaned) {
      try {
        const parsed = robustParseJSON(cleaned);
        if (parsed && typeof parsed === 'object') args = parsed;
      } catch { /* args ilegíveis: emite com {} em vez de descartar a call */ }
    }
    out.push({ name, arguments: args });
  }
  return out;
}

// ─── Partial Tag Detection ─────────────────────────────────────────────────────

// Prefixos de open tags que devemos segurar se chegarem partidos no fim do
// chunk (em minúsculas: a comparação é sobre o buffer lowercased).
const PARTIAL_LITERALS = [
  DS_CALLS_BEGIN.toLowerCase(),
  DS_CALL_BEGIN.toLowerCase(),
  '<｜dsml｜function_calls',
  '<｜dsml｜invoke',
  '<function_calls',
  '<tool_call_block',
  '<tool_call',
  '<invoke',
];

function findPartialToolOpenIndex(buffer: string): number {
  const lower = buffer.toLowerCase();
  let best = -1;
  const consider = (idx: number) => { if (idx !== -1 && (best === -1 || idx < best)) best = idx; };

  for (const lit of PARTIAL_LITERALS) {
    // Open tag começado mas sem o `>` de fechamento (ainda chegando).
    const idx = lower.lastIndexOf(lit);
    if (idx !== -1 && lower.indexOf('>', idx) === -1) consider(idx);
    // Prefixo parcial no fim do buffer (ex.: `<tool`, `<inv`, `<｜dsml`).
    for (let i = 1; i < lit.length; i++) {
      if (lower.endsWith(lit.substring(0, i))) consider(buffer.length - i);
    }
  }
  return best;
}

// ─── Bare-JSON tool call (sem tags) ──────────────────────────────────────────────
// O DeepSeek às vezes emite o JSON do tool-call SEM wrapper (cru ou num fence
// ```json). Recuperamos de forma conservadora: só com tools ativas e nome
// casando com uma tool conhecida (evita falso-positivo em JSON normal).

const BARE_JSON_RE = /\{\s*"(?:name|tool|tool_name|function)"\s*:/;

function findBareToolJsonIndex(buffer: string): number {
  const m = buffer.match(BARE_JSON_RE);
  return m && m.index !== undefined ? m.index : -1;
}

/**
 * Índice de um objeto JSON ainda ABERTO no fim do buffer (último `{` sem `}`
 * depois dele). Evita que um `{` no limite do chunk vaze como texto e quebre a
 * detecção de bare-JSON na próxima chamada. O conteúdo retido é validado no flush.
 */
function findOpenBraceIndex(buffer: string): number {
  const lastOpen = buffer.lastIndexOf('{');
  if (lastOpen === -1) return -1;
  if (buffer.indexOf('}', lastOpen) !== -1) return -1; // já fechou neste buffer
  return lastOpen;
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

// ─── Narração "[调用 X]" / "[Calling tool X]" ───────────────────────────────────
// Quando o modelo abandona o formato instruído ele às vezes NARRA a chamada.
// Recuperação de último recurso (flush), só com nome de tool conhecido.

const NARRATION_RE = /[\[【]\s*(?:调用工具|调用|Calling(?:\s+(?:the\s+)?tool)?|Call(?:ing)?\s+function)\s*[:：]?\s*([A-Za-z_][\w.\-]*)\s*[\]】]?/;
// Versão "começo de narração" para segurar o texto no fim do chunk até o flush.
const NARRATION_HOLD_RE = /[\[【]\s*(?:调用|Calling\b|Call\s+function)/;

// ─── StreamingToolParser ───────────────────────────────────────────────────────

export class StreamingToolParser {
  private buffer = '';
  private insideTool = false;
  private currentOpenTag = TOOL_START_LITERAL;
  private currentClose = DEFAULT_TOOL_END;
  private currentKind: OpenerKind = 'generic';
  private emittedToolCallCount = 0;
  private pendingLeadIn = '';
  private tools: FunctionToolDefinition[] = [];

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
          this.pendingLeadIn += textBefore;
          this.insideTool = true;
          this.currentOpenTag = match.openTag;
          this.currentClose = match.close;
          this.currentKind = match.kind;
          this.buffer = this.buffer.substring(match.index + match.openTag.length);
          continue;
        } else {
          // No full open tag found. Segura: (a) tag parcial no fim, (b) início
          // de possível tool-call em JSON cru (só validável quando fechar) e
          // (c) início de narração "[调用 X]" — tudo validado no flush.
          const partialIdx = findPartialToolOpenIndex(this.buffer);
          let holdIdx = partialIdx;
          if (this.tools.length > 0 && this.emittedToolCallCount === 0) {
            const bj = findBareToolJsonIndex(this.buffer);
            if (bj !== -1 && (holdIdx === -1 || bj < holdIdx)) holdIdx = bj;
            const ob = findOpenBraceIndex(this.buffer);
            if (ob !== -1 && (holdIdx === -1 || ob < holdIdx)) holdIdx = ob;
            const nr = this.buffer.search(NARRATION_HOLD_RE);
            if (nr !== -1 && (holdIdx === -1 || nr < holdIdx)) holdIdx = nr;
          }
          const flushIndex = holdIdx === -1 ? this.buffer.length : holdIdx;
          if (flushIndex > 0) {
            const textToEmit = this.buffer.substring(0, flushIndex);
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
          this.resetTagState();
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
      // Stream ended with unclosed tool call. Try to recover.
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
      if (this.emittedToolCallCount === 0) {
        // Últimas tentativas: tool-call em JSON cru sem tags, depois narração.
        const bare = this.tools.length > 0 ? this.tryParseBareToolJson(this.buffer) : null;
        const narrated = bare ? null : (this.tools.length > 0 ? this.tryParseNarration(this.buffer) : null);
        const recovered = bare || narrated;
        if (recovered) {
          result.toolCalls.push(recovered);
          this.emittedToolCallCount++;
          this.pendingLeadIn = '';
        } else {
          result.text += this.buffer;
        }
      }
    }

    this.buffer = '';
    this.resetTagState();
    return result;
  }

  private resetTagState(): void {
    this.insideTool = false;
    this.currentOpenTag = TOOL_START_LITERAL;
    this.currentClose = DEFAULT_TOOL_END;
    this.currentKind = 'generic';
  }

  private isKnownTool(name: string): boolean {
    return this.tools.some((t) => {
      const fn = t?.type === 'function' ? t.function : (t as any)?.function;
      return (fn?.name || (t as any)?.name) === name;
    });
  }

  /**
   * Recupera um tool-call em JSON cru (sem tags) do texto. Conservador:
   * só retorna se o nome casar com uma tool conhecida, evitando falso-positivo
   * quando o assistente legitimamente escreve um objeto JSON na resposta.
   */
  private tryParseBareToolJson(text: string): ParsedToolCall | null {
    const idx = text.search(BARE_JSON_RE);
    if (idx === -1) return null;
    const jsonStr = extractBalancedJson(text, idx);
    if (!jsonStr) return null;
    let parsed: any;
    try { parsed = robustParseJSON(jsonStr); } catch { return null; }
    const tc = this.parseToolCall(parsed);
    if (!tc) return null;
    return this.isKnownTool(tc.name) ? tc : null;
  }

  /**
   * Recupera narração tipo "[调用 read_file] {...}" / "[Calling tool X]".
   * Conservador: só com nome de tool conhecido; args = primeiro JSON balanceado
   * após a narração, se houver.
   */
  private tryParseNarration(text: string): ParsedToolCall | null {
    const m = text.match(NARRATION_RE);
    if (!m || m.index === undefined) return null;
    const name = m[1];
    if (!this.isKnownTool(name)) return null;

    let args: Record<string, unknown> = {};
    const after = text.slice(m.index + m[0].length);
    const braceIdx = after.indexOf('{');
    if (braceIdx !== -1) {
      const jsonStr = extractBalancedJson(after, braceIdx);
      if (jsonStr) {
        try {
          const parsed = robustParseJSON(jsonStr);
          if (parsed && typeof parsed === 'object') args = parsed;
        } catch { /* sem args legíveis */ }
      }
    }
    logger.warn('[parser] Tool call recuperado de narração não-padrão', { name, preview: m[0] });
    return { id: `call_${uuidv4()}`, name, arguments: args };
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

  private pushCall(result: ParserResult, call: { name: string; arguments: Record<string, unknown> }): void {
    result.toolCalls.push({
      id: `call_${uuidv4()}`,
      name: call.name,
      arguments: call.arguments,
    });
    this.emittedToolCallCount++;
  }

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

    // 0a) Tokens nativos do template DeepSeek (V3 e V3.1).
    if (this.currentKind === 'native') {
      const native = parseNativeToolCalls(t);
      if (native.length > 0) {
        for (const call of native) this.pushCall(result, call);
        this.pendingLeadIn = '';
        return;
      }
      // cai para as tentativas genéricas abaixo
    }

    // 0b) Bloco com múltiplos <invoke> (DSML ou <function_calls> degradado).
    if (this.currentKind === 'invoke-block') {
      const invokes = parseInvokeBlocks(t);
      if (invokes.length > 0) {
        for (const call of invokes) this.pushCall(result, call);
        this.pendingLeadIn = '';
        return;
      }
      // cai para as tentativas genéricas abaixo
    }

    // 1) Try Hermes-style XML <parameter> format first
    const xmlParsed = parseXmlParameterToolCall(t, this.currentOpenTag, this.tools);
    if (xmlParsed) {
      this.pushCall(result, xmlParsed);
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
    if (t.startsWith('{') || t.includes('"name"') || t.startsWith('```')) {
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
    // Native token segments (stream cortado antes do tool▁call(s)▁end).
    if (this.currentKind === 'native') {
      const native = parseNativeToolCalls(block);
      if (native.length > 0) {
        return { id: `call_${uuidv4()}`, name: native[0].name, arguments: native[0].arguments };
      }
    }
    if (this.currentKind === 'invoke-block') {
      const invokes = parseInvokeBlocks(block);
      if (invokes.length > 0) {
        return { id: `call_${uuidv4()}`, name: invokes[0].name, arguments: invokes[0].arguments };
      }
    }

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
