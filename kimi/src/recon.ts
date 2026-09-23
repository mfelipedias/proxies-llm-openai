/*
 * recon.ts — Captura de reconhecimento do kimi.com (PLAN Fase 1).
 *
 * Abre um Chromium VISÍVEL com sessão persistente. Você loga e manda UMA
 * mensagem de chat normal. O script grava em `recon-capture.jsonl` toda
 * requisição/resposta XHR/fetch do domínio kimi (URL, método, headers, corpo,
 * formato do stream) — destacando as que parecem chat/stream — para que o
 * endpoint real seja descoberto e substitua os placeholders em services/kimi.ts.
 *
 * A captura contém o TOKEN DE SESSÃO → está no .gitignore. Não versionar.
 *
 *   npm run recon     (ou: npx tsx src/recon.ts)
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import path from 'path'
import fs from 'fs'

const ROOT = process.cwd()
const OUT = path.resolve(ROOT, 'recon-capture.jsonl')
const userDataDir = path.resolve(ROOT, 'kimi_profiles', 'recon')
fs.mkdirSync(userDataDir, { recursive: true })
fs.writeFileSync(OUT, '') // zera captura anterior

const INTEREST = /kimi\.com|moonshot/i
// endpoints que provavelmente são o chat/stream que queremos mapear
const CHATISH = /chat|complet|stream|message|conversation|completion|generate|sse/i

let count = 0
function append(rec: Record<string, unknown>) {
  fs.appendFileSync(OUT, JSON.stringify({ seq: ++count, t: new Date().toISOString(), ...rec }) + '\n')
}

function trunc(s: string | null | undefined, n: number): string | undefined {
  if (s == null) return undefined
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s
}

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
})

const page = ctx.pages()[0] ?? (await ctx.newPage())

page.on('request', req => {
  const url = req.url()
  if (!INTEREST.test(url)) return
  const rt = req.resourceType()
  if (!['xhr', 'fetch'].includes(rt)) return
  const interesting = CHATISH.test(url) && req.method() === 'POST'
  append({
    kind: 'request',
    interesting,
    method: req.method(),
    url,
    resourceType: rt,
    headers: req.headers(),
    postData: trunc(req.postData(), 6000),
  })
  if (interesting) console.log(`\n  ★ POST chat-like capturado: ${url}`)
})

page.on('response', async resp => {
  const url = resp.url()
  if (!INTEREST.test(url)) return
  const req = resp.request()
  if (!['xhr', 'fetch'].includes(req.resourceType())) return
  const headers = resp.headers()
  const ct = headers['content-type'] || ''
  let bodyPreview: string | undefined
  try {
    if (/json|event-stream|text|stream/.test(ct)) {
      bodyPreview = trunc(await resp.text(), 8000)
    }
  } catch (e: any) {
    bodyPreview = `<<não foi possível ler o corpo: ${e?.message}>>`
  }
  append({
    kind: 'response',
    interesting: CHATISH.test(url),
    status: resp.status(),
    method: req.method(),
    url,
    contentType: ct,
    headers,
    bodyPreview,
  })

  // após uma resposta chat-like, registra cookies do domínio (inclui token)
  if (CHATISH.test(url)) {
    try {
      const cookies = await ctx.cookies()
      append({
        kind: 'cookies-after-chat',
        cookies: cookies
          .filter(c => INTEREST.test(c.domain))
          .map(c => ({ name: c.name, domain: c.domain, value: trunc(c.value, 200), httpOnly: c.httpOnly })),
      })
    } catch {}
  }
})

await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded' }).catch(() => {})

console.log(`
============================================================
 RECON KIMI — navegador aberto. Faça o seguinte na janela:
   1) Faça LOGIN normalmente (e-mail/senha ou Google).
   2) Mande UMA mensagem de chat qualquer (ex.: "diga oi").
   3) Espere a resposta terminar de aparecer.
   4) (Opcional) mande uma 2ª mensagem na MESMA conversa,
      para eu ver a diferença entre 1ª msg e msg subsequente.
   5) Volte aqui e me avise "pronto".

 Tudo é gravado em:
   ${OUT}
 (NÃO feche o terminal; pode fechar o navegador quando terminar.)
============================================================
`)

ctx.on('close', () => {
  console.log(`\nNavegador fechado. ${count} eventos capturados em ${OUT}.`)
  process.exit(0)
})
