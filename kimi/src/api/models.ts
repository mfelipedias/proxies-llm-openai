/*
 * models.ts — Lista de modelos OpenAI-compatível do proxy Kimi.
 *
 * Estática (derivada de ConfigService/GetAvailableModels na recon). O kimi não
 * expõe os modelos num /api/models REST simples; os "scenarios" reais são
 * mapeados em services/kimi.ts. Expomos ids amigáveis ao cliente OpenAI.
 */
import { Hono } from 'hono'

const app = new Hono()

const MODELS = [
  { id: 'kimi-k2.6', context_window: 131072 },
  { id: 'kimi-k2.6-thinking', context_window: 131072 },
]

function toModel(m: { id: string; context_window: number }) {
  return {
    id: m.id,
    name: m.id,
    object: 'model',
    owned_by: 'moonshot',
    created: 1700000000,
    context_window: m.context_window,
  }
}

app.get('/v1/models', (c) => c.json({ object: 'list', data: MODELS.map(toModel) }))

app.get('/v1/models/:model', (c) => {
  const id = c.req.param('model')
  const m = MODELS.find((x) => x.id === id)
  if (!m) return c.json({ error: 'Model not found' }, 404)
  return c.json(toModel(m))
})

export { app }
