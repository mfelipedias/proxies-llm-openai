import { Hono } from 'hono'
import { fetchDeepSeekModels } from '../services/deepseek.js'
import { getModelContextWindow } from '../core/model-registry.js'

const app = new Hono()

// O chat web do DeepSeek não expõe um catálogo de modelos como o Qwen.
// Servimos a lista estática definida em deepseek.ts / model-registry.ts.
app.get('/v1/models', async (c) => {
  try {
    const models = await fetchDeepSeekModels()
    const formatted = {
      object: 'list',
      data: models.map((model: any) => ({
        id: model.id,
        name: model.id,
        object: 'model',
        owned_by: model.owned_by,
        created: model.created,
        context_window: getModelContextWindow(model.id),
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
    const models = await fetchDeepSeekModels()
    const model = models.find((m: any) => m.id === baseModelId)

    if (!model) {
      return c.json({ error: 'Model not found' }, 404)
    }

    return c.json({
      id: modelId,
      name: modelId,
      object: 'model',
      owned_by: model.owned_by,
      created: model.created,
      context_window: getModelContextWindow(baseModelId),
    })
  } catch (error: any) {
    console.error('Error fetching model:', error)
    return c.json({ error: error.message }, 500)
  }
})

export { app }
