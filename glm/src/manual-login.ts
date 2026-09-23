/*
 * Login manual (uma vez) no perfil da conta. Pré-preenche email/senha e abre o
 * captcha; você resolve à mão. A sessão (token real) fica persistida no perfil
 * `glm_profiles/<accountId>` e o servidor passa a rodar logado.
 *
 * Uso: npx tsx src/manual-login.ts          (usa a 1ª conta do DB)
 *      npx tsx src/manual-login.ts <id>     (perfil específico, ex: _default)
 */
import 'dotenv/config'
import path from 'path'
import { chromium } from 'playwright'
import { listAccounts, getAccountCredentials } from './core/accounts.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function decodeJwt(t: string): any { try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) } catch { return null } }

async function main() {
  const arg = process.argv[2]
  let accountId = arg
  let email = process.env.GLM_EMAIL || ''
  let password = process.env.GLM_PASSWORD || ''

  if (!accountId) {
    const accounts = listAccounts()
    if (accounts.length === 0) { console.error('Nenhuma conta no DB. Rode npm run login (Add) primeiro.'); process.exit(1) }
    accountId = accounts[0].id
    const creds = getAccountCredentials(accountId)
    if (creds?.email) email = creds.email
    if (creds?.password && creds.password !== '***') password = creds.password
  }

  console.log(`[manual-login] perfil: glm_profiles/${accountId}  email: ${email || '(vazio)'}`)
  const profilePath = path.resolve('glm_profiles', accountId)
  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }))

  const page = await ctx.newPage()
  await page.goto('https://chat.z.ai/auth', { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  // já logado (real)?
  const cur = await page.evaluate(() => localStorage.getItem('token'))
  if (cur && !String(decodeJwt(cur)?.email || '').includes('guest')) {
    console.log('[manual-login] já está logado (token real):', decodeJwt(cur)?.email)
    await ctx.close(); process.exit(0)
  }

  // abre o form de email e pré-preenche
  try { await page.getByText(/Continue with Email/i).click({ timeout: 6000 }) } catch {}
  await sleep(1500)
  try {
    if (email) await page.fill('input[type="email"]', email)
    if (password) await page.fill('input[type="password"]', password)
    console.log('[manual-login] credenciais pré-preenchidas.')
  } catch (e: any) { console.log('[manual-login] não consegui pré-preencher:', e.message) }
  // dispara o widget de verificação pra você resolver
  try { await page.getByText(/start verification|verify/i).click({ timeout: 4000 }) } catch {}

  console.log('\n========================================================')
  console.log('  >>> RESOLVA O CAPTCHA e clique "Sign in" na janela. <<<')
  console.log('  Aguardando até 5 minutos pelo login real...')
  console.log('========================================================\n')

  let ok = false
  for (let i = 0; i < 300; i++) {
    const t = await page.evaluate(() => localStorage.getItem('token')).catch(() => null)
    if (t) {
      const d = decodeJwt(t)
      if (d && !String(d.email || '').includes('guest')) {
        console.log(`\n[manual-login] ✅ LOGIN OK como ${d.email}. Sessão persistida em glm_profiles/${accountId}.`)
        ok = true
        break
      }
    }
    await sleep(1000)
  }
  if (!ok) console.log('\n[manual-login] ❌ tempo esgotado sem token real. Tente de novo.')

  await sleep(1500)
  await ctx.close()
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error('[manual-login] ERRO:', e); process.exit(1) })
