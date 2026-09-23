/*
 * File: playwright.ts
 * Project: deepseekproxy
 *
 * Automação de navegador para o chat.deepseek.com.
 *
 * Diferenças-chave vs. a versão do Qwen:
 *   - Não interceptamos headers anti-bot (`bx-ua` etc.). Em vez disso,
 *     guardamos o BEARER TOKEN de auth (extraído do localStorage após login)
 *     e mantemos a página viva para resolver o Proof-of-Work por requisição
 *     (ver pow.ts / deepseek.ts).
 *   - Perfis persistentes ficam em `deepseek_profiles/`.
 *
 * Itens marcados com >>> TODO precisam de confirmação ao vivo (DevTools).
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright'
import path from 'path'
import fs from 'fs'
import { DeepSeekAccount } from '../core/accounts.ts'
import { config } from '../core/config.ts'

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge'

const BASE_URL = config.deepseek.baseUrl
const PROFILES_DIR = 'deepseek_profiles'

let context: BrowserContext | null = null
export let activePage: Page | null = null
const accountContexts = new Map<string, BrowserContext>()
const accountPages = new Map<string, Page>()

// Tokens colhidos do header `authorization` de requisições reais do app.
// Mais confiável que ler o localStorage (que o app limpa/reescreve async).
const harvestedTokens = new Map<string, string>()
const harvestAttached = new WeakSet<Page>()

// Último token REJEITADO pelo upstream (401/403) por conta. Evita devolver de
// novo o mesmo token expirado lido do localStorage (que pode continuar lá até
// o app renová-lo).
const invalidTokens = new Map<string, string>()

/**
 * Marca um Bearer token como rejeitado pelo upstream. O próximo
 * getDeepSeekAuth({forceRefresh:true}) recarrega a página e re-colhe.
 */
export function invalidateAuthToken(accountId: string | undefined, token: string): void {
  const key = accountId ?? 'global'
  invalidTokens.set(key, token)
  if (harvestedTokens.get(key) === token) harvestedTokens.delete(key)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
// Mutex (idêntico ao do Qwen — usado pelo chat.ts para serializar por conta)
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

/**
 * Remove arquivos de lock órfãos (`SingletonLock`, `SingletonCookie`,
 * `SingletonSocket`) de um profile persistente.
 *
 * Quando o processo Node reinicia/crasha sem fechar o Chromium, o profile fica
 * com um `SingletonLock` apontando para um pid/hostname antigo. Na próxima
 * tentativa de abrir o MESMO profile, o Chromium recusa com:
 *   "The profile appears to be in use by another Chromium process ... on
 *    another computer". Limpar esses arquivos destrava o profile.
 *
 * Só é seguro chamar quando NÃO há um Chromium vivo usando o profile (i.e.
 * antes da primeira abertura no boot, ou após uma falha de launch por lock).
 */
function clearProfileLocks(profilePath: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(profilePath, name), { force: true })
    } catch { /* arquivo pode não existir — ok */ }
  }
}

/** Heurística: o erro de launch foi causado por lock órfão do profile? */
function isProfileLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /profile appears to be in use|SingletonLock|ProcessSingleton|locked the profile/i.test(msg)
}

async function launchContext(profilePath: string, headless: boolean, browserType: BrowserType): Promise<BrowserContext> {
  const { engine, channel } = resolveEngine(browserType)
  const opts = {
    headless,
    channel,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  }

  let ctx: BrowserContext
  try {
    ctx = await engine.launchPersistentContext(profilePath, opts)
  } catch (err) {
    if (!isProfileLockError(err)) throw err
    // Lock órfão de um Chromium anterior que não foi fechado. Limpa e retenta.
    console.warn(`[Playwright] Profile ${profilePath} travado por lock órfão; limpando e tentando novamente.`)
    clearProfileLocks(profilePath)
    ctx = await engine.launchPersistentContext(profilePath, opts)
  }

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  return ctx
}

// ---------------------------------------------------------------------------
// Auth: extrair o Bearer token do localStorage
// ---------------------------------------------------------------------------
/**
 * >>> TODO: confirmar a chave do localStorage onde o DeepSeek guarda o token.
 * >>> Tipicamente algo como `userToken` (JSON com { value, __version }).
 */
