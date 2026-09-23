/*
 * File: chat.ts
 * Project: minimaxproxy
 *
 * Endpoint OpenAI-compatível. Constrói um prompt único a partir das mensagens,
 * dispara a bridge (createMinimaxStream) e converte o SSE do MiniMax
 * (linhas `data:{...}` com type 6 = chunk, type 2 = msg completa) para o
 * formato OpenAI (streaming e non-streaming). Mantém rotação de contas, mutex
 * por conta e parsing de tool-calls via prompt.
 */
import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createMinimaxStream } from '../services/minimax.ts';
import { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableMinimaxStreamError } from '../services/minimax.ts';
import { Mutex, MinimaxSessionError } from '../services/playwright.ts';
import { getModelContextWindow } from '../core/model-registry.js';
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { metrics } from '../core/metrics.js';

const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

// ---------------------------------------------------------------------------
// Parser do SSE do MiniMax
// ---------------------------------------------------------------------------
interface MinimaxDelta {
  reasoning?: string;
  content?: string;
  finish?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: string;
}

/** Converte uma linha do SSE do MiniMax num delta normalizado (ou null). */
function parseMinimaxLine(line: string): MinimaxDelta | null {
  const t = line.trim();
  if (!t) return null;
  // erros vêm como JSON cru (sem prefixo data:), ex: {"error":"invalid signature"}
  let jsonStr: string;
  if (t.startsWith('data:')) {
    jsonStr = t.slice(5).trim();
  } else if (t.startsWith('{')) {
    jsonStr = t;
  } else {
    return null;
  }
  if (jsonStr === '[DONE]') return null;

  let obj: any;
  try { obj = JSON.parse(jsonStr); } catch { return null; }

  if (obj.error) return { error: typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error) };
  if (obj.base_resp && obj.base_resp.status_code && obj.base_resp.status_code !== 0) {
    return { error: obj.base_resp.status_msg || `status_code ${obj.base_resp.status_code}` };
  }

  // type 6 = chunk incremental
  if (obj.type === 6 && obj.agent_message_chunk) {
    const ch = obj.agent_message_chunk;
    const d: MinimaxDelta = {};
    if (typeof ch.thinking_content === 'string') d.reasoning = ch.thinking_content;
    if (typeof ch.msg_content === 'string') d.content = ch.msg_content;
    if (ch.finish === true) d.finish = ch.finish_reason || 'stop';
    return Object.keys(d).length ? d : null;
  }

  // type 2 = mensagem completa (pega usage da final do assistant)
  if (obj.type === 2 && obj.agent_message && obj.agent_message.role === 'assistant') {
    const u = obj.agent_message.usage;
    if (u) return { usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Construção do prompt a partir das mensagens OpenAI
// ---------------------------------------------------------------------------
function buildPromptParts(body: OpenAIRequest): { systemPrompt: string; prompt: string; toolDirective: string } {
  const messages = body.messages || [];
  let prompt = '';
  let systemPrompt = '';
  let toolDirective = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let contentStr = '';
    if (Array.isArray(msg.content)) {
      contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      contentStr = JSON.stringify(msg.content);
    } else {
      contentStr = msg.content || '';
    }

    if (msg.role === 'system') {
      systemPrompt += (contentStr || '') + '\n\n';
    } else if (msg.role === 'user') {
      prompt += `User: ${contentStr || ''}\n\n`;
    } else if (msg.role === 'assistant') {
      let assistantContent = contentStr || '';
      const reasoning = (msg as any).reasoning_content;
      if (reasoning) assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const args = tc.function?.arguments;
          let parsedArgs: any = {};
          if (typeof args === 'string') { try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; } }
          else if (args && typeof args === 'object') parsedArgs = args;
          const payload = { name: tc.function?.name, arguments: parsedArgs };
          const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
          assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
        }
      }
      prompt += `Assistant: ${assistantContent.trim()}\n\n`;
    } else if (msg.role === 'tool' || msg.role === 'function') {
      let toolName = msg.name;
      if (!toolName && msg.tool_call_id) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsg = messages[j];
          if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
            const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
            if (call) { toolName = call.function?.name; break; }
          }
        }
      }
      prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
    }
  }

  // injeta instruções de tools (mesmo esquema dos outros portes)
  const bodyAny = body as any;
  if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
    const formattedTools = bodyAny.tools.map((t: any) =>
      t.type === 'function'
        ? { name: t.function.name, description: t.function.description || '', parameters: t.function.parameters }
        : t,
    );
    const toolsJson = JSON.stringify(formattedTools, null, 2);
    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text after your <tool_call> blocks.\n4. The JSON inside the tags MUST be valid.\n\n`;
    if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
      systemPrompt += `CRITICAL: You MUST call the tool "${bodyAny.tool_choice.function.name}" in this response.\n\n`;
    }

    // O harness agêntico do MiniMax descarta instruções vindas do `system` (validado E2E:
    // a mesma diretiva falha no system e funciona no turno do user). Por isso repetimos a
    // ordem de tool-calling COMO INSTRUÇÃO DO USER, anexada ao FIM do prompt — é o que faz
    // o modelo emitir <tool_call> em vez de responder direto / usar seu workspace interno.
    toolDirective =
      `[INSTRUCTION TO YOU, THE ASSISTANT] You cannot see the user's files or environment yourself; ` +
      `any internal workspace you have is empty and irrelevant — ignore it. To read or act on anything ` +
      `you MUST first emit a tool call and NOTHING else, using EXACTLY the <tool_call> format and the tools ` +
      `defined above, then stop and wait for the Tool Response. Do not answer from memory. Do not claim a ` +
      `file or resource is missing without calling the appropriate tool first. Pass paths and arguments ` +
      `EXACTLY as the user refers to them (e.g. relative paths like "package.json" or "src/index.ts"); ` +
      `NEVER prefix a path with "/workspace" or any sandbox/absolute path of your own.`;
    if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
      toolDirective += ` You MUST call the tool "${bodyAny.tool_choice.function.name}" right now.`;
    }
  }

  return { systemPrompt, prompt, toolDirective };
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const bodyAny = body as any;

    const { systemPrompt, prompt, toolDirective } = buildPromptParts(body);

    const modelId = (body.model || 'MiniMax-M3').replace('-no-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId);
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(body.messages || [], modelContextWindow, systemPrompt);
      finalPrompt = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    // Diretiva de tool-calling sempre por ÚLTIMO, como turno do user (o harness do MiniMax
    // obedece o fim/user e ignora o system). Mantida mesmo no ramo truncado.
    if (toolDirective) finalPrompt = `${finalPrompt.trimEnd()}\n\n${toolDirective}`;

    // Rotação de contas com fallback
    let account = getNextAccount();
    const triedAccountIds = new Set<string>();
    let lastError: any = null;
    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    let releaseChatLock: (() => void) | undefined;
    const completionId = 'chatcmpl-' + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;
      if (triedAccountIds.has(accountId)) { account = getNextAvailableAccount(accountId); continue; }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        console.log(`[Chat] Pulando conta ${accountEmail} (cooldown ${Math.round(cooldownInfo.remainingMs / 1000)}s)`);
        account = getNextAvailableAccount(accountId); continue;
      }
      if (cooldownInfo && accountId === 'global' && cooldownInfo.reason === 'SessionExpired') {
        // Sessão do perfil global expirada e o re-seed acabou de falhar: falhar
        // rápido com instrução clara, em vez de repetir navegação + re-seed
        // (~30-60s) a cada request só para falhar de novo.
        const e: any = new Error(
          `MiniMax: sessão expirada — re-login manual necessário (npm run login:manual + npm run session:export). ` +
          `Nova tentativa automática em ${Math.ceil(cooldownInfo.remainingMs / 1000)}s.`,
        );
        e.upstreamStatus = 503;
        throw e;
      }

      console.log(`[Chat] Roteando para conta: ${accountEmail} (${accountId})`);
      const accountMutex = getAccountMutex(accountId);
      releaseChatLock = await accountMutex.acquire();

      let success = false;
      try {
        const result = await createMinimaxStream(
          finalPrompt, undefined, body.model, undefined,
          accountId === 'global' ? undefined : accountId,
        );
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        registerStream(completionId, {
          abortController: result.controller,
          accountId: result.accountId,
          uiSessionId: result.uiSessionId,
          targetResponseId: '',
          headers: result.headers,
        });
        success = true;
      } catch (err: any) {
        lastError = err;
        if (err instanceof MinimaxSessionError) {
          // Sessão expirada/deslogada e o re-seed runtime falhou: cooldown p/ não
          // martelar a conta (precisa de re-login manual) e rotaciona. No modo
          // global o cooldown é curto (2min) p/ captar logo um novo
          // minimax_session.json exportado; contas nomeadas têm rotação, 10min.
          const cooldownMs = accountId === 'global' ? 2 * 60 * 1000 : 10 * 60 * 1000;
          markAccountRateLimited(accountId, cooldownMs, 'SessionExpired');
          console.warn(`[Chat] Conta ${accountEmail} sem sessão; cooldown ${Math.round(cooldownMs / 60000)}min e rotacionando.`);
        } else if (err instanceof RetryableMinimaxStreamError) {
          await new Promise(r => setTimeout(r, err.retryAfterMs));
        }
        releaseChatLock?.(); releaseChatLock = undefined;
        account = getNextAvailableAccount(accountId);
        continue;
      }
      if (success) break;
    }

    if (!stream) {
      removeStream(completionId);
      throw lastError || new Error('Nenhuma conta disponível / falha ao iniciar a bridge');
    }

    const toolsActive = !!(bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0);

    // ----------------------- NON-STREAMING -----------------------
    if (!isStream) {
      try {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let reasoningBuffer = '';
        let lastContent = '';
        let finishReason = 'stop';
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);
        let completionTokens = 0;
        let upstreamError: string | null = null;
        const toolParser = new StreamingToolParser(bodyAny.tools || []);
        const toolCallsOut: any[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const d = parseMinimaxLine(line);
            if (!d) continue;
            if (d.error) { upstreamError = d.error; continue; }
            if (d.usage) {
              if (d.usage.input_tokens) promptTokens = d.usage.input_tokens;
              if (d.usage.output_tokens) completionTokens = d.usage.output_tokens;
            }
            if (d.reasoning) reasoningBuffer += d.reasoning;
            if (d.content) {
              if (toolsActive) {
                // O parser separa texto de tool-calls: o texto precisa ser
                // preservado (resposta sem tool-call não pode voltar vazia).
                const { text, toolCalls } = toolParser.feed(d.content);
                if (text) lastContent += text;
                for (const tc of toolCalls) toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } });
              } else {
                lastContent += d.content;
              }
            }
            if (d.finish) finishReason = d.finish;
          }
        }
        // processa resto do buffer
        const dLast = parseMinimaxLine(buffer);
        if (dLast?.error) upstreamError = dLast.error;

        if (upstreamError) {
          return c.json({ error: { message: `MiniMax: ${upstreamError}` } }, 502 as any);
        }

        if (toolsActive) {
          const { text: remText, toolCalls: rem } = toolParser.flush();
          if (remText) lastContent += remText;
          for (const tc of rem) toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } });
        }

        const usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          prompt_tokens_details: { cached_tokens: 0 },
        };
        const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastContent };
        if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
        if (toolCallsOut.length) { toolCallsOut.forEach((tc, idx) => tc.index = idx); message.tool_calls = toolCallsOut; }

        return c.json({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message, logprobs: null, finish_reason: toolCallsOut.length ? 'tool_calls' : finishReason }],
          usage,
        });
      } finally {
        removeStream(completionId);
        releaseChatLock?.();
      }
    }

    // ------------------------- STREAMING -------------------------
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (sw: any) => {
      let heartbeat: any;
      try {
        await sw.write(': heartbeat\n\n');
        heartbeat = setInterval(async () => { try { await sw.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); } }, 15000);

        const writeEvent = async (data: any) => { await sw.write(`data: ${JSON.stringify(data)}\n\n`); };
        const makeChoice = (delta: any, finishReason: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finishReason });

        await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ role: 'assistant', content: '' })] });

        const reader = stream!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finishReason = 'stop';
        let promptTokens = Math.ceil(finalPrompt.length / 3.5);
        let completionTokens = 0;
        let upstreamError: string | null = null;
        const toolParser = new StreamingToolParser(bodyAny.tools || []);

        const handle = async (d: MinimaxDelta) => {
          if (d.error) { upstreamError = d.error; return; }
          if (d.usage) {
            if (d.usage.input_tokens) promptTokens = d.usage.input_tokens;
            if (d.usage.output_tokens) completionTokens = d.usage.output_tokens;
          }
          if (d.reasoning) {
            await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ reasoning_content: d.reasoning })] });
          }
          if (d.content) {
            if (toolsActive) {
              const { text, toolCalls } = toolParser.feed(d.content);
              if (text) await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: text })] });
              for (const tc of toolCalls) {
                await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - 1, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })] });
              }
            } else {
              await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: d.content })] });
            }
          }
          if (d.finish) finishReason = d.finish;
        };

        // Se a bridge errar no meio do stream (timeout sem dados, aba morta),
        // NÃO deixamos a exceção subir — isso cortaria a conexão SSE sem
        // finish_reason nem [DONE] e o cliente ficaria pendurado/em retry.
        // Capturamos e terminamos o SSE limpo com um chunk de erro.
        let readError: string | null = null;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const d = parseMinimaxLine(line);
              if (d) await handle(d);
            }
          }
          const dLast = parseMinimaxLine(buffer);
          if (dLast) await handle(dLast);
        } catch (err: any) {
          console.error('[Chat] Stream interrompido pela bridge:', err?.message || err);
          readError = err?.message || String(err);
        }

        if (toolsActive) {
          const { text, toolCalls } = toolParser.flush();
          if (text) await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: text })] });
          for (const tc of toolCalls) {
            await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ tool_calls: [{ index: toolParser.getEmittedToolCallCount() - 1, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })] });
          }
        }

        if (upstreamError || readError) {
          await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: `\n[MiniMax erro: ${upstreamError || readError}]` })] });
        }

        const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } };
        const finalFinish = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : finishReason;
        await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({}, finalFinish)], ...(body.stream_options?.include_usage ? {} : { usage }) });
        if (body.stream_options?.include_usage) {
          await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [], usage });
        }
        await sw.write('data: [DONE]\n\n');
      } finally {
        clearInterval(heartbeat);
        removeStream(completionId);
        releaseChatLock?.();
      }
    });
  } catch (err: any) {
    console.error('Erro em chatCompletions:', err);
    const status = err.upstreamStatus || 500;
    if (status >= 500) metrics.increment('requests.errors');
    return c.json({ error: { message: err.message } }, status);
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id } = body;
    if (!chat_id) return c.json({ error: 'chat_id is required' }, 400);
    const s = getStream(chat_id);
    if (!s) return c.json({ error: 'Stream not found' }, 404);
    s.abortController.abort();
    removeStream(chat_id);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
}
