/*
 * File: qwen.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-12
 */

import { getQwenHeaders, getBasicHeaders, invalidateHeaderCache } from './playwright.ts';
import { config } from '../core/config.ts';
import { v4 as uuidv4 } from 'uuid';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;

  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

interface SessionEntry {
  parentId: string | null;
  // O chat_id em que esse parentId (response_id) foi gerado. O parent só é
  // válido DENTRO do seu chat_id; guardar os dois juntos permite descartar o
  // parent quando o chat_id muda (refresh/invalidação de headers).
  chatId: string | null;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> = (globalThis as any)._sessionStates || new Map();
(globalThis as any)._sessionStates = sessionStates;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
}

export function updateSessionParent(sessionId: string, parentId: string | null, chatId: string | null = null) {
  if (sessionId) {
    if (sessionStates.size > 10000) {
      cleanupStaleSessions();
    }
    const existing = sessionStates.get(sessionId);
    sessionStates.set(sessionId, {
      parentId,
      chatId: chatId ?? existing?.chatId ?? null,
      timestamp: Date.now(),
    });
  }
}

export function clearSessionParent(sessionId: string) {
  if (sessionId) sessionStates.delete(sessionId);
}

function getSessionEntry(sessionId: string): SessionEntry | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  return entry;
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format: string;
    auto_search: boolean;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

const nativeToolsDisabled = new Set<string>();
const disablingNativeToolsInProgress = new Set<string>();

export async function disableNativeTools(accountId?: string): Promise<void> {
  const cacheKey = accountId || 'global';
  if (nativeToolsDisabled.has(cacheKey) || disablingNativeToolsInProgress.has(cacheKey)) {
    return;
  }
  disablingNativeToolsInProgress.add(cacheKey);

  try {
    const { headers } = await getQwenHeaders(false, accountId);
    
    const payload = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false
      }
    };

    console.log(`[Qwen] Disabling native tools for ${cacheKey}...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'pt-BR,pt;q=0.9',
        'content-type': 'application/json',
        'cookie': headers['cookie'],
        'origin': 'https://chat.qwen.ai',
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': uuidv4(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'],
        'bx-v': headers['bx-v']
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Qwen] Failed to disable native tools for ${cacheKey}: ${response.status} - ${text}`);
    } else {
      console.log(`[Qwen] Native tools disabled successfully for ${cacheKey}.`);
      nativeToolsDisabled.add(cacheKey);
    }
  } catch (err: any) {
    console.error(`[Qwen] Error disabling native tools for ${cacheKey}: ${err.message}`);
  } finally {
    disablingNativeToolsInProgress.delete(cacheKey);
  }
}

export async function fetchQwenModels(accountId?: string): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) { // 1 hour cache
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders(accountId);
  
  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': uuidv4(),
      'bx-v': bxV,
      'timezone': new Date().toString(),
      'source': 'web'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => ({
      id: m.id,
      object: 'model',
      created: m.info?.created_at || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'qwen'
    }));

    const extendedModels = [...models];
    for (const m of models) {
      extendedModels.push({
        ...m,
        id: `${m.id}-no-thinking`
      });
    }

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

/**
 * Watchdog de inatividade do stream em DUAS fases: se o primeiro chunk não
 * chega em `firstChunkMs`, ou se o stream trava NO MEIO (nenhum chunk por
 * `inactivityMs`), aborta o controller — o reader do chat.ts recebe o erro e
 * encerra o SSE limpo (chunk de erro + finish + [DONE]) em vez de pendurar o
 * request (e o mutex da conta) para sempre. No stall também invalidamos o
 * cache de headers da conta (auto-heal): a próxima request re-intercepta
 * headers frescos em vez de repetir o travamento.
 */
