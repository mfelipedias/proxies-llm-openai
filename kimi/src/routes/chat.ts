/*
 * chat.ts — Endpoint OpenAI-compatível /v1/chat/completions para o kimi.
 *
 * Caminho enxuto (API direta): delega a tradução para services/kimi.ts e
 * formata a saída como `chat.completion.chunk` (streaming SSE) ou um objeto
 * `chat.completion` único. Tool-calling e multi-conta ficam para fases futuras.
 */
import { Context } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import { v4 as uuidv4 } from 'uuid'
import { streamKimiChat } from '../services/kimi.ts'
import type { OpenAIRequest, ChatCompletionChunk } from '../utils/types.ts'
import { metrics } from '../core/metrics.js'

function chunk(id: string, model: string, delta: any, finish: string | null = null): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export async function chatCompletions(c: Context): Promise<Response> {
  let body: OpenAIRequest
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { message: 'JSON inválido no corpo da requisição', type: 'invalid_request_error' } }, 400)
  }

  if (!body?.messages?.length) {
    return c.json({ error: { message: '`messages` é obrigatório', type: 'invalid_request_error' } }, 400)
  }

  const model = body.model || 'kimi-k2.6'
  const id = `chatcmpl-${uuidv4()}`
  const wantStream = body.stream !== false
  metrics.increment('chat.requests')

  // ---- Streaming (SSE) ----
  if (wantStream) {
    return honoStream(c, async (s) => {
      const send = (obj: unknown) => s.write(`data: ${JSON.stringify(obj)}\n\n`)
      try {
        await send(chunk(id, model, { role: 'assistant' }))
        let any = false
        for await (const ev of streamKimiChat({ messages: body.messages, model, signal: c.req.raw.signal })) {
          if (ev.kind === 'text') { any = true; await send(chunk(id, model, { content: ev.delta })) }
          else if (ev.kind === 'reasoning') { await send(chunk(id, model, { reasoning_content: ev.delta })) }
        }
        await send(chunk(id, model, {}, 'stop'))
        await s.write('data: [DONE]\n\n')
        metrics.increment(any ? 'chat.ok' : 'chat.empty')
      } catch (err: any) {
        metrics.increment('chat.errors')
        await send(chunk(id, model, { content: `\n[erro: ${err.message}]` }, 'stop'))
        await s.write('data: [DONE]\n\n')
      }
    })
  }

  // ---- Não-streaming (agrega) ----
  try {
    let text = ''
    let reasoning = ''
    for await (const ev of streamKimiChat({ messages: body.messages, model, signal: c.req.raw.signal })) {
      if (ev.kind === 'text') text += ev.delta
      else if (ev.kind === 'reasoning') reasoning += ev.delta
    }
    metrics.increment('chat.ok')
    return c.json({
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  } catch (err: any) {
    metrics.increment('chat.errors')
    return c.json({ error: { message: err.message, type: 'upstream_error' } }, 502)
  }
}

/**
 * Stop: como cada request é um fetch independente (stateless), o cancelamento
 * acontece quando o cliente desconecta (AbortSignal). Mantido para paridade com
 * a API OpenAI/clientes que chamam este endpoint.
 */
export async function chatCompletionsStop(c: Context): Promise<Response> {
  return c.json({ ok: true })
}
