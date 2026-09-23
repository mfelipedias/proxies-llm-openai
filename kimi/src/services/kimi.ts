/*
 * kimi.ts — Tradução OpenAI ↔ Connect-RPC do kimi.com (API direta).
 *
 * Arquitetura decidida na recon (ver kimi/PLAN.md, Fase 1): o chat é fetch
 * direto para o endpoint Connect-RPC, autenticado só pelo Bearer do cookie
 * `kimi-auth`. Não há assinatura de corpo obrigatória. `x-msh-device-id` e
 * `x-traffic-id` são derivados do próprio JWT.
 */
import { encodeConnectFrame, decodeConnectStream } from './connect.ts'
import { config } from '../core/config.ts'
import type { Message } from '../utils/types.ts'

const CHAT_URL = `${config.kimi.baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`

/** Erro de chat que vale a pena re-tentar (rate limit / 5xx transitório). */
export class RetryableKimiStreamError extends Error {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'RetryableKimiStreamError'
    this.retryAfterMs = retryAfterMs
  }
}

export interface KimiAuth {
  /** JWT do cookie kimi-auth (sem o prefixo "Bearer "). */
  token: string
  deviceId: string
  trafficId: string
  sessionId: string
}

interface JwtPayload {
  sub?: string
  device_id?: string
  space_id?: string
  exp?: number
}

function decodeJwt(token: string): JwtPayload {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve a credencial. Por ora via env `KIMI_AUTH` (o JWT do cookie kimi-auth),
 * que também é o caminho de deploy headless/Docker. O fluxo de login por
 * Playwright (Fase 3) vai popular isto a partir do cookie capturado.
 */
export function resolveKimiAuth(): KimiAuth {
  const token = (process.env.KIMI_AUTH || config.kimi.apiKey || '').trim()
  if (!token) {
    throw new Error('Sem credencial Kimi: defina KIMI_AUTH (JWT do cookie kimi-auth) no .env. Login via Playwright ainda pendente (PLAN Fase 3).')
  }
  const p = decodeJwt(token)
  if (p.exp && p.exp * 1000 < Date.now()) {
    throw new Error('Token Kimi (KIMI_AUTH) expirado — relogue e atualize o .env.')
  }
  return {
    token,
    deviceId: process.env.KIMI_DEVICE_ID || p.device_id || '0',
    trafficId: p.sub || '',
    sessionId: process.env.KIMI_SESSION_ID || String(p.device_id || '0'),
  }
}

function buildHeaders(auth: KimiAuth): Record<string, string> {
  return {
    'authorization': `Bearer ${auth.token}`,
    'content-type': 'application/connect+json',
    'connect-protocol-version': '1',
    'x-msh-device-id': auth.deviceId,
    'x-msh-session-id': auth.sessionId,
    'x-msh-platform': 'web',
    'x-msh-version': '1.0.0',
    'x-traffic-id': auth.trafficId,
    'x-language': 'en-US',
    'r-timezone': 'America/Sao_Paulo',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'origin': config.kimi.baseUrl,
    'referer': `${config.kimi.baseUrl}/`,
  }
}

const SCENARIO = 'SCENARIO_K2D5'

/** Mapeia um id de modelo OpenAI para os parâmetros do kimi. */
export function mapModel(modelId: string): { scenario: string; thinking: boolean } {
  const id = (modelId || '').toLowerCase()
  const thinking = id.includes('thinking') && !id.includes('no-thinking')
  return { scenario: SCENARIO, thinking }
}

/**
 * Achata o histórico OpenAI em um único texto de prompt. O kimi mantém estado
 * por conversa no servidor, mas o proxy é stateless por request: serializamos
 * o histórico inteiro em uma mensagem nova (mesma abordagem do qwen).
 */
export function flattenMessages(messages: Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const content = (m.content ?? '').toString().trim()
    if (!content && !m.tool_calls) continue
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : m.role === 'tool' ? 'Tool' : 'User'
    parts.push(`${role}: ${content}`)
  }
  // pede a continuação como assistant
  parts.push('Assistant:')
  return parts.join('\n\n')
}

