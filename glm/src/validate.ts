/*
 * Captura amostras do stream SSE do GLM (z.ai) para validar/ajustar o parser.
 * Uso: HEADLESS=false npx tsx src/validate.ts
 * Escreve os streams crus em /tmp/glm_chat.sse e /tmp/glm_think.sse.
 *
 * Rode com DISCOVER=1 para também logar o DOM da tela de login.
 */
import 'dotenv/config'
import fs from 'fs'
import { initPlaywright, closePlaywright, getGLMAuth } from './services/playwright.ts'
import { createGLMStream, fetchGLMModels } from './services/glm.ts'

const headless = process.env.HEADLESS === 'true'

async function capture(label: string, prompt: string, thinking: boolean, model: string, file: string) {
  console.log(`[validate] ${label}: criando completion (thinking=${thinking}, model=${model})...`)
  const { stream } = await createGLMStream(prompt, thinking, model, undefined)
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
  console.log('[validate] amostra (primeiras 5 linhas):')
  console.log(out.split('\n').slice(0, 5).join('\n'))
}

async function main() {
  console.log(`[validate] initPlaywright (headless=${headless})...`)
  await initPlaywright(headless)

  // 1) Confirma auth.
  const auth = await getGLMAuth()
  console.log(`[validate] token len=${auth.token.length}, cookie len=${auth.cookie.length}`)

  // 2) Confirma catálogo de modelos.
  const models = await fetchGLMModels()
  console.log('[validate] modelos:', models.map((m: any) => m.id).slice(0, 20))

  // 3) Captura SSE (use o id de modelo real que apareceu acima).
  const model = process.env.GLM_MODEL || models[0]?.id || 'glm-4.6'
  await capture('chat', 'conte de 1 a 8 separado por virgula, nada mais', false, model, '/tmp/glm_chat.sse')
  await capture('think', 'quanto e 17 x 4? pense passo a passo', true, model, '/tmp/glm_think.sse')

  console.log('=== FIM ===')
  await closePlaywright()
  process.exit(0)
}

main().catch((e) => { console.error('[validate] ERRO:', e); process.exit(1) })
