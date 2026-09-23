/*
 * Login manual (uma vez) no perfil da conta MiniMax. Abre um navegador headed,
 * mantém a janela ABERTA para você logar (senha/captcha/Google), e detecta o
 * login de verdade observando cookies/localStorage NOVOS (ignorando analytics).
 * A sessão fica persistida no perfil `minimax_profiles/<accountId>`.
 *
 * Uso: npx tsx src/manual-login.ts          (1ª conta do DB, ou _default)
 *      npx tsx src/manual-login.ts <id>     (perfil específico)
 *      HOLD_MS=600000 npx tsx src/manual-login.ts   (tempo máx. de espera)
 */
import 'dotenv/config'
import path from 'path'
import { chromium } from 'playwright'
import { listAccounts, getAccountCredentials } from './core/accounts.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// chaves de analytics/marketing que NÃO indicam login
const NOISE = /(_uet|_gcl|_ga|_gid|gtm|sawebjssdk|lastExternalReferrer|firstLaunch|drafts|^_fbp$|^_clck$|^_clsk$|hubspot|amplitude|sensorsdata)/i
const looksAuth = (name: string) => /(token|auth|session|sid|access|login|jwt|uid|user|account|mavis.*(token|auth|session|user|login))/i.test(name) && !NOISE.test(name)

async function snapshot(ctx: any, page: any) {
  const cookies = await ctx.cookies().catch(() => [])
  const ls = await page.evaluate(() => {
    const o: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) o[k] = localStorage.getItem(k) ?? '' }
    return o
  }).catch(() => ({} as Record<string, string>))
  return { cookieNames: cookies.map((c: any) => c.name), lsKeys: Object.keys(ls) }
}

async function main() {
  const arg = process.argv[2]
  let accountId = arg
  let email = process.env.MINIMAX_EMAIL || ''
  let password = process.env.MINIMAX_PASSWORD || ''
  const HOLD_MS = parseInt(process.env.HOLD_MS || '600000') // 10 min

  if (!accountId) {
    const accounts = listAccounts()
    if (accounts.length > 0) {
      accountId = accounts[0].id
      const creds = getAccountCredentials(accountId)
      if (creds?.email) email = creds.email
      if (creds?.password && creds.password !== '***') password = creds.password
    } else {
      accountId = '_default'
    }
  }

  console.log(`[manual-login] perfil: minimax_profiles/${accountId}  email: ${email || '(vazio)'}`)
  const profilePath = path.resolve('minimax_profiles', accountId)
  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }))

  const page = await ctx.newPage()
  await page.goto('https://agent.minimax.io/', { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  const base = await snapshot(ctx, page)
  // já há sinal de auth no perfil? (sessão real reaproveitada)
  const authNow = [...base.cookieNames, ...base.lsKeys].filter(looksAuth)
  if (authNow.length) {
    console.log('[manual-login] já logado — sinais de auth encontrados:', authNow)
    await ctx.close(); process.exit(0)
  }

  // best-effort: pré-preencher se houver inputs (não dispara nada)
  try {
    const e = await page.$('input[type="email"], input[name="email"], input[placeholder*="mail" i]')
    if (e && email) { await e.fill(email); console.log('[manual-login] email pré-preenchido.') }
    const p = await page.$('input[type="password"]')
    if (p && password) { await p.fill(password); console.log('[manual-login] senha pré-preenchida.') }
  } catch {}

  console.log('\n========================================================')
  console.log('  >>> FAÇA O LOGIN na janela do Chrome (senha/captcha/Google). <<<')
  console.log(`  A janela fica aberta por até ${Math.round(HOLD_MS / 60000)} min.`)
  console.log('  Vou detectar automaticamente quando a sessão aparecer.')
  console.log('========================================================\n')

  const baseSet = new Set([...base.cookieNames, ...base.lsKeys])
  let ok = false
  const start = Date.now()
  while (Date.now() - start < HOLD_MS) {
    await sleep(3000)
    const snap = await snapshot(ctx, page)
    const fresh = [...snap.cookieNames, ...snap.lsKeys].filter(k => !baseSet.has(k))
    const authFresh = fresh.filter(looksAuth)
    if (authFresh.length) {
      console.log('\n[manual-login] ✅ LOGIN detectado! Novos sinais de auth:', authFresh)
      console.log('[manual-login] todas as chaves novas:', fresh)
      ok = true
      await sleep(2000) // deixa o profile gravar
      break
    }
  }

  if (!ok) {
    const snap = await snapshot(ctx, page)
    console.log('\n[manual-login] ⏱️ encerrando. Estado final:')
    console.log('  cookies:', snap.cookieNames)
    console.log('  localStorage:', snap.lsKeys)
    console.log('  (se você logou mas não detectei, me mande essas listas para ajustar o detector)')
  }

  await ctx.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('[manual-login] ERRO:', e); process.exit(1) })
