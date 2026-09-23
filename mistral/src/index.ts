import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

// ==================================================================
// SCAFFOLD — Proxy Mistral Le Chat (chat.mistral.ai) — porta 3005
// Implementação pendente. Roteiro completo em ../PLAN.md.
// Este stub sobe o servidor com os endpoints padrão do projeto
// respondendo de forma honesta (501) até a implementação real.
// ==================================================================

const PORT = Number(process.env.PORT ?? 3005)

const app = new Hono()

app.get('/health', c =>
  c.json({
    status: 'scaffold',
    platform: 'chat.mistral.ai',
    loggedIn: false,
    accounts: [],
    message: 'Proxy Mistral ainda não implementado — veja mistral/PLAN.md',
  })
)

app.get('/v1/models', c => c.json({ object: 'list', data: [] }))

app.get('/metrics', c => c.text('# mistral-proxy scaffold — sem métricas ainda\n'))

app.post('/v1/chat/completions', c =>
  c.json(
    {
      error: {
        message: 'Proxy Mistral é um scaffold — implementação pendente. Veja mistral/PLAN.md.',
        type: 'not_implemented',
        code: 'scaffold',
      },
    },
    501
  )
)

app.post('/v1/chat/completions/stop', c =>
  c.json({ error: { message: 'Not implemented (scaffold)', type: 'not_implemented' } }, 501)
)

serve({ fetch: app.fetch, port: PORT })
console.log(`[mistral-proxy] SCAFFOLD ouvindo em http://localhost:${PORT} — implementação pendente (veja PLAN.md)`)
