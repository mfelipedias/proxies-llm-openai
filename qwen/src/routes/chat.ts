/*
 * File: chat.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { createQwenStream, updateSessionParent } from '../services/qwen.ts';
import { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { Mutex } from '../services/playwright.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateSerializedHistory, estimateTokenCount, type PromptSegment } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo, getCooldownStatus } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream, abortStream } from '../core/stream-registry.ts';
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

/**
 * Decide se `newStr` é um re-envio CUMULATIVO (contém todo o conteúdo anterior
 * como prefixo) ou um chunk INCREMENTAL puro. A heurística antiga comparava só
 * os primeiros 4 caracteres, o que mutilava chunks incrementais que por
 * coincidência começavam igual ao início da resposta (ex.: dois parágrafos
 * começando com "The "), e duplicava conteúdo cumulativo acima de 2000 chars.
 * Aqui o teste é exato: cumulativo só quando newStr.startsWith(oldStr).
 */
export function getIncrementalDelta(oldStr: string, newStr: string): DeltaResult {
  if (!oldStr) {
    return { delta: newStr, matchedContent: newStr };
  }
  if (newStr === oldStr) {
    return { delta: '', matchedContent: oldStr };
  }

  if (newStr.length > oldStr.length && newStr.startsWith(oldStr)) {
    return {
      delta: newStr.substring(oldStr.length),
      matchedContent: newStr
    };
  }

  // Re-envio cumulativo REGREDIDO (mais curto que o acumulado): nada novo.
  if (newStr.length < oldStr.length && oldStr.startsWith(newStr)) {
    return { delta: '', matchedContent: oldStr };
  }

  // Chunk incremental puro. Sem busca de overlap parcial: ela causava
  // corrupções com falso-positivo em código/palavras repetitivas.
  return {
    delta: newStr,
    matchedContent: oldStr + newStr
  };
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(text);
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : (code === 'Not_Found' ? 404 : 502);
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : (payload.error.message || JSON.stringify(payload.error));
      return { message: `Qwen upstream error: ${msg}`, status: 502 };
    }
    // Desafio anti-bot do Alibaba (captcha/punish) que vazou como corpo do
    // stream: {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::..."], ...}.
    // Normalmente é tratado em createQwenStream (200 não-SSE), mas aqui serve de
    // rede de segurança para nunca devolver uma resposta vazia silenciosa.
    if (payload && Array.isArray(payload.ret) &&
        payload.ret.some((r: any) => typeof r === 'string' && /FAIL_SYS_USER_VALIDATE|RGV587_ERROR/i.test(r))) {
      return { message: `Qwen anti-bot challenge (captcha): ${payload.ret.join(': ')}`, status: 502 };
    }
  } catch {
    // Non-SSE, non-JSON upstream body. Keep this as an explicit bad gateway
    // instead of silently returning an empty assistant message.
    return { message: `Qwen upstream returned non-SSE response: ${text.slice(0, 300)}`, status: 502 };
  }

  return null;
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

    const isThinkingModel = !body.model.includes('no-thinking');

    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Identidade da CONVERSA (não da conta): o parent chain do Qwen é guardado
    // por conversa, para que conversas concorrentes na mesma conta não
    // sobrescrevam o parent uma da outra. O fingerprint usa a primeira mensagem
    // de user, que é estável entre os turnos de uma mesma conversa.
    const firstUser = messages.find(m => m.role === 'user');
    const firstUserContent = typeof firstUser?.content === 'string'
      ? firstUser.content
      : JSON.stringify(firstUser?.content ?? '');
    const convFingerprint = createHash('sha256').update(firstUserContent).digest('hex').slice(0, 16);

    // Account selection with fallback on rate-limit/failure
    let account: { id: string; email: string } | null = getNextAccount();
    if (!account) {
      // Sem contas no banco: usa o perfil global (login via .env / manual).
      account = { id: 'global', email: 'global (.env profile)' };
    }
    const triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    let sessionKey = '';
    let releaseChatLock: (() => void) | undefined;
    const completionId = 'chatcmpl-' + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      // Cada conta é tentada UMA vez; quando todas as candidatas já foram
      // tentadas, getNextAvailableAccount(triedAccountIds) retorna null e o
      // loop termina (antes era possível um ping-pong infinito entre contas
      // já tentadas).
      if (triedAccountIds.has(accountId)) break;
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      }

      console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);

      // O lock é mantido durante TODO o streaming: a UI do Qwen rejeita chats
      // paralelos na mesma conta ("chat is in progress"), então requests da
      // mesma conta serializam aqui. O watchdog de inatividade do stream
      // (qwen.ts) garante que um stream travado não segura o lock para sempre.
      const accountMutex = getAccountMutex(accountId);
      releaseChatLock = await accountMutex.acquire();

      let success = false;
      try {
        let retries = 3;
        let retryDelay = 500;
        success = false;

        while (retries > 0) {
          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              body.model,
              isNewSession ? null : undefined,
              accountId === 'global' ? undefined : accountId,
              `${accountId}:${convFingerprint}`
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            sessionKey = result.sessionKey;
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

            // Desafio anti-bot (captcha/punish): reinterceptar headers na MESMA
            // conta/perfil só re-dispara o desafio — é um bloqueio server-side
            // por conta/IP, não header velho. Não gasta os retries restantes
            // martelando o Playwright (navegar→digitar→clicar→interceptar) nesta
            // conta: cooldown imediato e deixa o loop externo rotacionar para
            // outra conta. Antes só rotacionava após esgotar 3 retries, o que
            // fazia ~3 reinterceptações inúteis por conta marcada.
            if (err.isAntiBot) {
              markAccountRateLimited(accountId, 5 * 60 * 1000, 'AntiBot');
              console.warn(`[Chat] Account ${accountEmail} (${accountId}) hit an anti-bot challenge (captcha). Cooling down 5min and rotating to another account — solve the captcha in the Qwen browser session or wait.`);
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
            if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        releaseChatLock = undefined;
        account = getNextAvailableAccount(triedAccountIds);
        continue;
      } catch (err: any) {
        releaseChatLock?.();
        releaseChatLock = undefined;
        lastError = err;
        account = getNextAvailableAccount(triedAccountIds);
      } finally {
        if (!success && releaseChatLock) {
          releaseChatLock();
          releaseChatLock = undefined;
        }
      }
    }

    if (!stream) {
      removeStream(completionId);
      if (lastError) throw lastError;
      const cooldowns = getCooldownStatus();
      const remaining = Object.values(cooldowns).map(cd => cd.remainingMs);
      if (remaining.length > 0) {
        const e: any = new Error(`Qwen: all accounts are on cooldown. Retry in ~${Math.ceil(Math.min(...remaining) / 1000)}s.`);
        e.upstreamStatus = 429;
        throw e;
      }
      throw new Error('All accounts failed');
    }

    if (!isStream) {
      try {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let reasoningBuffer = '';
      let lastFullContent = '';
      let contentOut = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      const toolCallsOut: any[] = [];
      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
                const entry = getStream(completionId);
                if (entry) entry.targetResponseId = targetResponseId!;
              }
              updateSessionParent(sessionKey, chunk['response.created'].response_id, uiSessionId);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              const entry = getStream(completionId);
              if (entry) entry.targetResponseId = targetResponseId!;
              updateSessionParent(sessionKey, chunk.response_id, uiSessionId);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                reasoningBuffer += vStr;
              } else {
                // O parser separa texto de tool-calls: o texto vem dele (e não
                // do conteúdo cru), para nunca vazar XML interno de tool_call
                // nem duplicar o rabo retido no flush.
                const { text, toolCalls } = toolParser.feed(vStr);
                if (text) contentOut += text;
                for (const tc of toolCalls) {
                  toolCallsOut.push({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  });
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
      }

      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();
      if (remainingText) {
        contentOut += remainingText;
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
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : contentOut };
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
        // Aborta o upstream se ainda estiver vivo (ex.: erro no meio da
        // leitura): sem isso o Qwen continua gerando e a próxima request da
        // conta esbarra em "chat is in progress".
        abortStream(completionId);
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

      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let currentThoughtIndex = 0;
      let lastFullContent = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser(bodyAny.tools || []);

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      const handleLine = async (line: string) => {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) return;

          const dataStr = trimmed.slice(6);
          // NÃO encaminhar o [DONE] do upstream: o nosso [DONE] só vai depois
          // do flush do parser e do chunk de finish_reason — repassar aqui
          // faria o cliente parar de ler antes dos tool calls finais.
          if (dataStr === '[DONE]') return;

          try {
            const chunk = JSON.parse(dataStr);

            // Extract response_id for session tracking and target filtering
            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) {
                targetResponseId = chunk['response.created'].response_id;
                const entry = getStream(completionId);
                if (entry) entry.targetResponseId = targetResponseId!;
              }
              updateSessionParent(sessionKey, chunk['response.created'].response_id, uiSessionId);
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              const entry = getStream(completionId);
              if (entry) entry.targetResponseId = targetResponseId!;
              updateSessionParent(sessionKey, chunk.response_id, uiSessionId);
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                (targetResponseId === null || chunk.response_id === targetResponseId)) {
              const delta = chunk.choices[0].delta;

              if (delta.phase === 'thinking_summary') {
                isThinkingChunk = true;
                if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
                  const thoughts = delta.extra.summary_thought.content;
                  if (thoughts.length > currentThoughtIndex) {
                    vStr = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    foundStr = true;
                  }
                }
              } else if (delta.phase === 'answer') {
                isThinkingChunk = false;
                if (delta.content !== undefined) {
                  const newContent = delta.content || '';
                  const result = getIncrementalDelta(lastFullContent, newContent);
                  vStr = result.delta;
                  if (vStr) {
                    lastFullContent = result.matchedContent;
                    foundStr = true;
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') return;

              if (isThinkingChunk) {
                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice({ reasoning_content: vStr })]
                });
              } else {
                const { text, toolCalls } = toolParser.feed(vStr);

                if (text) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({ content: text })]
                  });
                }

                for (const tc of toolCalls) {
                  await writeEvent({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [makeChoice({
                      tool_calls: [{
                        index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
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
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
      };

      // Se o upstream errar no meio do stream (rede, abort do watchdog de
      // inatividade), NÃO deixamos a exceção subir — isso cortaria a conexão
      // SSE sem finish_reason nem [DONE] e o cliente agêntico ficaria
      // pendurado/em retry. Capturamos e terminamos o SSE limpo com um chunk
      // de erro.
      let readError: string | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            await handleLine(line);
          }
        }
      } catch (err: any) {
        console.error('[Chat] Stream interrupted mid-read:', err?.message || err);
        readError = err?.message || String(err);
      }

      const upstreamError = parseQwenErrorPayload(buffer);

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

      if (upstreamError || readError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: `\n[Qwen error: ${upstreamError?.message || readError}]` })]
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

      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(body.stream_options?.include_usage ? {} : { usage })
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
        // Aborta o upstream se ainda estiver vivo (cliente desconectou /
        // erro no meio): sem isso o Qwen continua gerando e a próxima request
        // da conta esbarra em "chat is in progress".
        abortStream(completionId);
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
    // `chat_id` é o id retornado por /v1/chat/completions (chatcmpl-...), que é
    // a chave do stream-registry. O chat_id REAL do Qwen (uiSessionId) sai do
    // próprio registro — antes o id do completion era enviado cru para o Qwen.
    const { chat_id, response_id } = body;

    if (!chat_id) {
      return c.json({ error: 'chat_id is required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    const targetResponseId = response_id || stream.targetResponseId;
    if (!targetResponseId) {
      return c.json({ error: 'response_id not known yet for this stream' }, 400);
    }
    if (response_id && stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const qwenChatId = stream.uiSessionId;
    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${qwenChatId}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${qwenChatId}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': uuidv4(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id: qwenChatId, response_id: targetResponseId }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${qwenChatId}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    abortStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${qwenChatId}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
