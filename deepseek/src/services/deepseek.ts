/*
 * File: deepseek.ts
 * Project: deepseekproxy
 *
 * Integração com a API web do DeepSeek (chat.deepseek.com).
 * Análogo ao antigo `qwen.ts`, mas adaptado às diferenças do DeepSeek:
 *   - Autenticação via Bearer token (não só cookie)
 *   - Proof-of-Work por requisição (ver pow.ts) em vez de headers cacheáveis
 *   - Sessão de chat criada explicitamente (/api/v0/chat_session/create)
 *   - Formato de streaming SSE diferente (deltas baseados em "path/op")
 *
 * Os endpoints e shapes marcados com >>> TODO precisam ser confirmados ao
 * vivo via DevTools. Veja PLAN.md.
 */

import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { getDeepSeekAuth, invalidateAuthToken } from './playwright.ts'
import {
  requestPowChallenge,
  solveChallenge,
  encodePowHeader,
} from './pow.ts'

export class RetryableDeepSeekStreamError extends Error {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'RetryableDeepSeekStreamError'
    this.retryAfterMs = retryAfterMs
  }
}

export class DeepSeekUpstreamError extends Error {
  readonly upstreamCode: string
  readonly upstreamStatus: number
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message)
    this.name = 'DeepSeekUpstreamError'
    this.upstreamCode = upstreamCode
    this.upstreamStatus = upstreamStatus
  }
}

/** Bearer token rejeitado pelo upstream (expirado/revogado). Dispara re-auth. */
export class DeepSeekAuthError extends Error {
  readonly upstreamStatus: number
  constructor(message: string, upstreamStatus: number) {
    super(message)
    this.name = 'DeepSeekAuthError'
    this.upstreamStatus = upstreamStatus
  }
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

// Nota: o proxy é stateless. Cada requisição cria uma sessão de chat nova e
// envia o histórico completo da conversa no prompt (montado pelo chat.ts a
// partir de todas as mensagens), como é padrão num proxy OpenAI-compatível.
// Por isso não há tracking de parent_message_id entre turnos.

// ---------------------------------------------------------------------------
// Modelos (o web chat não lista modelos como o Qwen; expomos estáticos)
// ---------------------------------------------------------------------------
export async function fetchDeepSeekModels(_accountId?: string): Promise<any[]> {
  const base = [
    { id: 'deepseek-chat', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', owned_by: 'deepseek' },
  ]
  return base.map(m => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.owned_by,
  }))
}

// ---------------------------------------------------------------------------
// Criação de sessão de chat
// ---------------------------------------------------------------------------
/**
 * Cria um chat_session no DeepSeek e devolve o id.
 * >>> TODO: confirmar endpoint/shape. Hipótese: POST /api/v0/chat_session/create
 * >>> body: { character_id: null } -> { data: { biz_data: { id } } }
 */
