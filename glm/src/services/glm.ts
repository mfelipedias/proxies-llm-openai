/*
 * File: glm.ts
 * Project: glmproxy
 *
 * Integração com a API web do GLM (chat.z.ai, Zhipu).
 * Análogo ao `qwen.ts`, mas adaptado às diferenças do z.ai:
 *   - O chat.z.ai é baseado no Open WebUI: auth por BEARER TOKEN
 *     (localStorage `token`), sem os headers anti-bot do Qwen (bx-ua etc.)
 *     e sem Proof-of-Work do DeepSeek.
 *   - Endpoint de completion estilo Open WebUI: POST /api/chat/completions.
 *   - Stream SSE em formato próprio: { type:"chat:completion",
 *     data:{ phase:"thinking"|"answer", delta_content, usage } } (ver glm-stream.ts).
 *   - Modelos listados dinamicamente em GET /api/models (como o Qwen).
 *
 * Os endpoints e shapes marcados com >>> TODO precisam ser confirmados ao
 * vivo via DevTools / src/validate.ts. Veja PLAN.md.
 */

import { v4 as uuidv4 } from 'uuid'
import { config } from '../core/config.ts'
import { getGLMAuth, createBridgeStream } from './playwright.ts'

// Definida em playwright.ts (o bridge a lança); re-exportada aqui para manter
// o import existente do chat.ts.
export { RetryableGLMStreamError } from './playwright.ts'

export class GLMUpstreamError extends Error {
  readonly upstreamCode: string
  readonly upstreamStatus: number
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message)
    this.name = 'GLMUpstreamError'
    this.upstreamCode = upstreamCode
    this.upstreamStatus = upstreamStatus
  }
}

// Nota: o proxy é stateless. Cada requisição cria um chat_id novo e envia o
// histórico completo da conversa no prompt (montado pelo chat.ts), como é
// padrão num proxy OpenAI-compatível. Sem tracking de parent entre turnos.

// ---------------------------------------------------------------------------
// Modelos (GET /api/models, formato Open WebUI — igual ao Qwen)
// ---------------------------------------------------------------------------
let cachedModels: any[] | null = null
let lastModelsFetch = 0

export async function fetchGLMModels(accountId?: string): Promise<any[]> {
  const now = Date.now()
  if (cachedModels && now - lastModelsFetch < 3600000) {
    return cachedModels
  }

  const { token, cookie, userAgent } = await getGLMAuth(accountId)
  const response = await fetch(`${config.glm.baseUrl}/api/models`, {
    headers: {
      ...authHeaders(token, cookie, userAgent),
      accept: 'application/json, text/plain, */*',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch models from GLM: ${response.status} ${response.statusText}`)
  }

  const json = await response.json()
  const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const models = list.map((m: any) => ({
    id: m.id,
    object: 'model',
    created: m.info?.created_at || Math.floor(Date.now() / 1000),
    owned_by: m.owned_by || 'z.ai',
    context_window: m.info?.meta?.max_context_length,
  }))

  // Variante -no-thinking para cada modelo (desliga o reasoning).
  const extended = [...models]
  for (const m of models) extended.push({ ...m, id: `${m.id}-no-thinking` })

  cachedModels = extended
  lastModelsFetch = now
  return extended
}

// Headers de auth do Open WebUI / z.ai.
// >>> TODO: confirmar ao vivo se há headers extras obrigatórios
// >>> (ex.: x-fe-version, x-signature). Veja PLAN.md.
function authHeaders(token: string, cookie: string, userAgent: string): Record<string, string> {
  return {
    accept: '*/*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    cookie,
    origin: config.glm.baseUrl,
    referer: `${config.glm.baseUrl}/`,
    'user-agent': userAgent,
    'x-request-id': uuidv4(),
  }
}

// ---------------------------------------------------------------------------
// Stream principal de completion
// ---------------------------------------------------------------------------
// O z.ai renomeia/descontinua ids de modelo periodicamente (ex.: glm-4.6 saiu;
// GLM-4.5 virou 0727-360B-API). O OpenWebUI não sente isso porque lista os
// modelos ao vivo (fetchGLMModels) e o usuário escolhe um id válido. Já clientes
// com o id FIXO no código (AGENTE_TCC, hermes) quebram silenciosamente: o bridge
// força um id morto na requisição e o z.ai devolve stream vazio. Este mapa
// traduz os ids antigos para o sucessor atual. Ajuste conforme o catálogo do
// z.ai evoluir (GET /api/models lista os ids vigentes).
const MODEL_ALIASES: Record<string, string> = {
  'glm-4.6': 'glm-4.7',
  'glm-4.5': '0727-360B-API',
  'glm-4.5-air': '0727-106B-API',
  'glm-4.5v': 'glm-4.6v',
  'glm-4-32b': 'glm-4-air-250414',
}

export async function createGLMStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  accountId?: string,
): Promise<{
  stream: ReadableStream
  headers: Record<string, string>
  uiSessionId: string
  controller: AbortController
  accountId: string
}> {
  let model = modelId.replace('-no-thinking', '')
  const aliased = MODEL_ALIASES[model]
  if (aliased) {
    console.warn(`[GLM] modelo '${model}' descontinuado no z.ai; usando '${aliased}'. Atualize o cliente para um id de GET /v1/models.`)
    model = aliased
  }

  // Anti-bot do z.ai (x-signature + captcha) torna o fetch direto inviável.
  // Usamos a "bridge": o próprio app assina/envia e capturamos o stream SSE.
  // Veja services/playwright.ts:createBridgeStream e PLAN.md.
  const { stream, controller, uiSessionId } = await createBridgeStream(
    prompt,
    enableThinking,
    model,
    accountId,
  )

  return {
    stream,
    headers: {},
    uiSessionId,
    controller,
    accountId: accountId ?? 'global',
  }
}
