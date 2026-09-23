import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'

const app = new Hono()

let cache: MemoryCache
let watchdog: Watchdog
let server: any

// Middlewares ANTES das rotas: no Hono, um handler registrado antes do
// middleware responde sem passar por ele — com a ordem antiga, a proteção de
// API key e as métricas de latência simplesmente não rodavam para /v1/*.
app.use('*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    if (token !== apiKey) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  const { getBrowserHealth } = await import('../services/playwright.js')
  const browser = await getBrowserHealth().catch(() => ({ browser: 'down' as const, loggedIn: 'unknown' as const, accounts: {} }))
  const { getCooldownStatus } = await import('../core/account-manager.ts')
  // O navegador é o que de fato serve requests: se está down ou deslogado, o
  // serviço está unhealthy mesmo que RAM/streams estejam ok.
  const overall = browser.browser === 'down' || browser.loggedIn === false
    ? 'unhealthy'
    : (status?.overall || 'unknown')
  return c.json({
    status: overall,
    browser,
    cooldowns: getCooldownStatus(),
    timestamp: Date.now(),
    metrics: {
      cache: await cache?.getStats(),
    },
  })
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

export async function startServer(): Promise<void> {
  cache = new MemoryCache()
  await cache.connect()

  const { loadAccounts, addAccount, getEnvAccounts } = await import('../core/accounts.ts')
  let accounts = loadAccounts()

  // Auto-cadastro: o roteador de chat só funciona com contas no banco. Se o
  // banco está vazio (deploy novo / volume `data` zerado) mas há credenciais
  // no .env, registra TODAS as contas configuradas (acc1, acc2, ...) — assim o
  // pré-aquecimento abaixo já cria o perfil/login de cada uma e o chat funciona
  // sem rodar o login.ts à mão. Ids FIXOS (acc1, acc2...) em vez de UUID para
  // que cada perfil em qwen_profiles/<id>/ seja previsível entre restarts.
  if (accounts.length === 0) {
    for (const a of getEnvAccounts()) {
      try {
        const acc = addAccount(a.email, a.password, a.id)
        console.log(`[Server] No accounts in DB — auto-registered ${acc.email} from .env (id: ${acc.id})`)
      } catch (err: any) {
        console.error(`[Server] Failed to auto-register ${a.email} from .env:`, err.message)
      }
    }
    accounts = loadAccounts()
  }

  if (accounts.length > 0) {
    console.log(`[Server] Pre-warming ${accounts.length} configured account(s)...`)
    const { initPlaywrightForAccount } = await import('../services/playwright.ts')
    for (const account of accounts) {
      try {
        await initPlaywrightForAccount(account, config.browser.headless)
      } catch (err: any) {
        console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
      }
    }
  } else {
    const { initPlaywright } = await import('../services/playwright.ts')
    await initPlaywright(config.browser.headless)
  }

  watchdog = new Watchdog()
  watchdog.start()

  metrics.startCollection()

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    console.log(`Server listening on http://${info.address}:${info.port}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`)
    watchdog.stop()
    metrics.stopCollection()
    await cache.close()
    const { closePlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const { closeDatabase } = await import('../core/database.ts')
    closeDatabase()
    server?.close()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
