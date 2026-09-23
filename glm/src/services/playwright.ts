/*
 * File: playwright.ts
 * Project: glmproxy
 *
 * Automação de navegador para o chat.z.ai (GLM / Zhipu).
 *
 * Estratégia de auth (z.ai é baseado no Open WebUI):
 *   - NÃO interceptamos headers anti-bot (como o bx-ua do Qwen) e NÃO há
 *     Proof-of-Work (como no DeepSeek).
 *   - Guardamos o BEARER TOKEN de auth: preferencialmente "colhido" do header
 *     `authorization` de requisições reais do app (mais confiável), com
 *     fallback para o localStorage (`token`, padrão do Open WebUI).
 *   - Perfis persistentes ficam em `glm_profiles/`.
 *
 * Itens marcados com >>> TODO precisam de confirmação ao vivo (DevTools).
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright'
import path from 'path'
import fs from 'fs'
import { GLMAccount } from '../core/accounts.ts'
import { config } from '../core/config.ts'

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge'

const BASE_URL = config.glm.baseUrl
const PROFILES_DIR = 'glm_profiles'

let context: BrowserContext | null = null
export let activePage: Page | null = null
const accountContexts = new Map<string, BrowserContext>()
const accountPages = new Map<string, Page>()

// Tokens colhidos do header `authorization` de requisições reais do app.
const harvestedTokens = new Map<string, string>()
const harvestAttached = new WeakSet<Page>()

// --- Bridge ---------------------------------------------------------------
// O z.ai exige x-signature (ofuscado, rotativo) + captcha_verify_param para o
// completion. Em vez de replicar isso, deixamos o PRÓPRIO app assinar/enviar:
// injetamos o prompt no textarea, e um hook de window.fetch faz o "tee" do
// stream SSE de /api/v2/chat/completions de volta para o Node via binding.
type BridgeMsg = { t: 'chunk'; d: string } | { t: 'done' } | { t: 'error'; d: string }
const pageSinks = new Map<Page, (msg: BridgeMsg) => void>()
const bridgeInstalled = new WeakSet<BrowserContext>()

/**
 * Erro transitório do stream: o chamador (chat.ts) pode tentar de novo na
 * mesma conta ou rotacionar. Definido aqui (e re-exportado por glm.ts) para
 * o bridge poder lançá-lo sem import circular.
 */
export class RetryableGLMStreamError extends Error {
  readonly retryAfterMs: number
  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'RetryableGLMStreamError'
    this.retryAfterMs = retryAfterMs
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * O z.ai cria um token de CONVIDADO automaticamente (email `guest-...@guest.com`,
 * role `guest`). Login real exige CAPTCHA (feito manualmente, ver manual-login.ts).
 * Esta função distingue um do outro decodificando o JWT.
 */
export function isGuestToken(token: string | null | undefined): boolean {
  if (!token) return true
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    const email = String(payload.email || '')
    return email.includes('guest') || payload.role === 'guest'
  } catch {
    return false // se não der pra decodificar, assume válido
  }
}