async function extractTokenFromPage(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      // Procura recursiva por uma propriedade "token" em qualquer valor do localStorage.
      const findToken = (v: any): string | null => {
        if (!v) return null
        if (typeof v === 'object') {
          if (typeof v.token === 'string' && v.token.length > 10) return v.token
          for (const k of Object.keys(v)) {
            const r = findToken(v[k])
            if (r) return r
          }
        }
        return null
      }
      // Chave confirmada ao vivo: `userToken` = {"value":"<token>","__version":"0"}
      const direct = localStorage.getItem('userToken')
      if (direct) {
        try {
          const p = JSON.parse(direct)
          if (p?.value && typeof p.value === 'string') return p.value
        } catch { /* segue para varredura */ }
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!
        const raw = localStorage.getItem(key)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw)
          const t = findToken(parsed)
          if (t) return t
          // chave com "token" no nome guardando {value:"..."}
          if (/token/i.test(key) && parsed?.value && typeof parsed.value === 'string' && parsed.value.length > 10) return parsed.value
          if (typeof parsed === 'string' && /token/i.test(key) && parsed.length > 10) return parsed
        } catch {
          if (/token/i.test(key) && raw.length > 10) return raw
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
 * Consumido por deepseek.ts.
 */
export async function getDeepSeekAuth(
  accountId?: string,
  opts?: { forceRefresh?: boolean },
): Promise<{ token: string; cookie: string; userAgent: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    return { token: 'MOCK', cookie: 'token=mock', userAgent: 'mock' }
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

  const badToken = invalidTokens.get(key)
  let token: string | null = null

  if (opts?.forceRefresh) {
    // Re-auth após 401/403: o token atual está morto. Recarrega a home para o
    // app renovar token/cookies (inclusive aws-waf-token) e re-colhe do
    // tráfego real. localStorage só serve aqui se mudou em relação ao morto.
    harvestedTokens.delete(key)
  } else {
    // Preferência 1: token já colhido de uma requisição real do app.
    token = harvestedTokens.get(key) ?? null

    // Preferência 2: ler do localStorage (rejeita o token sabidamente morto).
    if (!token) {
      const fromLs = await extractTokenFromPage(page)
      if (fromLs && fromLs !== badToken) token = fromLs
    }
  }

  // Se ainda não temos, força o app a fazer requisições (recarrega a home) e
  // espera o harvester capturar o Bearer token. Cobre o caso do localStorage
  // ser limpo/reescrito async pelo app.
  if (!token) {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    for (let i = 0; i < 20; i++) {
      // Token colhido do tráfego do app é aceito mesmo se igual ao "morto":
      // se o app segue usando-o após reload, o 401 era de cookie/WAF — e os
      // cookies acabaram de ser renovados pela navegação.
      token = harvestedTokens.get(key) ?? null
      if (!token) {
        const fromLs = await extractTokenFromPage(page)
        if (fromLs && fromLs !== badToken) token = fromLs
      }
      if (token) break
      await sleep(1000)
    }
  }

  // Último recurso no re-auth: sessão morta de verdade — refaz o login.
  if (!token && opts?.forceRefresh) {
    const { getAccountCredentials } = await import('../core/accounts.ts')
    const creds = accountId ? getAccountCredentials(accountId) : (
      process.env.DEEPSEEK_EMAIL && process.env.DEEPSEEK_PASSWORD
        ? { id: 'global', email: process.env.DEEPSEEK_EMAIL, password: process.env.DEEPSEEK_PASSWORD }
        : undefined
    )
    if (creds?.email && creds?.password) {
      console.warn(`[Playwright] Sessão expirada para ${key}; refazendo login.`)
      const ok = await loginWithContext(page.context(), page, creds.email, creds.password)
      if (ok) token = harvestedTokens.get(key) ?? await extractTokenFromPage(page)
    }
  }

  if (!token) {
    throw new Error(`Token de auth não encontrado para conta ${key}. Faça login (npm run login).`)
  }
  if (invalidTokens.get(key) && token !== invalidTokens.get(key)) invalidTokens.delete(key)
  const cookie = await getCookies(page)
  const userAgent = await page.evaluate(() => navigator.userAgent)
  return { token, cookie, userAgent }
}

/**
 * Snapshot do estado de autenticação por conta, para o /health.
 * `hasToken` = token disponível (colhido ou no localStorage); `pageAlive` =
 * página do Playwright aberta; `tokenInvalidated` = último token foi rejeitado
 * pelo upstream e ainda não foi renovado.
 */
export async function getAuthStatus(): Promise<Record<string, { pageAlive: boolean; hasToken: boolean; tokenInvalidated: boolean }>> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return {}
  const out: Record<string, { pageAlive: boolean; hasToken: boolean; tokenInvalidated: boolean }> = {}
  const entries: Array<[string, Page]> = accountPages.size > 0
    ? [...accountPages.entries()]
    : (activePage ? [['global', activePage] as [string, Page]] : [])
  for (const [id, page] of entries) {
    const alive = !page.isClosed()
    let token: string | null = harvestedTokens.get(id) ?? null
    if (!token && alive) token = await extractTokenFromPage(page)
    out[id] = {
      pageAlive: alive,
      hasToken: !!token && token !== invalidTokens.get(id),
      tokenInvalidated: invalidTokens.has(id),
    }
  }
  return out
}

