/*
 * Exporta a sessão logada (cookies + localStorage) do perfil da conta para
 * `minimax_session.json` — artefato portável (OS-independente) carregável em
 * qualquer servidor (inclusive headless/Docker), evitando refazer o login.
 *
 * Uso: npx tsx src/export-session.ts [accountId|_default]
 *
 * NOTA: a chave exata do token do MiniMax ainda precisa ser confirmada via
 * `npm run discover` / manual-login (dump de localStorage keys). Por isso este
 * export salva TODO o localStorage + cookies; ajuste loadSharedSession depois.
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import { listAccounts } from './core/accounts.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  let accountId = process.argv[2]
  if (!accountId) {
    const accounts = listAccounts()
    accountId = accounts.length > 0 ? accounts[0].id : '_default'
  }
  const profilePath = path.resolve('minimax_profiles', accountId)
  if (!fs.existsSync(profilePath)) { console.error(`Perfil não existe: ${profilePath}. Rode manual-login primeiro.`); process.exit(1) }

  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const page = await ctx.newPage()
  await page.goto('https://agent.minimax.io/', { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  const localStorageDump = await page.evaluate(() => {
    const out: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k) out[k] = localStorage.getItem(k) ?? ''
    }
    return out
  }).catch(() => ({} as Record<string, string>))

  const cookies = await ctx.cookies()

  const session = {
    accountId,
    cookies,
    localStorage: localStorageDump,
    exported_at: new Date().toISOString(),
  }
  fs.writeFileSync(path.resolve('minimax_session.json'), JSON.stringify(session, null, 2))

  console.log('=== sessão exportada -> minimax_session.json ===')
  console.log('cookies:', cookies.length, '| localStorage keys:', Object.keys(localStorageDump))
  if (cookies.length === 0 && Object.keys(localStorageDump).length === 0) {
    console.warn('⚠️  Nada para exportar — o perfil não parece logado. Rode manual-login.')
  }

  await ctx.close()
  process.exit(0)
}

main().catch((e) => { console.error('[export-session] ERRO:', e); process.exit(1) })
