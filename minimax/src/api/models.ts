import { Hono } from 'hono'
import { fetchMinimaxModels, MINIMAX_MODELS } from '../services/minimax.ts'

const app = new Hono()

app.get('/v1/models', async (c) => {
  try {
    const models = await fetchMinimaxModels()
    return c.json({
      object: 'list',
      data: models.map((m: any) => ({
        id: m.id,
        name: m.id,
        object: 'model',
        owned_by: 'minimax',
        created: m.created,
        context_window: m.context_window,
      })),
    })
  } catch (error: any) {
    console.error('Error fetching models:', error)
    return c.json({ error: error.message }, 500)
  }
})

app.get('/v1/models/:model', async (c) => {
  const modelId = c.req.param('model')
  const base = modelId.replace('-no-thinking', '')
  const m = MINIMAX_MODELS.find(x => x.id === base)
  if (!m) return c.json({ error: 'Model not found' }, 404)
  return c.json({
    id: modelId,
    name: modelId,
    object: 'model',
    owned_by: 'minimax',
    created: Math.floor(Date.now() / 1000),
    context_window: m.context_limit,
  })
})

export { app }
