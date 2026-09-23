/*
 * Captura amostras do stream SSE do DeepSeek para construir o parser.
 * Uso: HEADLESS=false npx tsx src/validate.ts
 * Escreve os streams crus em /tmp/ds_chat.sse e /tmp/ds_reasoner.sse.
 */
import 'dotenv/config'
import fs from 'fs'
import { initPlaywright, closePlaywright } from './services/playwright.ts'
import { createDeepSeekStream } from './services/deepseek.ts'

const headless = process.env.HEADLESS === 'true'

async function capture(label: string, prompt: string, thinking: boolean, file: string) {
  console.log(`[validate] ${label}: criando completion (thinking=${thinking})...`)
  const { stream } = await createDeepSeekStream(prompt, thinking, thinking ? 'deepseek-reasoner' : 'deepseek-chat', undefined)
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  fs.writeFileSync(file, out)
  console.log(`[validate] ${label}: ${out.length} chars -> ${file}`)
}

async function main() {
  console.log(`[validate] initPlaywright (headless=${headless})...`)
  await initPlaywright(headless)

  await capture('chat', 'conte de 1 a 8 separado por virgula, nada mais', false, '/tmp/ds_chat.sse')
  await capture('reasoner', 'quanto e 17 x 4? pense passo a passo', true, '/tmp/ds_reasoner.sse')

  console.log('=== FIM ===')
  await closePlaywright()
  process.exit(0)
}

main().catch((e) => { console.error('[validate] ERRO:', e); process.exit(1) })