/** Página viva da conta — usada pelo solver de PoW no browser. */
export function getActivePage(accountId?: string): Page | null {
  if (accountId) return accountPages.get(accountId) ?? null
  return activePage
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
/**
 * Login pela UI do DeepSeek (preenche o formulário e submete).
 * Mais robusto que chamar a API direto: o próprio app guarda o token no
 * formato/chave que ele espera e carrega o app autenticado (que traz o WASM
 * do PoW). O cookie `aws-waf-token` também é estabelecido corretamente.
 */
async function loginWithContext(ctx: BrowserContext, page: Page, email: string, password: string): Promise<boolean> {
  // Sessão persistida: se o perfil já está logado, reusa (sem refazer login).
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(2000)
  if (await extractTokenFromPage(page)) {
    console.log(`[Playwright] Sessão persistida válida para ${email} (login reusado).`)
    return true
  }

  // Retry: o AWS WAF é instável em headless; tenta algumas vezes.
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
  await page.goto(`${BASE_URL}/sign_in`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(4000) // SPA + AWS WAF precisam assentar

  // Diagnóstico do que a página mostra (DISCOVER_POW=1).
  if (process.env.DISCOVER_POW) {
    const dom = await page.evaluate(() => ({
      url: location.href,
      bodyText: (document.body?.innerText || '').slice(0, 500),
      inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: (i as HTMLInputElement).type, ph: (i as HTMLInputElement).placeholder })),
      buttons: Array.from(document.querySelectorAll('button, [role="button"], a')).map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 20),
    })).catch((e) => ({ error: e.message } as any))
    console.log('[Playwright][diag-login]', JSON.stringify(dom))
    await page.screenshot({ path: 'diag_login.png', fullPage: true }).catch(() => {})
  }

  // Se o /sign_in redirecionou para o app, já estamos logados (sessão válida).
  if (!page.url().includes('sign_in')) {
    console.log('[Playwright] Já autenticado (sign_in redirecionou para o app).')
    return true
  }

  // O form de /sign_in já tem email + senha diretamente (sem aba "password").
  const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="mail" i], input[placeholder*="phone" i], input:not([type="password"])'
  const passSel = 'input[type="password"]'

  try {
    await page.waitForSelector(passSel, { timeout: 25000 })
    await page.fill(emailSel, email)
    await page.fill(passSel, password)

    // Checkbox de "concordo com os termos", se existir (costuma ser obrigatório).
    const cb = await page.$('input[type="checkbox"], .ds-checkbox, [class*="checkbox"]')
    if (cb) await cb.click({ force: true }).catch(() => {})

    // Botão de login: tenta por texto e por seletores comuns.
    let clicked = false
    for (const attempt of [
      () => page.getByRole('button', { name: /log\s*in/i }).click({ timeout: 4000 }),
      () => page.getByText(/^Log in$/i).click({ timeout: 4000 }),
      () => page.click('div[role="button"]:has-text("Log in")', { timeout: 4000 }),
    ]) {
      try { await attempt(); clicked = true; break } catch { /* próximo */ }
    }
    if (!clicked) {
      await page.focus(passSel)
      await page.keyboard.press('Enter')
    }
    await sleep(5000) // espera o app autenticar e redirecionar
  } catch (e: any) {
    console.error(`[Playwright] Erro no preenchimento do login: ${e.message}`)
  }

  // O token só é persistido no localStorage quando o app carrega a home.
  // Navega para '/' e faz polling até o token aparecer.
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  let token: string | null = null
  for (let i = 0; i < 15; i++) {
    token = await extractTokenFromPage(page)
    if (token) break
    await sleep(1000)
  }

  if (process.env.DISCOVER_POW) {
    const ls = await page.evaluate(() => Object.keys(localStorage)).catch(() => [])
    console.log(`[Playwright][diag-ls] url=${page.url()} keys=${JSON.stringify(ls)}`)
  }

  if (token) {
    console.log(`[Playwright] Login OK para ${email} (token encontrado no localStorage).`)
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

  const email = process.env.DEEPSEEK_EMAIL
  const password = process.env.DEEPSEEK_PASSWORD
  const token = await extractTokenFromPage(activePage)

  if (!token && email && password) {
    await loginWithContext(context, activePage, email, password)
  } else if (!token) {
    console.warn('[Playwright] Sem sessão válida e sem credenciais no .env. Login manual necessário.')
  }

  if (process.env.DISCOVER_POW) {
    await discoverPowSolver(activePage)
  }
}