async function installBridge(ctx: BrowserContext) {
  if (bridgeInstalled.has(ctx)) return
  bridgeInstalled.add(ctx)

  await ctx.exposeBinding('__glmBridge', (source, msg: BridgeMsg) => {
    const sink = pageSinks.get(source.page)
    if (sink) sink(msg)
  })

  await ctx.addInitScript(() => {
    const w = window as any
    if (w.__glmHooked) return
    w.__glmHooked = true
    const orig = window.fetch
    window.fetch = async (...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
      // Sobrescreve campos NÃO assinados (model/enable_thinking) com os nossos.
      // A assinatura cobre só o prompt (base64) + sortedPayload + timestamp.
      try {
        const ov = w.__glmOverrides
        if (ov && url && /\/api\/(v2\/chat\/completions|v1\/chats\/new)/.test(url) && args[1] && typeof args[1].body === 'string') {
          const b = JSON.parse(args[1].body)
          if (ov.model) {
            if (b.model) b.model = ov.model
            if (Array.isArray(b.models)) b.models = [ov.model]
            if (b.chat && Array.isArray(b.chat.models)) b.chat.models = [ov.model]
          }
          if (typeof ov.enable_thinking === 'boolean') {
            if (b.features) b.features.enable_thinking = ov.enable_thinking
            if ('enable_thinking' in b) b.enable_thinking = ov.enable_thinking
          }
          args[1].body = JSON.stringify(b)
        }
      } catch { /* ignore */ }

      const res = await orig.apply(window, args as any)
      try {
        if (url && url.includes('/api/v2/chat/completions') && res.body) {
          const reader = res.clone().body!.getReader()
          const dec = new TextDecoder()
          ;(async () => {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                w.__glmBridge({ t: 'chunk', d: dec.decode(value, { stream: true }) })
              }
              w.__glmBridge({ t: 'done' })
            } catch (e) {
              w.__glmBridge({ t: 'error', d: String(e) })
            }
          })()
        }
      } catch { /* ignore */ }
      return res
    }
  })
}

/**
 * Dispara um completion deixando o app do z.ai assinar/enviar e devolve um
 * ReadableStream com o SSE cru (mesmo formato do glm-stream.ts).
 */
