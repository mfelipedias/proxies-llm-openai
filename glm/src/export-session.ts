/*
 * Exporta a sessão logada (token + cookies) do perfil da conta para
 * `glm_session.json` — um artefato portável (OS-independente) que pode ser
 * carregado em qualquer servidor (inclusive headless/Docker).
 *
 * Uso: npx tsx src/export-session.ts [accountId|_default]
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import { listAccounts } from './core/accounts.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function decodeJwt(t: string): any { try { return JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) } catch { return null } }

async function main() {
  let accountId = process.argv[2]
  if (!accountId) {
    const accounts = listAccounts()
    if (accounts.length === 0) { console.error('Nenhuma conta no DB.'); process.exit(1) }
    accountId = accounts[0].id
  }
  const profilePath = path.resolve('glm_profiles', accountId)
  if (!fs.existsSync(profilePath)) { console.error(`Perfil não existe: ${profilePath}`); process.exit(1) }

  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = await ctx.newPage()
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  const token = await page.evaluate(() => localStorage.getItem('token'))
  if (!token) { console.error('Sem token no perfil. Faça manual-login primeiro.'); await ctx.close(); process.exit(1) }
  const payload = decodeJwt(token)
  const guest = String(payload?.email || '').includes('guest') || payload?.role === 'guest'
  const cookies = await ctx.cookies()

  const session = {
    email: payload?.email ?? null,
    guest,
    exp: payload?.exp ?? null,
    token,
    cookies,
    exported_at: new Date().toISOString(),
  }
  fs.writeFileSync(path.resolve('glm_session.json'), JSON.stringify(session, null, 2))

  console.log('=== sessão exportada -> glm_session.json ===')
  console.log('email:', session.email, '| guest:', guest, '| cookies:', cookies.length)
  console.log('exp:', payload?.exp ? new Date(payload.exp * 1000).toISOString() : 'sem expiração (null)')
  if (guest) console.warn('⚠️  ATENÇÃO: token é GUEST. Rode manual-login para uma sessão real.')

  await ctx.close()
  process.exit(0)
}

main().catch((e) => { console.error('[export-session] ERRO:', e); process.exit(1) })
