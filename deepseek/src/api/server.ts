import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { config } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { MemoryCache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'

const app = new Hono()
app.route('', modelsApp)
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)

let cache: MemoryCache
let watchdog: Watchdog
let server: any

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

app.get('/health', async (c) => {
  const status = await watchdog?.getStatus()
  // Estado real de autenticação por conta: sem isto o /health reportava
  // "healthy" mesmo com token expirado (serviço de pé, mas inútil).
  const { getAuthStatus } = await import('../services/playwright.js')
  const { getCooldownStatus } = await import('../core/account-manager.js')
  const auth = await getAuthStatus().catch(() => ({} as Record<string, never>))
  const accounts = Object.entries(auth)
  const authOk = accounts.length === 0 || accounts.some(([, a]) => a.hasToken)
  let overall = status?.overall || 'unknown'
  if (!authOk && overall !== 'unhealthy') overall = 'degraded'
  return c.json({
    status: overall,
    timestamp: Date.now(),
    auth,
    cooldowns: getCooldownStatus(),
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

  const { loadAccounts, addAccount } = await import('../core/accounts.ts')
  let accounts = loadAccounts()

  // Conveniência: se não há contas no DB mas há credenciais no .env, cadastra
  // automaticamente (deixa o `docker compose up` turnkey, sem `npm run login`).
  if (accounts.length === 0 && process.env.DEEPSEEK_EMAIL && process.env.DEEPSEEK_PASSWORD) {
    try {
      addAccount(process.env.DEEPSEEK_EMAIL, process.env.DEEPSEEK_PASSWORD)
      console.log(`[Server] Conta do .env cadastrada automaticamente: ${process.env.DEEPSEEK_EMAIL}`)
      accounts = loadAccounts()
    } catch (err: any) {
      console.error('[Server] Falha ao auto-cadastrar conta do .env:', err.message)
    }
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
