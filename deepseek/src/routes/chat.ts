/*
 * File: chat.ts
 * Project: deepseekproxy
 *
 * Handler OpenAI-compatível de /v1/chat/completions.
 *
 * >>> ATENÇÃO (adaptação DeepSeek): a construção do prompt, rotação de contas,
 * >>> tool-calling e o envelope de resposta OpenAI são reaproveitados do Qwen.
 * >>> PORÉM o PARSING do stream SSE (blocos `chunk.choices[0].delta.phase`,
 * >>> `chunk['response.created']`, etc.) é ESPECÍFICO do Qwen. O DeepSeek usa
 * >>> um formato de deltas baseado em path/operação (ex.: { v, p, o }).
 * >>> Esses trechos precisam ser reescritos após inspeção ao vivo. Veja PLAN.md
 * >>> seção "Parser de streaming".
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, deleteChatSession } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { DeepSeekStreamParser } from '../services/deepseek-stream.ts';
import { RetryableDeepSeekStreamError } from '../services/deepseek.ts';
import { Mutex } from '../services/playwright.ts';
import { getModelContextWindow } from '../core/model-registry.js'
import { estimateTokenCount } from '../utils/context-truncation.ts';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.ts';
import { registerStream, removeStream, getStream } from '../core/stream-registry.ts';
import { metrics } from '../core/metrics.js'
import { appendFileSync } from 'fs';

// Debug dump gated por env DS_DUMP=<arquivo>. Captura o que o cliente (opencode)
// manda e a saída CRUA do modelo (antes do parser de tool-call), p/ diagnosticar
// casos em que o modelo emite a tool-call num formato não-padrão (ex.: "[调用 X]").
const DS_DUMP = process.env.DS_DUMP;
function dsDump(label: string, data: unknown): void {
  if (!DS_DUMP) return;
  try {
    const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    appendFileSync(DS_DUMP, `\n===== ${label} @ ${new Date().toISOString()} =====\n${body}\n`);
  } catch {}
}

const accountMutexes = new Map<string, Mutex>();
function getAccountMutex(accountId: string): Mutex {
  let mutex = accountMutexes.get(accountId);
  if (!mutex) {
    mutex = new Mutex();
    accountMutexes.set(accountId, mutex);
  }
  return mutex;
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    dsDump('REQUEST', {
      model: body.model,
      stream: isStream,
      toolNames: ((body as any).tools || []).map((t: any) => t?.function?.name).filter(Boolean),
      messages: body.messages,
    });

    // Extract the prompt
    // Cada mensagem vira um "segmento" já serializado (com prefixo de papel,
    // <tool_call> do assistant, rótulo de tool response etc.). O prompt é o
    // join dos segmentos — e o truncamento descarta segmentos INTEIROS do
    // início, preservando a serialização e o system prompt (ver abaixo).
    const promptSegments: string[] = [];
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
        promptSegments.push(`User: ${contentStr || ''}\n\n`);
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
        promptSegments.push(`Assistant: ${assistantContent.trim()}\n\n`);
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
        promptSegments.push(`Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`);
      }
    }
    const prompt = promptSegments.join('');

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
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt);

    let finalPrompt: string;
    if (estimatedTokens > modelContextWindow - 1000) {
      // Estouro de contexto: descarta segmentos INTEIROS mais antigos, mas o
      // systemPrompt (que carrega as instruções de tools injetadas acima) é
      // SEMPRE preservado — perdê-lo quebra o tool calling exatamente nas
      // sessões agênticas longas, que é quando o truncamento dispara.
      const budget = modelContextWindow - 1000 - estimateTokenCount(systemPrompt);
      const kept: string[] = [];
      let used = 0;
      for (let i = promptSegments.length - 1; i >= 0; i--) {
        const segTokens = estimateTokenCount(promptSegments[i]);
        if (used + segTokens > budget) break;
        kept.unshift(promptSegments[i]);
        used += segTokens;
      }
      if (kept.length === 0 && promptSegments.length > 0) {
        // Nem a última mensagem coube inteira: corta por caracteres.
        const last = promptSegments[promptSegments.length - 1];
        const maxChars = Math.max(200, Math.floor(Math.max(0, budget) * 3.5));
        kept.push(`[Truncated] ${last.slice(0, maxChars)}...\n\n`);
      }
      const omitted = promptSegments.length - kept.length;
      const marker = omitted > 0 ? `[... ${omitted} mensagens anteriores omitidas por limite de contexto ...]\n\n` : '';
      finalPrompt = (systemPrompt ? `${systemPrompt}\n` : '') + marker + kept.join('');
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    // Só o reasoner (R1) ativa o "thinking"; deepseek-chat responde direto.
    // `-no-thinking` força desligado em qualquer modelo.
    const isThinkingModel = /reasoner|r1/i.test(body.model) && !body.model.includes('no-thinking');

    // Account selection with fallback on rate-limit/failure
    let account = getNextAccount();
    let triedAccountIds = new Set<string>();
    let lastError: any = null;

    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    let releaseChatLock: (() => void) | undefined;
    const completionId = 'chatcmpl-' + uuidv4();

    while (account) {
      const accountId = account.id;
      const accountEmail = account.email;

      if (triedAccountIds.has(accountId)) {
        account = getNextAvailableAccount(accountId);
        continue;
      }
      triedAccountIds.add(accountId);

      const cooldownInfo = getAccountCooldownInfo(accountId);
      if (cooldownInfo && accountId !== 'global') {
        console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
        account = getNextAvailableAccount(accountId);
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
            const result = await createDeepSeekStream(
              finalPrompt,
              isThinkingModel,
              body.model,
              accountId === 'global' ? undefined : accountId
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
            if (err instanceof RetryableDeepSeekStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableDeepSeekStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              releaseChatLock();
              releaseChatLock = undefined;
              lastError = err;
              break;
            }
            console.warn(`[Chat] DeepSeek request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        releaseChatLock = undefined;
        account = getNextAvailableAccount(accountId);
        continue;
      } catch (err: any) {
        releaseChatLock?.();
        releaseChatLock = undefined;
        lastError = err;
        account = getNextAvailableAccount(accountId);
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

    if (!isStream) {
      try {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();

      let reasoningBuffer = '';
      let lastFullContent = '';
      let rawContent = '';
      let upstreamError: string | null = null;
      const dsParser = new DeepSeekStreamParser();
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      const toolCallsOut: any[] = [];
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      const handleDeltas = (deltas: ReturnType<DeepSeekStreamParser['feed']>) => {
        for (const d of deltas) {
          if (d.type === 'error') {
            upstreamError = d.message || 'upstream error';
          } else if (d.type === 'usage') {
            if (d.completionTokens) completionTokens = d.completionTokens;
          } else if (d.type === 'delta') {
            if (d.reasoning) reasoningBuffer += d.reasoning;
            if (d.content) {
              rawContent += d.content;
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        handleDeltas(dsParser.feed(decoder.decode(value, { stream: true })));
      }
      handleDeltas(dsParser.flush());

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

      dsDump('RAW_MODEL_CONTENT (non-stream, pre-parser)', rawContent);
      dsDump('PARSED_RESULT (non-stream)', {
        emittedToolCalls: toolCallsOut.length,
        contentLength: lastFullContent.length,
        upstreamError,
      });

      if (upstreamError) {
        return c.json({ error: { message: `DeepSeek: ${upstreamError}` } }, 502 as any);
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };
      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
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
        const entry = getStream(completionId);
        // Aborta o upstream (no fim normal é no-op; em erro/early-return evita
        // a geração continuar queimando quota) e apaga a chat_session criada.
        entry?.abortController.abort();
        if (entry) deleteChatSession(entry.uiSessionId, entry.headers);
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
          // Cliente desconectou: para o heartbeat E aborta o upstream — senão
          // a geração continua queimando quota/mutex sem ninguém ouvindo.
          clearInterval(heartbeatInterval);
          getStream(completionId)?.abortController.abort();
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

      const dsParser = new DeepSeekStreamParser();
      let reasoningBuffer = '';
      let rawContent = '';
      let upstreamError: string | null = null;
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

      const processDeltas = async (deltas: ReturnType<DeepSeekStreamParser['feed']>) => {
        for (const d of deltas) {
          if (d.type === 'error') {
            upstreamError = d.message || 'upstream error';
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
            rawContent += d.content;
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

      // Se o upstream falhar NO MEIO do stream (abort por inatividade, rede,
      // WAF), a exceção NÃO pode subir — derrubaria o SSE sem finish_reason
      // nem [DONE] e o cliente agêntico ficaria pendurado/em retry. Captura e
      // termina o SSE limpo com um chunk de erro.
      let readError: string | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await processDeltas(dsParser.feed(decoder.decode(value, { stream: true })));
        }
        await processDeltas(dsParser.flush());
      } catch (err: any) {
        console.error('[Chat] Stream interrompido pelo upstream:', err?.message || err);
        readError = err?.message || String(err);
      }

      // Flush tool parser
      const { text: remainingText, toolCalls: remainingToolCalls } = toolParser.flush();

      dsDump('RAW_MODEL_CONTENT (pre-parser)', rawContent);
      dsDump('RAW_REASONING', reasoningBuffer);
      dsDump('PARSED_RESULT', {
        emittedToolCalls: toolParser.getEmittedToolCallCount(),
        leakedText: (remainingText || '').slice(0, 300),
        upstreamError,
        readError,
      });
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
  
      // Erro do upstream (no meio do stream ou embutido no SSE): avisa o
      // cliente como content e segue para o finish/[DONE] normais.
      if (upstreamError || readError) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: `\n[DeepSeek erro: ${upstreamError || readError}]` })]
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
        const entry = getStream(completionId);
        // Aborta o upstream (no-op no fim normal; em disconnect do cliente
        // evita a geração continuar) e apaga a chat_session criada.
        entry?.abortController.abort();
        if (entry) deleteChatSession(entry.uiSessionId, entry.headers);
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

    // >>> TODO(DeepSeek): confirmar o endpoint de stop. Hipótese:
    // >>> POST {baseUrl}/api/v0/chat/completion/cancel { chat_session_id, message_id }
    // >>> Auth via Bearer token (stream.headers.authorization), não bx-ua.
    const { config } = await import('../core/config.ts');
    const stopResponse = await fetch(`${config.deepseek.baseUrl}/api/v0/chat/completion/cancel`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Content-Type': 'application/json',
        'Authorization': stream.headers['authorization'] || '',
        'Cookie': stream.headers.cookie,
        'Origin': config.deepseek.baseUrl,
        'Referer': `${config.deepseek.baseUrl}/`,
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': uuidv4(),
      },
      body: JSON.stringify({ chat_session_id: chat_id, message_id: response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
