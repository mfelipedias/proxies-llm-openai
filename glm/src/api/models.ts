import { Hono } from 'hono'
import { fetchGLMModels } from '../services/glm.js'
import { getModelContextWindow } from '../core/model-registry.js'

const app = new Hono()

// O chat.z.ai (Open WebUI) expõe um catálogo dinâmico em GET /api/models.
// fetchGLMModels() faz o fetch autenticado (Bearer) e adiciona as variantes
// `-no-thinking`.
app.get('/v1/models', async (c) => {
  try {
    const models = await fetchGLMModels()
    const formatted = {
      object: 'list',
      data: models.map((model: any) => ({
        id: model.id,
        name: model.id,
        object: 'model',
        owned_by: model.owned_by,
        created: model.created,
        context_window: model.context_window ?? getModelContextWindow(model.id),
      })),
    }
    return c.json(formatted)
  } catch (error: any) {
    console.error('Error fetching models:', error)
    return c.json({ error: error.message }, 500)
  }
})

app.get('/v1/models/:model', async (c) => {
  try {
    const modelId = c.req.param('model')
    const baseModelId = modelId.replace('-no-thinking', '')
    const models = await fetchGLMModels()
    const model = models.find((m: any) => m.id === baseModelId || m.id === modelId)

    if (!model) {
      return c.json({ error: 'Model not found' }, 404)
    }

    return c.json({
      id: modelId,
      name: modelId,
      object: 'model',
      owned_by: model.owned_by,
      created: model.created,
      context_window: model.context_window ?? getModelContextWindow(baseModelId),
    })
  } catch (error: any) {
    console.error('Error fetching model:', error)
    return c.json({ error: error.message }, 500)
  }
})

export { app }
