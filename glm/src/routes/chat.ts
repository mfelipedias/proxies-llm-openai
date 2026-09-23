/*
 * File: chat.ts
 * Project: glmproxy
 *
 * Handler OpenAI-compatível de /v1/chat/completions.
 *
 * A construção do prompt, rotação de contas, tool-calling e o envelope de
 * resposta OpenAI são reaproveitados do Qwen/DeepSeek. O PARSING do stream SSE
 * é específico do GLM (z.ai) e fica isolado em services/glm-stream.ts.
 *
 * >>> TODO: o formato exato do SSE do z.ai precisa de confirmação ao vivo
 * >>> (src/validate.ts). Veja PLAN.md, seção "Parser de streaming".
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createGLMStream } from '../services/glm.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { GLMStreamParser } from '../services/glm-stream.ts';
import { RetryableGLMStreamError } from '../services/glm.ts';
import { Mutex } from '../services/playwright.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateSerializedHistory, estimateTokenCount, type PromptSegment } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { metrics } from '../core/metrics.js'

const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

export interface DeltaResult {
  delta: string;
  matchedContent: string;
}

export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr };
  }

  // Heuristic to detect if newStr is cumulative or incremental:
  // If newStr is cumulative, it should share a common prefix with oldStr.
  // Limit scan window to avoid O(n) on very long cumulative content
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  while (commonPrefixLen < maxLen && oldStr[commonPrefixLen] === newStr[commonPrefixLen]) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return {
      delta: newStr.substring(commonPrefixLen),
      matchedContent: newStr
    };
  }

  // If the prefix check fails, we treat it as strictly incremental (or pure delta).
  return {
    delta: newStr,
    matchedContent: oldStr + newStr
  };
}


export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;

    // Extract the prompt (um segmento serializado por mensagem, para o
    // truncamento poder descartar turnos inteiros preservando o system prompt)
    const segments: PromptSegment[] = [];
    const messages = body.messages || [];
    let systemPrompt = '';

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
        segments.push({ role: 'user', text: `User: ${contentStr || ''}\n\n` });
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        segments.push({ role: 'assistant', text: `Assistant: ${assistantContent.trim()}\n\n` });
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          // Look up tool name in history by tool_call_id
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        segments.push({ role: 'tool', text: `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n` });
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);

      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n\n`;

      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const modelId = body.model.replace('-no-thinking', '');
    const modelContextWindow = getModelContextWindow(modelId)
    const prompt = segments.map(s => s.text).join('');
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      // Descarta os turnos mais antigos por inteiro, preservando o system
      // prompt (que carrega as instruções de tool calling) e o turno atual.
      finalPrompt = truncateSerializedHistory(systemPrompt, segments, modelContextWindow);
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    // O thinking é ligado por padrão (modelos GLM raciocinam); `-no-thinking`
    // força desligado. Veja features.enable_thinking em glm.ts.
    const isThinkingModel = !body.model.includes('no-thinking');

    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    // Próxima conta AINDA NÃO TENTADA nesta request. Sem esse filtro, quando
    // todas falham sem cooldown o rodízio devolve contas já tentadas em
    // ping-pong SÍNCRONO infinito — congelando o event loop (e o proxy todo).
    const pickNextAccount = (skipId: string) => {
      const next = getNextAvailableAccount(skipId);
      if (!next || triedAccountIds.has(next.id)) return null;
      return next;
    };

    let stream: ReadableStream | undefined;
    let upstreamAbort: AbortController | undefined;
    let uiSessionId = '';
    let releaseChatLock: (() => void) | undefined;
    const completionId = 'chatcmpl-' + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = pickNextAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
        account = pickNextAccount(accountId);
        continue;
      }

      console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);

    const accountMutex = getAccountMutex(accountId);
    releaseChatLock = await accountMutex.acquire();

    let success = false;
    try {
        let retries = 3;
        let retryDelay = 500;
        success = false;

        while (retries > 0) {
          try {
            const result = await createGLMStream(
              finalPrompt,
              isThinkingModel,
              body.model,
              accountId === 'global' ? undefined : accountId
            );
            stream = result.stream;
            upstreamAbort = result.controller;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId,
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
            success = true;
            break;
          } catch (err: any) {
            retries--;

            if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
              const hourHint = err.message?.match(/Wait about (\d+) hour/);
              const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
              markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
              console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Marked for cooldown.`);
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            if (retries === 0) {
              if (err.upstreamStatus && err.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, 'ServerError');
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
              }
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }

            let useDelay = retryDelay;
            if (err instanceof RetryableGLMStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableGLMStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            console.warn(`[Chat] GLM request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        releaseChatLock = undefined;
        account = pickNextAccount(accountId);
        continue;
      } catch (err: any) {
        releaseChatLock?.();
        releaseChatLock = undefined;
        lastError = err;
        account = pickNextAccount(accountId);
      } finally {
        if (!success && releaseChatLock) {
          releaseChatLock();
          releaseChatLock = undefined;
        }
      }
    }

    if (!stream) {
      removeStream(completionId);
      throw lastError || new Error('All accounts failed');
    }

    // Cliente desconectou/abortou: cancela o upstream para soltar o navegador
    // e o mutex da conta, em vez de seguir gerando para ninguém.
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => { try { upstreamAbort?.abort(); } catch { /* noop */ } };
    if (clientSignal) {
      if (clientSignal.aborted) onClientAbort();
      else clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }

    if (!isStream) {
      try {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let reasoningBuffer = '';
      let lastFullContent = '';
      const glmParser = new GLMStreamParser();
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      const toolCallsOut: any[] = [];
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      let upstreamFinished = false;
      const handleDeltas = (deltas: ReturnType<GLMStreamParser['feed']>) => {
        for (const d of deltas) {
          if (d.type === 'finish') {
            upstreamFinished = true;
          } else if (d.type === 'usage') {
            if (d.completionTokens) completionTokens = d.completionTokens;
          } else if (d.type === 'delta') {
            if (d.reasoning) reasoningBuffer += d.reasoning;
            if (d.content) {
              const { text, toolCalls } = toolParser.feed(d.content);
              if (text) lastFullContent += text;
              for (const tc of toolCalls) {
                toolCallsOut.push({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                });
              }
            }
          }
        }
      };

      // O loop também termina no `finish` do z.ai (done:true) — o SSE upstream
      // pode permanecer aberto depois disso, e esperar o fechamento penduraria
      // o request com a resposta já completa.
      while (!upstreamFinished) {
        const { done, value } = await reader.read();
        if (done) break;
        handleDeltas(glmParser.feed(decoder.decode(value, { stream: true })));
      }
      if (upstreamFinished) {
        try { await reader.cancel(); } catch { /* noop */ }
      }
      handleDeltas(glmParser.flush());

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        lastFullContent += remainingText;
      }
      for (const tc of remainingToolCalls) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        });
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      // A spec OpenAI permite content + tool_calls juntos; o texto que o modelo
      // escreveu antes das chamadas não deve ser perdido.
      const message: any = {
        role: 'assistant',
        content: toolCallsOut.length ? (lastFullContent.trim() ? lastFullContent : null) : lastFullContent
      };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
      if (toolCallsOut.length) message.tool_calls = toolCallsOut;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
        }],
        usage
      });
      } finally {
        removeStream(completionId);
        releaseChatLock?.();
        releaseChatLock = undefined;
      }
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      let heartbeatInterval: any;
      try {
      // Send heartbeat to prevent Cloudflare 524 timeout
      await streamWriter.write(': heartbeat\n\n');

      // Set up a periodic heartbeat to keep the connection alive during long thinking phases
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch (e) {
          clearInterval(heartbeatInterval);
        }
      }, 15000); // Every 15 seconds

      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      const glmParser = new GLMStreamParser();
      let reasoningBuffer = '';
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      const emitChunk = async (delta: any) => {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice(delta)]
        });
      };

      let upstreamFinished = false;
      const processDeltas = async (deltas: ReturnType<GLMStreamParser['feed']>) => {
        for (const d of deltas) {
          if (d.type === 'finish') {
            upstreamFinished = true;
            continue;
          }
          if (d.type === 'usage') {
            if (d.completionTokens) completionTokens = d.completionTokens;
            continue;
          }
          if (d.type !== 'delta') continue;

          if (d.reasoning) {
            reasoningBuffer += d.reasoning;
            await emitChunk({ reasoning_content: d.reasoning });
          }
          if (d.content) {
            const { text, toolCalls } = toolParser.feed(d.content);
            if (text) await emitChunk({ content: text });
            for (const tc of toolCalls) {
              await emitChunk({
                tool_calls: [{
                  index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                }]
              });
            }
          }
        }
      };

      // Mesmo se o upstream falhar no meio, seguimos para fechar o SSE de forma
      // válida (flush do tool parser + chunk de finish + [DONE]) — SDKs OpenAI
      // ficam esperando indefinidamente se a conexão morre sem [DONE].
      let streamError: any = null;
      try {
        // Encerra também no `finish` do z.ai (done:true): o SSE upstream pode
        // permanecer aberto depois disso.
        while (!upstreamFinished) {
          const { done, value } = await reader.read();
          if (done) break;
          await processDeltas(glmParser.feed(decoder.decode(value, { stream: true })));
        }
        if (upstreamFinished) {
          try { await reader.cancel(); } catch { /* noop */ }
        }
        await processDeltas(glmParser.flush());
      } catch (err: any) {
        streamError = err;
        console.error('[Chat] Upstream stream failed mid-generation:', err?.message ?? err);
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: remainingText })]
        });
      }
      for (const tc of remainingToolCalls) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({
            tool_calls: [{
              index: toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc),
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }]
          })]
        });
      }

      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      // Em caso de erro no meio da geração, sinaliza no chunk final antes do
      // [DONE] (clientes que entendem `error` mostram a falha; os demais ao
      // menos encerram a request em vez de pendurar).
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(streamError ? { error: { message: `Upstream stream failed: ${streamError.message ?? streamError}` } } : {})
      });

      if (body.stream_options?.include_usage) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [],
          usage
        });
      }
      await streamWriter.write('data: [DONE]\n\n');

      } finally {
        clearInterval(heartbeatInterval);
        removeStream(completionId);
        releaseChatLock?.();
      }
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err)
    const status = err.upstreamStatus || 500
    if (status >= 500) {
      metrics.increment('requests.errors')
    }
    return c.json({ error: { message: err.message } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: 'chat_id and response_id are required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    // GLM/z.ai é stateless aqui: abortamos o stream local. Não há endpoint de
    // stop server-side confirmado (o chat_id é efêmero por requisição).
    // >>> TODO: se o z.ai expuser /api/chat/.../stop, plugar aqui.
    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