export async function createBridgeStream(
  prompt: string,
  enableThinking: boolean,
  model: string,
  accountId?: string,
): Promise<{ stream: ReadableStream; controller: AbortController; uiSessionId: string }> {
  // Modo de teste: sem navegador, o completion vira um fetch direto que os
  // testes mockam via globalThis.fetch (mesmo shape SSE do bridge real).
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const controller = new AbortController()
    const res = await fetch(`${BASE_URL}/api/v2/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, model, enable_thinking: enableThinking }),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`Mock completion failed: ${res.status}`)
    }
    return { stream: res.body, controller, uiSessionId: 'mock' }
  }

  let page = accountId ? accountPages.get(accountId) : activePage
  if (accountId && !page) {
    const { getAccountCredentials } = await import('../core/accounts.ts')
    const creds = getAccountCredentials(accountId)
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless)
      page = accountPages.get(accountId)
    }
  }
  if (!page) throw new Error('Playwright não inicializado para a bridge')
  const pg = page

  // Estado limpo: nova conversa a cada request (proxy stateless).
  await pg.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const inputSel = 'textarea, [contenteditable="true"]'
  await pg.waitForSelector(inputSel, { timeout: 30000 })

  // Um sink por página: se uma request anterior ainda está pendurada aqui
  // (stream que nunca recebeu `done`), encerra com erro antes de assumir.
  // O goto acima já matou o reader injetado dela no browser.
  const staleSink = pageSinks.get(pg)
  if (staleSink) {
    pageSinks.delete(pg)
    staleSink({ t: 'error', d: 'superseded by a new request on this page' })
  }

  const controller = new AbortController()
  const firstChunkMs = config.timeouts.streamFirstChunk
  const idleMs = config.timeouts.streamIdle

  let gotFirstChunk = false
  let resolveFirstChunk: (() => void) | undefined
  let rejectFirstChunk: ((e: Error) => void) | undefined
  const firstChunkPromise = new Promise<void>((res, rej) => {
    resolveFirstChunk = res
    rejectFirstChunk = rej
  })
  firstChunkPromise.catch(() => { /* settled via race abaixo; evita unhandled */ })

  let closed = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let mySink: ((msg: BridgeMsg) => void) | null = null
  // substituído pelo `fail` real dentro do start() do ReadableStream (síncrono)
  let failStream: (e: Error) => void = () => {}

  const cleanup = () => {
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    if (mySink && pageSinks.get(pg) === mySink) pageSinks.delete(pg)
  }

  const stream = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()

      const fail = (err: Error) => {
        if (closed) return
        cleanup()
        rejectFirstChunk?.(err)
        try { c.error(err) } catch { /* noop */ }
      }
      failStream = fail

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        if (idleMs > 0) {
          idleTimer = setTimeout(
            () => fail(new RetryableGLMStreamError(`GLM stream idle for ${idleMs}ms (no chunks from upstream)`, 1000)),
            idleMs,
          )
          idleTimer.unref?.()
        }
      }

      const sink = (msg: BridgeMsg) => {
        if (closed) return
        if (msg.t === 'chunk') {
          if (!gotFirstChunk) { gotFirstChunk = true; resolveFirstChunk?.() }
          armIdle()
          try { c.enqueue(enc.encode(msg.d)) } catch { cleanup() }
        } else if (msg.t === 'done') {
          if (!gotFirstChunk) { gotFirstChunk = true; resolveFirstChunk?.() }
          cleanup()
          try { c.close() } catch { /* já fechado */ }
        } else {
          fail(new Error(msg.d))
        }
      }
      mySink = sink
      pageSinks.set(pg, sink)

      controller.signal.addEventListener('abort', () => {
        if (closed) return
        cleanup()
        try { c.close() } catch { /* noop */ }
      })
    },
    cancel() {
      // Consumidor desistiu (finish antecipado / cliente desconectou).
      cleanup()
    },
  })

  // Define overrides e injeta o prompt no textarea (Svelte: value + input event).
  await pg.evaluate(({ p, m, th }) => {
    const w = window as any
    w.__glmOverrides = { model: m, enable_thinking: th }
    const el = (document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]')) as HTMLElement | null
    if (!el) throw new Error('input não encontrado')
    if (el.tagName === 'TEXTAREA') {
      const ta = el as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, p)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      el.textContent = p
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, { p: prompt, m: model, th: enableThinking })

  await sleep(300)
  await pg.focus(inputSel).catch(() => {})
  await pg.keyboard.press('Enter')

  // Aguarda o app realmente disparar o completion. Se nada chegar (CAPTCHA,
  // sessão expirada, botão de envio desabilitado, UI mudou), falha rápido com
  // erro retryable — em vez de devolver um stream que nunca produz dados e
  // pendura o request + o mutex da conta.
  if (firstChunkMs > 0) {
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        firstChunkPromise,
        new Promise<never>((_, rej) => {
          firstChunkTimer = setTimeout(
            () => rej(new RetryableGLMStreamError(`GLM UI did not start streaming within ${firstChunkMs}ms (first chunk timeout)`, 1000)),
            firstChunkMs,
          )
          firstChunkTimer.unref?.()
        }),
      ])
    } catch (err: any) {
      const wrapped = err instanceof RetryableGLMStreamError
        ? err
        // Erro do bridge ANTES de qualquer conteúdo: seguro de repetir.
        : new RetryableGLMStreamError(`GLM bridge failed before first chunk: ${err?.message ?? err}`, 1000)
      failStream(wrapped)
      throw wrapped
    } finally {
      if (firstChunkTimer) clearTimeout(firstChunkTimer)
    }
  }

  return { stream, controller, uiSessionId: '' }
}

/** Liga um listener que captura o Bearer token de qualquer requisição /api/ do app. */
function attachTokenHarvester(page: Page, key: string) {
  if (harvestAttached.has(page)) return
  harvestAttached.add(page)
  page.on('request', (req) => {
    const auth = req.headers()['authorization']
    if (auth && auth.startsWith('Bearer ') && auth.length > 20) {
      harvestedTokens.set(key, auth.slice(7))
    }
  })
}

// ---------------------------------------------------------------------------
// Mutex (idêntico ao do Qwen/DeepSeek — usado pelo chat.ts para serializar por conta)
// ---------------------------------------------------------------------------
export class Mutex {
  private queue: (() => void)[] = []
  private locked = false
  private currentToken: symbol | null = null

  async acquire(timeoutMs = config.timeouts.mutexAcquire): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      const token = Symbol()
      this.currentToken = token
      return () => this.release(token)
    }
    return new Promise<() => void>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const grant = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        const token = Symbol()
        this.currentToken = token
        resolve(() => this.release(token))
      }
      this.queue.push(grant)
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          console.error(`[Mutex] acquire timed out after ${timeoutMs}ms; forcing lock takeover.`)
          const idx = this.queue.indexOf(grant)
          if (idx !== -1) this.queue.splice(idx, 1)
          const token = Symbol()
          this.currentToken = token
          this.locked = true
          resolve(() => this.release(token))
        }, timeoutMs)
      }
    })
  }

  private release(token: symbol): void {
    if (token !== this.currentToken) return
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
      this.currentToken = null
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers de browser engine
// ---------------------------------------------------------------------------
function resolveEngine(browserType: BrowserType): { engine: any; channel?: string } {
  switch (browserType) {
    case 'firefox': return { engine: firefox }
    case 'webkit': return { engine: webkit }
    case 'chrome': return { engine: chromium, channel: 'chrome' }
    case 'edge': return { engine: chromium, channel: 'msedge' }
    case 'chromium':
    default: return { engine: chromium }
  }
}

async function launchContext(profilePath: string, headless: boolean, browserType: BrowserType): Promise<BrowserContext> {
  const { engine, channel } = resolveEngine(browserType)
  const ctx = await engine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    // --no-sandbox / --disable-dev-shm-usage são necessários para rodar o
    // Chromium dentro de containers Docker (usuário não-root, /dev/shm pequeno).
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  })
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  await loadSharedSession(ctx)
  await installBridge(ctx)
  return ctx
}

/**
 * Carrega `glm_session.json` (token + cookies exportados por export-session.ts)
 * em QUALQUER contexto, deixando-o logado sem precisar de login/captcha na
 * máquina destino. É assim que o deploy headless (Docker) roda autenticado:
 * copiar o glm_session.json para o servidor (scp/rsync) -> docker compose up.
 */
let sharedSession: { token: string; cookies: any[]; email?: string } | null | undefined
function getSharedSession() {
  if (sharedSession !== undefined) return sharedSession
  try {
    const p = path.resolve('glm_session.json')
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (s?.token) { sharedSession = { token: s.token, cookies: s.cookies || [], email: s.email }; return sharedSession }
    }
  } catch (e: any) {
    console.warn('[Playwright] glm_session.json inválido:', e.message)
  }
  sharedSession = null
  return sharedSession
}

async function loadSharedSession(ctx: BrowserContext) {
  const s = getSharedSession()
  if (!s) return
  try {
    if (s.cookies?.length) await ctx.addCookies(s.cookies)
  } catch (e: any) {
    console.warn('[Playwright] addCookies falhou:', e.message)
  }
  // Injeta o token no localStorage de chat.z.ai antes do app carregar.
  await ctx.addInitScript((tok) => {
    try {
      if (location.hostname.endsWith('z.ai')) localStorage.setItem('token', tok as string)
    } catch { /* ignore */ }
  }, s.token)
  console.log(`[Playwright] Sessão compartilhada carregada de glm_session.json (${s.email ?? 'token'}).`)
}

// ---------------------------------------------------------------------------
// Auth: extrair o Bearer token do localStorage (Open WebUI usa a chave `token`)
// ---------------------------------------------------------------------------
async function extractTokenFromPage(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      // Open WebUI guarda em localStorage["token"] (string JWT crua).
      const direct = localStorage.getItem('token')
      if (direct && direct.length > 10) {
        try {
          const p = JSON.parse(direct)
          if (typeof p === 'string') return p
          if (p?.value && typeof p.value === 'string') return p.value
          if (p?.token && typeof p.token === 'string') return p.token
        } catch {
          return direct // JWT cru (não-JSON)
        }
      }
      // Varredura genérica por qualquer chave com "token".
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const raw = localStorage.getItem(key)
        if (!raw) continue
        if (/token/i.test(key) && raw.length > 10) {
          try {
            const parsed = JSON.parse(raw)
            if (typeof parsed === 'string') return parsed
            if (parsed?.value && typeof parsed.value === 'string') return parsed.value
            if (parsed?.token && typeof parsed.token === 'string') return parsed.token
          } catch {
            return raw
          }
        }
      }
      return null
    })
  } catch {
    return null
  }
}

async function getCookies(page: Page): Promise<string> {
  const cookies = await page.context().cookies()
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

/**
 * Devolve as credenciais de runtime (token + cookie + UA) para uma conta.
 * Consumido por glm.ts e api/models.ts.
 */
export async function getGLMAuth(accountId?: string): Promise<{ token: string; cookie: string; userAgent: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { token: 'MOCK', cookie: 'token=mock', userAgent: 'mock' }
  }

  // Fallback: sem accountId e sem page global -> roteia para uma conta configurada.
  if (!accountId && !activePage) {
    const { getNextAccount } = await import('../core/account-manager.ts')
    const acc = getNextAccount()
    if (acc && acc.id !== 'global') accountId = acc.id
  }

  let page = accountId ? accountPages.get(accountId) : activePage

  if (accountId && !page) {
    const { getAccountCredentials } = await import('../core/accounts.ts')
    const creds = getAccountCredentials(accountId)
    if (creds) {
      await initPlaywrightForAccount(creds, config.browser.headless)
      page = accountPages.get(accountId)
    }
  }

  if (!page) throw new Error('Playwright não inicializado')

  const key = accountId ?? 'global'
  attachTokenHarvester(page, key)

  // Preferência 1: token já colhido de uma requisição real do app.
  let token: string | null = harvestedTokens.get(key) ?? null
  // Preferência 2: ler do localStorage.
  if (!token) token = await extractTokenFromPage(page)

  // Último recurso: recarrega a home e espera o harvester capturar o token.
  if (!token) {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    for (let i = 0; i < 20; i++) {
      token = harvestedTokens.get(key) ?? await extractTokenFromPage(page)
      if (token) break
      await sleep(1000)
    }
  }

  if (!token) {
    throw new Error(`Token de auth não encontrado para conta ${key}. Faça login (npm run login).`)
  }
  const cookie = await getCookies(page)
  const userAgent = await page.evaluate(() => navigator.userAgent)
  return { token, cookie, userAgent }
}

/** Página viva da conta (caso precise para recon/diagnóstico). */
export function getActivePage(accountId?: string): Page | null {
  if (accountId) return accountPages.get(accountId) ?? null
  return activePage
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
/**
 * Login pela UI do z.ai (preenche o formulário e submete).
 * >>> TODO: confirmar seletores/URL de login ao vivo. z.ai é Open WebUI; a
 * >>> tela costuma estar em /auth com inputs de email + senha.
 */
async function loginWithContext(_ctx: BrowserContext, page: Page, email: string, password: string): Promise<boolean> {
  // Sessão persistida: se o perfil já está logado, reusa (sem refazer login).
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(2000)
  if (await extractTokenFromPage(page)) {
    console.log(`[Playwright] Sessão persistida válida para ${email} (login reusado).`)
    return true
  }

  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[Playwright] Login attempt ${attempt}/${MAX_ATTEMPTS} para ${email}...`)
    const ok = await loginAttempt(page, email, password)
    if (ok) return true
    if (attempt < MAX_ATTEMPTS) await sleep(3000)
  }
  console.error(`[Playwright] Login falhou para ${email} após ${MAX_ATTEMPTS} tentativas.`)
  return false
}

