/*
 * Recon combinado (login + captura) do agent.minimax.io. Abre um navegador
 * headed com o perfil persistente `minimax_profiles/_default`, intercepta TODO o
 * tráfego relevante (requests/responses da própria API do MiniMax, ignorando
 * analytics) e mantém a janela aberta para você LOGAR e enviar uma mensagem.
 * Loga URL, método, headers e body — base para adaptar src/services/minimax.ts,
 * src/routes/chat.ts e src/api/models.ts.
 *
 * Uso: npx tsx src/discover.ts            (headed, perfil _default, ~10 min)
 *      HOLD_MS=300000 npx tsx src/discover.ts
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// domínios/recursos de analytics, CDN e terceiros que devemos IGNORAR
const NOISE_HOST = /(google|gstatic|doubleclick|bing|clarity|sensors|sentry|datadog|segment|hotjar|facebook|reddit|tiktok|cloudflareinsights|recaptcha|gtag|googletagmanager|guance|rum-openway|cdn\.hailuo\.ai|meerkat-reporter|data\.hailuo\.ai|_next\/static)/i
// extensões de assets estáticos (ignorar)
const STATIC = /\.(js|css|png|jpe?g|svg|ico|woff2?|ttf|map|webp|gif)(\?|$)/i
// caminhos que interessam (API real do produto)
const INTERESTING = /(api\/|\/v\d|chat|completion|conversation|message|agent|sse|generate|stream|model|auth|login|sso)/i

async function main() {
  const HOLD_MS = parseInt(process.env.HOLD_MS || '600000') // 10 min
  const accountId = process.argv[2] || '_default'
  const profilePath = path.resolve('minimax_profiles', accountId)

  const ctx = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  })
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }))

  const captured: any[] = []
  const seen = new Set<string>()

  ctx.on('request', (req) => {
    const u = req.url()
    const m = req.method()
    if (NOISE_HOST.test(u) || STATIC.test(u)) return
    if (!INTERESTING.test(u)) return
    if (m === 'OPTIONS') return
    const key = m + ' ' + u.split('?')[0]
    if (seen.has(key) && m === 'GET') return
    seen.add(key)
    const h = req.headers()
    const pd = req.postData()
    const entry = {
      method: m,
      url: u,
      headers: {
        authorization: h['authorization'],
        cookie: h['cookie'] ? `(${h['cookie'].length} chars)` : undefined,
        'content-type': h['content-type'],
        'x-request-id': h['x-request-id'],
        'x-trace-id': h['x-trace-id'],
        'x-signature': h['x-signature'],
        'x-fe-version': h['x-fe-version'],
        'mm-device-id': h['mm-device-id'],
        'device-id': h['device-id'],
        referer: h['referer'],
        // qualquer header não-padrão (x-, mm-, app-, device, trace, sign)
        ...Object.fromEntries(Object.entries(h).filter(([k]) => /^(x-|mm-|app-|device|trace|sign)/i.test(k))),
      },
      body: pd ? pd.slice(0, 3000) : undefined,
    }
    captured.push(entry)
    console.log('\n[REQ]', m, u)
    console.log('[HDR]', JSON.stringify(entry.headers))
    if (pd) console.log('[BODY]', pd.slice(0, 2000))
  })

  ctx.on('response', async (res) => {
    const u = res.url()
    if (NOISE_HOST.test(u) || STATIC.test(u) || !INTERESTING.test(u)) return
    const ct = res.headers()['content-type'] || ''
    if (/event-stream/i.test(ct)) {
      console.log('\n[RESP-SSE]', res.status(), u, '| ct:', ct)
      // O POST .../session/<id>/message responde SSE e FECHA quando a geração
      // termina → res.text() resolve com o stream completo. O canal /events é
      // persistente (nunca fecha) → NÃO ler o corpo (travaria).
      if (/\/session\/[^/]+\/message/.test(u)) {
        res.text().then((t) => {
          const file = path.resolve('discover-sse.txt')
          fs.appendFileSync(file, `\n\n===== SSE de ${u.split('?')[0]} =====\n${t}\n`)
          console.log(`\n[SSE-CAPTURED] ${t.length} chars salvos em discover-sse.txt`)
          console.log('[SSE-PREVIEW]\n' + t.slice(0, 1500))
        }).catch((e) => console.log('[SSE] erro ao ler corpo:', e.message))
      }
    } else if (/json/i.test(ct) && /chat|completion|conversation|message|model|auth|agent/i.test(u)) {
      console.log('\n[RESP-JSON]', res.status(), u)
      try { const t = await res.text(); console.log('[RESP-BODY]', t.slice(0, 800)) } catch {}
    }
  })

  const page = await ctx.newPage()
  await page.goto('https://agent.minimax.io/', { waitUntil: 'domcontentloaded' })
  await sleep(5000)

  // Auto-envio (perfil já logado). Se falhar, você envia manualmente na janela.
  const AUTO = process.env.NO_AUTO !== '1'
  const MSG = process.env.MSG || 'responda apenas: pong'
  if (AUTO) {
    try {
      const sel = 'textarea, [contenteditable="true"], input[type="text"]'
      await page.waitForSelector(sel, { timeout: 30000 })
      const el = (await page.$('textarea')) || (await page.$('[contenteditable="true"]'))
      if (el) {
        await el.click()
        await page.keyboard.type(MSG)
        await sleep(800)
        await page.keyboard.press('Enter')
        console.log(`[discover] auto-enviei: "${MSG}" — aguardando o SSE...`)
      } else {
        console.log('[discover] input não encontrado; envie manualmente na janela.')
      }
    } catch (e: any) {
      console.log('[discover] auto-envio falhou; envie manualmente:', e.message)
    }
  }

  console.log('\n========================================================')
  console.log('  Capturando o SSE. Se nada enviar, mande uma mensagem na janela.')
  console.log(`  Janela aberta por ${Math.round(HOLD_MS / 60000)} min.`)
  console.log('========================================================\n')

  await sleep(HOLD_MS)

  // dump final de sessão (cookies + localStorage) para entender a auth
  const cookies = await ctx.cookies().catch(() => [])
  const ls = await page.evaluate(() => {
    const o: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) o[k] = (localStorage.getItem(k) ?? '').slice(0, 120) }
    return o
  }).catch(() => ({}))

  const dump = { capturedRequests: captured, cookies: cookies.map((c: any) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly })), localStorage: ls }
  fs.writeFileSync(path.resolve('discover-dump.json'), JSON.stringify(dump, null, 2))
  console.log('\n[discover] === FIM === salvo em discover-dump.json')
  console.log('[discover] requests capturadas:', captured.length, '| cookies:', cookies.length)

  await ctx.close()
  process.exit(0)
}

main().catch((e) => { console.error('[discover] ERRO:', e); process.exit(1) })
