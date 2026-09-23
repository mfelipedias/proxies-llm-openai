/*
 * Recon do algoritmo de assinatura (x-signature) do chat.z.ai.
 * Uso: HEADLESS=false npx tsx src/discover-sig.ts
 */
import 'dotenv/config'
import fs from 'fs'
import { initPlaywright, getActivePage, closePlaywright } from './services/playwright.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  await initPlaywright(false)
  const page = getActivePage()
  if (!page) throw new Error('sem page')
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' })
  await sleep(5000)

  // dispara navegação leve pra carregar mais chunks
  await page.evaluate(() => window.scrollTo(0, 200)).catch(() => {})
  await sleep(2000)

  const result = await page.evaluate(async () => {
    const urls = new Set<string>()
    for (const r of performance.getEntriesByType('resource') as any[]) {
      if (/\.js(\?|$)/.test(r.name)) urls.add(r.name)
    }
    document.querySelectorAll('script[src]').forEach((s) => urls.add((s as HTMLScriptElement).src))

    const keywords = ['x-signature', 'signature_timestamp', 'signature_prompt', 'captcha_verify', 'sha256', 'Hmac', 'subtle.digest', 'wasm']
    const out: any[] = []
    let scanned = 0
    for (const src of urls) {
      try {
        const txt = await (await fetch(src)).text()
        scanned++
        for (const kw of keywords) {
          let idx = txt.indexOf(kw)
          let n = 0
          while (idx !== -1 && n < 2) {
            out.push({ src: src.split('/').slice(-1)[0], kw, snippet: txt.slice(Math.max(0, idx - 400), idx + 400) })
            idx = txt.indexOf(kw, idx + 1)
            n++
          }
        }
      } catch { /* ignore */ }
    }
    return { scanned, total: urls.size, out }
  })

  fs.writeFileSync('/tmp/glm_sig.json', JSON.stringify(result.out, null, 2))
  console.log(`[discover-sig] scanned=${result.scanned}/${result.total} | hits=${result.out.length} -> /tmp/glm_sig.json`)
  const kws = [...new Set(result.out.map((h: any) => h.kw))]
  console.log('[discover-sig] keywords encontradas:', kws)

  await closePlaywright()
  process.exit(0)
}

main().catch((e) => { console.error('[discover-sig] ERRO:', e); process.exit(1) })