export type KimiEvent =
  | { kind: 'meta'; chatId: string; assistantMsgId: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'text'; delta: string }
  | { kind: 'done' }

export interface StreamKimiOptions {
  messages: Message[]
  model: string
  signal?: AbortSignal
  /** continuar uma conversa existente (multi-turn nativo, opcional) */
  chatId?: string
  parentId?: string
  auth?: KimiAuth
}

/**
 * Envia o prompt ao kimi e emite eventos normalizados conforme o stream chega.
 * Reconstrói o texto (e o reasoning, quando thinking=true) a partir dos frames
 * Connect `op:set`/`op:append`.
 */
export async function* streamKimiChat(opts: StreamKimiOptions): AsyncGenerator<KimiEvent> {
  const auth = opts.auth ?? resolveKimiAuth()
  const { scenario, thinking } = mapModel(opts.model)

  const content = opts.chatId
    ? // multi-turn nativo: manda só a última mensagem do usuário
      (opts.messages.filter(m => m.role === 'user').pop()?.content ?? '').toString()
    : flattenMessages(opts.messages)

  const message: any = { role: 'user', blocks: [{ message_id: '', text: { content } }], scenario }
  if (opts.parentId) message.parent_id = opts.parentId

  const reqBody: any = { scenario, tools: [], message, options: { thinking } }
  if (opts.chatId) reqBody.chat_id = opts.chatId

  let res: Response
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: buildHeaders(auth),
      body: encodeConnectFrame(reqBody),
      signal: opts.signal,
    })
  } catch (e: any) {
    throw new RetryableKimiStreamError(`Falha de rede ao chamar kimi: ${e?.message}`, 2000)
  }

  if (res.status === 429) throw new RetryableKimiStreamError('Rate limited pelo kimi (429)', 60_000)
  if (res.status >= 500) throw new RetryableKimiStreamError(`kimi ${res.status}`, 3000)
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Não autorizado pelo kimi (${res.status}) — token inválido/expirado.`)
  }
  if (!res.ok || !res.body) {
    const txt = res.body ? await res.text().catch(() => '') : ''
    throw new Error(`kimi retornou ${res.status}: ${txt.slice(0, 300)}`)
  }

  let chatId = ''
  let assistantMsgId = ''
  let metaSent = false
  // ids dos blocos que são "thinking" (reasoning) vs texto normal
  const thinkingBlocks = new Set<string>()

  for await (const frame of decodeConnectStream(res.body)) {
    const j = frame.json
    if (frame.endStream) {
      if (j?.error) throw new Error(`kimi stream error: ${JSON.stringify(j.error).slice(0, 300)}`)
      break
    }
    if (!j || j.heartbeat) continue

    if (j.chat?.id) chatId = j.chat.id
    if (j.mask === 'message' && j.message?.role === 'assistant' && j.message?.id) {
      assistantMsgId = j.message.id
    }
    if (!metaSent && chatId && assistantMsgId) {
      metaSent = true
      yield { kind: 'meta', chatId, assistantMsgId }
    }

    // blocos: text normal vs thinking. O bloco de reasoning vem com type/role
    // próprios; marcamos pelo primeiro "set" e roteamos os "append" seguintes.
    if (j.op === 'set' && j.mask === 'block.text') {
      const id = j.block?.id ?? ''
      const isThink = j.block?.type === 'thinking' || j.block?.role === 'thinking'
      if (isThink) thinkingBlocks.add(id)
      const delta = j.block?.text?.content ?? ''
      if (delta) yield thinkingBlocks.has(id) ? { kind: 'reasoning', delta } : { kind: 'text', delta }
    } else if (j.op === 'append' && j.mask === 'block.text.content') {
      const id = j.block?.id ?? ''
      const delta = j.block?.text?.content ?? ''
      if (delta) yield thinkingBlocks.has(id) ? { kind: 'reasoning', delta } : { kind: 'text', delta }
    }
  }

  if (!metaSent && (chatId || assistantMsgId)) yield { kind: 'meta', chatId, assistantMsgId }
  yield { kind: 'done' }
}