async function createChatSession(
  authToken: string,
  cookie: string,
  userAgent: string,
): Promise<string> {
  const res = await fetch(`${config.deepseek.baseUrl}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: authHeaders(authToken, cookie, userAgent),
    body: JSON.stringify({ character_id: null }),
    signal: AbortSignal.timeout(15000),
  })
  const raw = await res.text().catch(() => '')
  if (!res.ok) {
    if (isAuthStatus(res.status)) {
      throw new DeepSeekAuthError(`Auth rejeitada ao criar chat_session: ${res.status} - ${raw}`, res.status)
    }
    throw new Error(`Falha ao criar chat_session: ${res.status} ${res.statusText} - ${raw}`)
  }
  if (process.env.DISCOVER_POW) console.log('[deepseek][session-raw]', raw.slice(0, 400))
  const json: any = JSON.parse(raw)
  const id =
    json?.data?.biz_data?.id ??
    json?.data?.biz_data?.chat_session?.id ??
    json?.data?.id ??
    json?.biz_data?.id ??
    json?.id
  if (!id) throw new Error(`chat_session id ausente. Resposta: ${raw.slice(0, 300)}`)
  return id
}

// Headers confirmados ao vivo (interceptados de uma requisição real do app).
function authHeaders(authToken: string, cookie: string, userAgent: string): Record<string, string> {
  return {
    'accept': '*/*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json',
    'authorization': `Bearer ${authToken}`,
    'cookie': cookie,
    'origin': config.deepseek.baseUrl,
    'referer': `${config.deepseek.baseUrl}/`,
    'user-agent': userAgent,
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'en_US',
    'x-request-id': uuidv4(),
  }
}

// ---------------------------------------------------------------------------
// Limpeza de sessão (fire-and-forget)
// ---------------------------------------------------------------------------
/**
 * Apaga a chat_session criada para a requisição. Best-effort: falha é só
 * logada (a sessão órfã fica no histórico da conta, sem impacto funcional).
 */
export function deleteChatSession(chatSessionId: string, headers: Record<string, string>): void {
  if (!chatSessionId || !config.deepseek.sessionCleanup) return
  fetch(`${config.deepseek.baseUrl}/api/v0/chat_session/delete`, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/json',
      'authorization': headers['authorization'] || '',
      'cookie': headers['cookie'] || '',
      'origin': config.deepseek.baseUrl,
      'referer': `${config.deepseek.baseUrl}/`,
      'user-agent': headers['user-agent'] || '',
      'x-app-version': '2.0.0',
      'x-client-version': '2.0.0',
      'x-client-platform': 'web',
      'x-request-id': uuidv4(),
    },
    body: JSON.stringify({ chat_session_id: chatSessionId }),
    signal: AbortSignal.timeout(10000),
  }).then(res => {
    if (!res.ok) console.warn(`[deepseek] delete da chat_session ${chatSessionId} falhou: ${res.status}`)
    return res.text().catch(() => '')
  }).catch(err => {
    console.warn(`[deepseek] delete da chat_session ${chatSessionId} falhou:`, err?.message || err)
  })
}

// ---------------------------------------------------------------------------
// Watchdog de inatividade entre chunks
// ---------------------------------------------------------------------------
/**
 * Envolve o body do fetch num stream que aborta o controller se nenhum chunk
 * chegar em `stallMs`. O CHAT_TIMEOUT cobre só até os headers; sem isto, um
 * stream que trava NO MEIO fica pendurado para sempre (e o heartbeat do proxy
 * impede o cliente de desistir sozinho).
 */
function withInactivityTimeout(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  stallMs: number,
): ReadableStream<Uint8Array> {
  if (!stallMs || stallMs <= 0) return body
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let out: ReadableStreamDefaultController<Uint8Array> | null = null
  let failed = false
  const disarm = () => { if (timer) { clearTimeout(timer); timer = undefined } }
  // Erra o stream de SAÍDA diretamente (além de abortar o fetch): o consumidor
  // é desbloqueado mesmo que o reader interno nunca rejeite após o abort.
  const fail = (err: Error) => {
    if (failed) return
    failed = true
    disarm()
    try { out?.error(err) } catch { /* já errado/fechado */ }
    reader.cancel(err).catch(() => {})
    controller.abort(err)
  }
  const arm = () => {
    disarm()
    timer = setTimeout(() => {
      fail(new Error(`DeepSeek stream inativo por ${stallMs}ms (stall no meio do streaming)`))
    }, stallMs)
  }
  return new ReadableStream<Uint8Array>({
    start(c) { out = c; arm() },
    async pull(c) {
      try {
        const { done, value } = await reader.read()
        if (failed) return
        if (done) { disarm(); c.close(); return }
        arm()
        c.enqueue(value)
      } catch (err) {
        if (failed) return
        disarm()
        c.error(err)
      }
    },
    cancel(reason) {
      disarm()
      return reader.cancel(reason).catch(() => {})
    },
  })
}

// ---------------------------------------------------------------------------
// Stream principal de completion
// ---------------------------------------------------------------------------
export interface DeepSeekStreamResult {
  stream: ReadableStream
  headers: Record<string, string>
  uiSessionId: string
  controller: AbortController
  accountId: string
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  accountId?: string,
): Promise<DeepSeekStreamResult> {
  let auth = await getDeepSeekAuth(accountId)
  try {
    return await attemptStream(auth, prompt, enableThinking, accountId)
  } catch (err: any) {
    // Token expirado/revogado: invalida, força re-harvest e tenta UMA vez mais.
    if (err instanceof DeepSeekAuthError || isAuthStatus(err?.upstreamStatus)) {
      console.warn(`[deepseek] Auth rejeitada (${err?.upstreamStatus ?? '401'}) para conta ${accountId ?? 'global'}; renovando token e tentando novamente.`)
      invalidateAuthToken(accountId, auth.token)
      auth = await getDeepSeekAuth(accountId, { forceRefresh: true })
      return await attemptStream(auth, prompt, enableThinking, accountId)
    }
    throw err
  }
}

async function attemptStream(
  auth: { token: string; cookie: string; userAgent: string },
  prompt: string,
  enableThinking: boolean,
  accountId?: string,
): Promise<DeepSeekStreamResult> {
  const { token, cookie, userAgent } = auth

  // 1+2) Sessão de chat e Proof-of-Work em PARALELO (são independentes; em
  // série custava um round-trip extra por requisição).
  const [chatSessionId, powHeader] = await Promise.all([
    createChatSession(token, cookie, userAgent),
    requestPowChallenge(config.deepseek.baseUrl, token, cookie, userAgent)
      .then(solveChallenge)
      .then(encodePowHeader),
  ])
  const parentId: string | null = null

  // 3) Payload de completion — campos confirmados ao vivo (req real interceptada).
  const payload = {
    chat_session_id: chatSessionId,
    parent_message_id: parentId,
    model_type: 'default',
    prompt,
    ref_file_ids: [] as string[],
    thinking_enabled: enableThinking,
    search_enabled: false,
    action: null,
    preempt: false,
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error(`DeepSeek não respondeu em ${config.timeouts.chat}ms`)), config.timeouts.chat)

  let response: Response
  try {
    response = await fetch(`${config.deepseek.baseUrl}/api/v0/chat/completion`, {
      method: 'POST',
      headers: {
        ...authHeaders(token, cookie, userAgent),
        'accept': 'text/event-stream',
        'x-ds-pow-response': powHeader,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }

  if (process.env.DISCOVER_POW) {
    console.log('[deepseek][completion] status', response.status,
      '| ct', response.headers.get('content-type'),
      '| cl', response.headers.get('content-length'))
  }

  // O DeepSeek às vezes responde 200 com application/json (NÃO event-stream)
  // para erros de negócio — ex.: conta silenciada (biz_code 5 / is_muted) ou
  // limites. Sem tratar isso, o corpo JSON é repassado ao parser SSE, que não
  // acha nenhuma linha `data:` e devolve uma resposta VAZIA silenciosa.
  // Detecta e converte num erro claro (com cooldown via 429).
  const completionCt = response.headers.get('content-type') || ''
  if (response.ok && response.body && !completionCt.includes('event-stream')) {
    const bodyText = await response.text().catch(() => '')
    let parsed: any = null
    try { parsed = JSON.parse(bodyText) } catch { /* corpo não-JSON */ }
    const bizData = parsed?.data?.biz_data
    const bizMsg = parsed?.data?.biz_msg || parsed?.msg || bodyText.slice(0, 200)
    if (bizData?.is_muted) {
      const until = bizData.mute_until ? new Date(bizData.mute_until * 1000).toISOString() : 'desconhecido'
      throw new DeepSeekUpstreamError(
        `DeepSeek account muted ("${bizMsg}") até ${until}`,
        'RateLimited',
        429,
      )
    }
    throw new DeepSeekUpstreamError(
      `DeepSeek respondeu não-stream (content-type=${completionCt}): ${bizMsg}`,
      'UpstreamError',
      502,
    )
  }

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '')
    // Mapeamento de erros — espelha o tratamento do Qwen.
    if (response.status === 429) {
      throw new DeepSeekUpstreamError(`DeepSeek rate limited: ${errText}`, 'RateLimited', 429)
    }
    if (isAuthStatus(response.status)) {
      throw new DeepSeekAuthError(`DeepSeek auth rejeitada no completion: ${response.status} - ${errText}`, response.status)
    }
    if (response.status >= 500) {
      throw new DeepSeekUpstreamError(`DeepSeek server error: ${errText}`, 'UpstreamError', response.status)
    }
    // PoW inválido/expirado costuma ser retryable.
    if (/pow|challenge/i.test(errText)) {
      throw new RetryableDeepSeekStreamError(`DeepSeek PoW rejeitado: ${errText}`, 1000)
    }
    throw new Error(`Falha no DeepSeek completion: ${response.status} ${response.statusText} - ${errText}`)
  }

  const headers = { cookie, 'user-agent': userAgent, authorization: `Bearer ${token}` }
  return {
    stream: withInactivityTimeout(response.body, controller, config.timeouts.streamStall),
    headers,
    uiSessionId: chatSessionId,
    controller,
    accountId: accountId ?? 'global',
  }
}