async function loginAttempt(page: Page, email: string, password: string): Promise<boolean> {
  await page.goto(`${BASE_URL}/auth`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(3000)

  if (process.env.DISCOVER) {
    const dom = await page.evaluate(() => ({
      url: location.href,
      bodyText: (document.body?.innerText || '').slice(0, 500),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: (i as HTMLInputElement).type, ph: (i as HTMLInputElement).placeholder })),
      buttons: Array.from(document.querySelectorAll('button, [role="button"], a')).map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 20),
    })).catch((e) => ({ error: e.message } as any))
    console.log('[Playwright][diag-login]', JSON.stringify(dom))
    await page.screenshot({ path: 'diag_login.png', fullPage: true }).catch(() => {})
  }

  // Se /auth redirecionou para o app, já estamos logados.
  if (!page.url().includes('/auth')) {
    console.log('[Playwright] Já autenticado (/auth redirecionou para o app).')
    return true
  }

  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input:not([type="password"])'
  const passSel = 'input[type="password"]'

  try {
    await page.waitForSelector(passSel, { timeout: 25000 })
    await page.fill(emailSel, email)
    await page.fill(passSel, password)

    let clicked = false
    for (const attempt of [
      () => page.getByRole('button', { name: /sign\s*in|log\s*in|entrar/i }).click({ timeout: 4000 }),
      () => page.getByText(/^(Sign in|Log in|Entrar)$/i).click({ timeout: 4000 }),
    ]) {
      try { await attempt(); clicked = true; break } catch { /* próximo */ }
    }
    if (!clicked) {
      await page.focus(passSel)
      await page.keyboard.press('Enter')
    }
    await sleep(5000)
  } catch (e: any) {
    console.error(`[Playwright] Erro no preenchimento do login: ${e.message}`)
  }

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  let token: string | null = null
  for (let i = 0; i < 15; i++) {
    token = await extractTokenFromPage(page)
    if (token) break
    await sleep(1000)
  }

  if (token) {
    console.log(`[Playwright] Login OK para ${email} (token encontrado).`)
    return true
  }
  console.warn(`[Playwright] Tentativa de login não produziu token para ${email}.`)
  return false
}

