/*
 * Recon: intercepta a requisição REAL de completion do chat.z.ai enviando uma
 * mensagem pela UI. Loga URL, headers e body para descobrir endpoint/shape.
 * Uso: HEADLESS=false npx tsx src/discover.ts
 */
import 'dotenv/config'
import { initPlaywright, getActivePage, closePlaywright } from './services/playwright.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  await initPlaywright(false)
  const page = getActivePage()
  if (!page) throw new Error('sem page')

  const ctx = page.context()
  const seen = new Set<string>()
  ctx.on('request', (req) => {
    const u = req.url()
    const m = req.method()
    if (m !== 'POST') return
    if (!/chat|completion|stream|message|conversation|api\/v/i.test(u)) return
    const key = m + u
    if (seen.has(key)) return
    seen.add(key)
    const h = req.headers()
    console.log('\n[REQ]', m, u)
    console.log('[HDR]', JSON.stringify({
      authorization: h['authorization'] ? h['authorization'].slice(0, 25) + '...' : undefined,
      'content-type': h['content-type'],
      'x-fe-version': h['x-fe-version'],
      'x-signature': h['x-signature'],
      'x-requested-with': h['x-requested-with'],
      referer: h['referer'],
    }))
    const pd = req.postData()
    if (pd) console.log('[BODY]', pd.slice(0, 1200))
  })

  console.log('[discover] navegando para a home...')
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' })
  await sleep(4000)

  // Tenta achar o input e enviar "oi"
  const inputSel = 'textarea, [contenteditable="true"], input[type="text"]'
  try {
    await page.waitForSelector(inputSel, { timeout: 20000 })
    const el = await page.$('textarea') || await page.$('[contenteditable="true"]')
    if (el) {
      await el.click()
      await page.keyboard.type('oi, responda apenas: pong')
      await sleep(800)
      await page.keyboard.press('Enter')
      console.log('[discover] mensagem enviada, aguardando requisições...')
    } else {
      console.log('[discover] input não encontrado')
    }
  } catch (e: any) {
    console.log('[discover] erro ao enviar:', e.message)
  }

  await sleep(12000)
  console.log('\n[discover] === FIM ===')
  await closePlaywright()
  process.exit(0)
}

main().catch((e) => { console.error('[discover] ERRO:', e); process.exit(1) })