/**
 * Sonda de descoberta do solver de PoW: lista recursos .wasm carregados,
 * tenta instanciar o wasm para listar exports, e procura funções globais.
 * Rode com DISCOVER_POW=1. Resultado guia a implementação de pow.ts.
 */
async function discoverPowSolver(page: Page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(5000)

  // Captura em nível de CONTEXTO (pega tráfego de service/web workers também).
  const ctx = page.context()
  ctx.on('response', async (resp) => {
    const u = resp.url()
    if (/\.wasm/i.test(u)) {
      console.log(`[diag-pow][WASM] ${u}`)
    }
    if (/pow|challenge/i.test(u)) {
      let body = ''
      try { body = await resp.text() } catch (e: any) { body = `<err:${e.message}>` }
      console.log(`[diag-pow][challenge-resp] url=${u} status=${resp.status()} body=${body.slice(0, 700)}`)
    }
  })
  page.on('request', (req) => {
    if (req.url().includes('/api/v0/chat/completion')) {
      const h = req.headers()
      console.log('[diag-pow][completion-headers]', JSON.stringify({
        'x-ds-pow-response': h['x-ds-pow-response'],
        'x-app-version': h['x-app-version'],
        'x-client-version': h['x-client-version'],
        'x-client-platform': h['x-client-platform'],
        authorization: h['authorization'] ? h['authorization'].slice(0, 20) + '...' : undefined,
      }))
      try { console.log('[diag-pow][completion-body]', (req.postData() || '').slice(0, 500)) } catch {}
    }
  })

  // Envia uma mensagem real pela UI para disparar o pow + carregar o wasm.
  try {
    const inputSel = 'textarea, [contenteditable="true"]'
    await page.waitForSelector(inputSel, { timeout: 15000 })
    await page.fill('textarea', 'oi').catch(async () => {
      await page.click('[contenteditable="true"]'); await page.keyboard.type('oi')
    })
    await sleep(800)
    await page.keyboard.press('Enter')
    await sleep(8000) // deixa a requisição acontecer e ser interceptada
  } catch (e: any) {
    console.log('[diag-pow] erro ao enviar msg de teste:', e.message)
  }

  const info = await page.evaluate(async () => {
    const out: any = {}
    out.url = location.href
    out.wasmResources = performance.getEntriesByType('resource')
      .map((r: any) => r.name)
      .filter((n: string) => n.includes('.wasm'))
    if (out.wasmResources.length) {
      try {
        const resp = await fetch(out.wasmResources[0])
        const mod = await WebAssembly.compile(await resp.arrayBuffer())
        out.wasmExports = WebAssembly.Module.exports(mod).map((e: any) => `${e.name}:${e.kind}`)
      } catch (e: any) { out.wasmError = e.message }
    }
    return out
  }).catch((e) => ({ error: e.message } as any))
  console.log('[Playwright][diag-pow]', JSON.stringify(info))
}

export async function initPlaywrightForAccount(account: DeepSeekAccount, headless = true, browserType: BrowserType = 'chromium') {
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
  await page.goto(`${BASE_URL}/sign_in`, { waitUntil: 'domcontentloaded' })
  return { context: ctx, page }
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  const token = await extractTokenFromPage(page)
  return { email: null, hasSession: !!token }
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