// ---------------------------------------------------------------------------
// Inicialização (single-account / global)
// ---------------------------------------------------------------------------
export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  if (context) return

  const profilePath = path.resolve(PROFILES_DIR, '_default')
  context = await launchContext(profilePath, headless, browserType)
  activePage = await context.newPage()
  attachTokenHarvester(activePage, 'global')
  await activePage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const email = process.env.GLM_EMAIL
  const password = process.env.GLM_PASSWORD
  const token = await extractTokenFromPage(activePage)

  if (!token && email && password) {
    await loginWithContext(context, activePage, email, password)
  } else if (!token) {
    console.warn('[Playwright] Sem sessão válida e sem credenciais no .env. Login manual necessário.')
  }
}

export async function initPlaywrightForAccount(account: GLMAccount, headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return

  const profilePath = path.resolve(PROFILES_DIR, account.id)
  const ctx = await launchContext(profilePath, headless, browserType)
  const page = await ctx.newPage()
  accountContexts.set(account.id, ctx)
  accountPages.set(account.id, page)
  attachTokenHarvester(page, account.id)

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})

  const token = await extractTokenFromPage(page)
  if (!token && account.email && account.password) {
    await loginWithContext(ctx, page, account.email, account.password)
  }
}

// ---------------------------------------------------------------------------
// Login manual (CLI)
// ---------------------------------------------------------------------------
export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const profilePath = path.resolve(PROFILES_DIR, accountId)
  const ctx = await launchContext(profilePath, false, browserType)
  const page = await ctx.newPage()
  await page.goto(`${BASE_URL}/auth`, { waitUntil: 'domcontentloaded' })
  return { context: ctx, page }
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  // Só considera "logado" um token REAL (não-guest), para o login manual esperar
  // o usuário resolver o CAPTCHA em vez de completar no token de convidado.
  const token = await extractTokenFromPage(page)
  let email: string | null = null
  if (token) {
    try {
      const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
      email = p.email ?? null
    } catch { /* ignore */ }
  }
  return { email, hasSession: !!token && !isGuestToken(token) }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return
  if (context) {
    await context.close()
    context = null
    activePage = null
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId)
  }
}

export async function closePlaywrightForAccount(accountId: string) {
  const ctx = accountContexts.get(accountId)
  if (ctx) {
    await ctx.close()
    accountContexts.delete(accountId)
    accountPages.delete(accountId)
  }
}