function withInactivityWatchdog(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  accountId: string | undefined,
): ReadableStream<Uint8Array> {
  const firstChunkMs = config.timeouts.streamFirstChunk;
  const inactivityMs = config.timeouts.streamInactivity;
  const reader = body.getReader();
  let timer: NodeJS.Timeout | undefined;
  let stallMessage: string | null = null;

  const arm = (ms: number, phase: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stallMessage = `Qwen stream stalled: no data for ${ms}ms (${phase})`;
      console.error(`[Qwen] ${stallMessage} for ${accountId || 'global'}. Aborting and invalidating headers.`);
      invalidateHeaderCache(accountId);
      controller.abort();
    }, ms);
  };
  const disarm = () => { if (timer) clearTimeout(timer); timer = undefined; };

  return new ReadableStream<Uint8Array>({
    start() {
      arm(firstChunkMs, 'first chunk');
    },
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          disarm();
          ctrl.close();
          return;
        }
        arm(inactivityMs, 'mid-stream');
        ctrl.enqueue(value);
      } catch (err: any) {
        disarm();
        ctrl.error(stallMessage ? new Error(stallMessage) : err);
      }
    },
    cancel(reason) {
      disarm();
      return reader.cancel(reason).catch(() => {});
    },
  });
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  sessionKey?: string
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string, sessionKey: string }> {
  // NÃO forçar re-interceptação de headers só porque é uma sessão nova: os
  // headers anti-bot (cookie/bx-ua/bx-umidtoken/bx-v) e o chat_id são
  // reutilizáveis dentro do TTL. Uma conversa nova só precisa de parent_id=null
  // (tratado abaixo), o que cria um branch novo no chat cacheado — o histórico
  // completo já vai serializado no prompt. Forçar interceptação aqui rodava a
  // dança completa do Playwright (navegar→digitar→clicar→interceptar, ~vários
  // segundos) em TODA conversa nova, o que era a causa da lentidão. Agora só a
  // primeira request (cache frio) e o refresh por TTL pagam esse custo; o
  // getQwenHeaders já re-intercepta sozinho quando o cache expira/é invalidado.
  const { headers, chatSessionId, parentMessageId } = await getQwenHeaders(false, accountId);

  // O parent chain é guardado por CONVERSA (sessionKey vindo do chat.ts);
  // fallback no chatSessionId mantém compatibilidade com chamadas antigas.
  const stateKey = sessionKey || chatSessionId;

  let actualParentId: string | null = parentMessageId;

  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (stateKey) {
    const storedEntry = getSessionEntry(stateKey);
    if (storedEntry && chatSessionId && storedEntry.chatId === chatSessionId) {
      // Mesmo chat_id da conversa anterior → o parent guardado é válido,
      // continua a thread.
      actualParentId = storedEntry.parentId;
    } else {
      // Conversa desconhecida (proxy reiniciou) OU o chat_id mudou (refresh/
      // invalidação do cache de headers entre turnos): o parent guardado
      // pertence a OUTRO chat e o Qwen recusaria ("parent_id is not exist").
      // Começa um branch novo; o histórico completo já vai serializado no
      // prompt. Limpa o estado obsoleto para não reusá-lo de novo.
      if (storedEntry) clearSessionParent(stateKey);
      actualParentId = null;
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = uuidv4();
  const model = modelId.replace('-no-thinking', '');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatSessionId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: [],
        timestamp: timestamp,
        models: [model],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false
        },
        extra: {
          meta: {
            subChatType: 't2t'
          }
        },
        sub_chat_type: 't2t',
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };

  const url = chatSessionId 
    ? `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatSessionId}`
    : 'https://chat.qwen.ai/api/v2/chat/completions';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': headers['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': chatSessionId ? `https://chat.qwen.ai/c/${chatSessionId}` : 'https://chat.qwen.ai/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': new Date().toString().split(' (')[0],
      'user-agent': headers['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': uuidv4(),
      'bx-ua': headers['bx-ua'],
      'bx-umidtoken': headers['bx-umidtoken'],
      'bx-v': headers['bx-v']
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        const details: string = errorJson?.data?.details || errorJson?.message || '';

        if (details.includes('chat is in progress') ||
            details.includes('The chat is in progress')) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          throw new RetryableQwenStreamError(
            `Qwen: ${details}`,
            retryAfterMs,
          );
        }

        // "parent_id ... is not exist": o parent guardado pertence a um chat_id
        // que mudou/expirou. Limpa o estado da conversa e pede retry IMEDIATO —
        // a re-tentativa começa um branch novo (parent_id=null), pois o estado
        // foi limpo. Precede o check genérico `success === false` (que também é
        // disparado por esse erro como Bad_Request) para não vazar como erro
        // fatal. O histórico completo já vai serializado no prompt.
        if (details.includes('is not exist') ||
            details.includes('not exist') ||
            details.includes('does not exist')) {
          if (stateKey) clearSessionParent(stateKey);
          throw new RetryableQwenStreamError(`Qwen: ${details}`, 0);
        }

        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const detailMsg = details || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined
            ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
            : '';
          let status: number;
          if (code === 'RateLimited') status = 429;
          else if (code === 'Not_Found') status = 404;
          else if (code === 'UpstreamError') status = 502;
          else status = 502;
          throw new QwenUpstreamError(
            `Qwen upstream error: ${code}: ${detailMsg}.${wait}`,
            code,
            status,
          );
        }
      } catch (parseOrRetryError) {
        if (parseOrRetryError instanceof RetryableQwenStreamError ||
            parseOrRetryError instanceof QwenUpstreamError) {
          throw parseOrRetryError;
        }
      }
    }
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  // Resposta 200 mas NÃO-SSE: o Qwen às vezes responde a uma sessão de chat com
  // um corpo JSON em vez do event-stream esperado. O caso mais comum é o desafio
  // anti-bot do Alibaba ("punish"/captcha): status 200, content-type JSON e um
  // corpo como {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."], "data":
  // {"url":".../punish?...action=captcha..."}}. Como status é 200 e há body, o
  // bloco de erro acima (que só checa !response.ok) não pega, e o JSON fluía como
  // se fosse stream — o parser de SSE o ignorava e o cliente recebia content:""
  // (resposta vazia silenciosa). Aqui detectamos o corpo não-SSE, e no caso do
  // desafio anti-bot invalidamos os headers (bx-ua/bx-umidtoken/bx-v) para forçar
  // reinterceptação via Playwright e pedimos retry imediato com tokens frescos.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const bodyText = await response.text().catch(() => '');
    const isAntiBotChallenge =
      /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|x5secdata|action=captcha|\/punish/i.test(bodyText);

    if (isAntiBotChallenge) {
      if (stateKey) clearSessionParent(stateKey);
      invalidateHeaderCache(accountId);
      console.warn(`[Qwen] Anti-bot challenge (captcha) for ${accountId || 'global'} — invalidated headers, will retry with fresh tokens.`);
      const challengeErr = new RetryableQwenStreamError('Qwen anti-bot challenge (captcha); refreshing headers', 0);
      (challengeErr as any).isAntiBot = true;
      throw challengeErr;
    }

    // Outro corpo não-SSE inesperado: tenta extrair um erro do Qwen; senão,
    // falha de forma explícita em vez de devolver uma resposta vazia.
    try {
      const errorJson = JSON.parse(bodyText);
      const details: string = errorJson?.data?.details || errorJson?.message ||
        (Array.isArray(errorJson?.ret) ? errorJson.ret.join(': ') : '') || '';
      if (details) {
        const code = errorJson?.data?.code || errorJson?.code || 'UpstreamError';
        const status = code === 'RateLimited' ? 429 : 502;
        throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}`, code, status);
      }
    } catch (e) {
      if (e instanceof QwenUpstreamError) throw e;
    }
    throw new Error(`Qwen returned non-SSE response (content-type: ${contentType}): ${bodyText.slice(0, 300)}`);
  }

  let upstreamBody = response.body;

  return {
    stream: withInactivityWatchdog(upstreamBody, controller, accountId),
    headers,
    uiSessionId: chatSessionId,
    controller,
    accountId: accountId ?? 'global',
    sessionKey: stateKey,
  };
}
