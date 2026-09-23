/*
 * File: glm-stream.ts
 * Project: glmproxy
 *
 * Parser do stream SSE do chat.z.ai (GLM) -> deltas normalizados.
 *
 * Formato do z.ai (Open WebUI custom), a CONFIRMAR ao vivo (ver PLAN.md):
 *   data: {"type":"chat:completion","data":{"phase":"thinking","delta_content":"...","done":false}}
 *   data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"...","done":false}}
 *   data: {"type":"chat:completion","data":{"phase":"answer","edit_content":"...","done":true,"usage":{...}}}
 *   data: [DONE]
 *
 * Regras:
 *   - phase === 'thinking'  -> reasoning_content
 *   - phase === 'answer'    -> content
 *   - `delta_content` é incremental; `edit_content` (quando presente no done)
 *     costuma ser o conteúdo final consolidado — tratado via getIncrementalDelta
 *     no chat.ts para evitar duplicação.
 *   - `usage.completion_tokens` (ou `output_tokens`) -> usage.
 *
 * >>> TODO: validar nomes de campos (phase/delta_content/edit_content/usage)
 * >>> com src/validate.ts antes de confiar em produção.
 */

import { GLMUpstreamError } from './glm.ts'

export interface GLMDelta {
  type: 'delta' | 'usage' | 'finish'
  reasoning?: string
  content?: string
  completionTokens?: number
}

export class GLMStreamParser {
  private buffer = ''
  // Para detectar resposta que NÃO é SSE (ex.: JSON de erro de rate limit):
  // guardamos o começo cru do stream e se algum delta foi produzido.
  private rawHead = ''
  private sawDelta = false

  /** Consome um pedaço cru do stream e devolve os deltas normalizados. */
  feed(chunk: string): GLMDelta[] {
    if (this.rawHead.length < 4096) {
      this.rawHead += chunk.slice(0, 4096 - this.rawHead.length)
    }
    this.buffer += chunk
    const out: GLMDelta[] = []
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) this.consumeLine(line, out)
    if (out.length > 0) this.sawDelta = true
    return out
  }

  /**
   * Processa o que sobrou no buffer (chamar ao fim do stream).
   * Lança GLMUpstreamError se o upstream respondeu um JSON de erro em vez de
   * SSE (ex.: rate limit) — sem isso o cliente receberia um 200 vazio e a
   * rotação de contas nunca seria acionada.
   */
  flush(): GLMDelta[] {
    const out: GLMDelta[] = []
    if (this.buffer.trim()) this.consumeLine(this.buffer, out)
    this.buffer = ''
    if (out.length > 0) this.sawDelta = true

    if (!this.sawDelta) {
      const raw = this.rawHead.trim()
      if (raw.startsWith('{')) {
        let obj: any
        try { obj = JSON.parse(raw) } catch { obj = null }
        if (obj && (obj.success === false || obj?.data?.code || obj?.error)) {
          const code = String(obj?.data?.code ?? obj?.code ?? obj?.error?.code ?? 'UpstreamError')
          const details = String(obj?.data?.details ?? obj?.message ?? obj?.error?.message ?? raw.slice(0, 200))
          const status = /ratelimit/i.test(code) ? 429 : 502
          throw new GLMUpstreamError(`GLM upstream error: ${code}: ${details}`, code, status)
        }
      }
    }
    return out
  }

  private consumeLine(line: string, out: GLMDelta[]) {
    const t = line.trim()
    if (!t.startsWith('data:')) return // ignora "event:" e linhas em branco
    const dataStr = t.slice(5).trim()
    if (!dataStr || dataStr === '[DONE]') return
    let obj: any
    try {
      obj = JSON.parse(dataStr)
    } catch {
      return
    }
    this.handle(obj, out)
  }

  private handle(obj: any, out: GLMDelta[]) {
    // z.ai encapsula em { type:"chat:completion", data:{...} }.
    // Alguns endpoints OpenWebUI mandam direto o chunk OpenAI; cobrimos ambos.
    const d = obj?.data ?? obj
    if (!d || typeof d !== 'object') return

    // Caminho OpenAI-style (fallback): choices[0].delta.{content,reasoning_content}
    if (Array.isArray(d.choices) && d.choices[0]?.delta) {
      const delta = d.choices[0].delta
      if (delta.reasoning_content) out.push({ type: 'delta', reasoning: String(delta.reasoning_content) })
      // Variante OpenWebUI/Qwen: thinking chega como phase + extra.summary_thought
      const summary = delta.extra?.summary_thought?.content
      if (summary) {
        const txt = Array.isArray(summary) ? summary.join('') : String(summary)
        if (txt) out.push({ type: 'delta', reasoning: txt })
      }
      if (delta.content) {
        if (delta.phase === 'thinking' || delta.phase === 'thinking_summary') {
          out.push({ type: 'delta', reasoning: String(delta.content) })
        } else {
          out.push({ type: 'delta', content: String(delta.content) })
        }
      }
    }

    // Caminho z.ai-style: phase + delta_content
    const text: string = d.delta_content ?? d.content ?? ''
    if (text) {
      if (d.phase === 'thinking') out.push({ type: 'delta', reasoning: String(text) })
      else out.push({ type: 'delta', content: String(text) })
    }

    // Usage (no chunk final, normalmente com done:true)
    const usage = d.usage ?? obj?.usage
    if (usage) {
      const ct = usage.completion_tokens ?? usage.output_tokens
      if (ct !== undefined) out.push({ type: 'usage', completionTokens: Number(ct) || 0 })
    }

    if (d.done === true || d.phase === 'done') {
      out.push({ type: 'finish' })
    }
  }
}
