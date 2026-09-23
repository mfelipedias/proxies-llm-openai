/*
 * File: deepseek-stream.ts
 * Project: deepseekproxy
 *
 * Parser do stream SSE do chat.deepseek.com -> deltas normalizados.
 *
 * Formato do DeepSeek (deltas por path/operação), capturado ao vivo:
 *   event: ready | update_session | title | close   (linhas de evento; ignoradas)
 *   data: {"v":{"response":{...,"fragments":[{type:"THINK"|"RESPONSE",content}]}}}  // raiz
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":","}                 // append
 *   data: {"v":" 2"}                                                                 // append (path atual)
 *   data: {"p":"response/fragments","o":"APPEND","v":[{type:"RESPONSE",content:"17"}]}// novo fragment
 *   data: {"p":"response","o":"BATCH","v":[{p:"accumulated_token_usage",v:70},...]}  // usage
 *   data: {"p":"response/status","o":"SET","v":"FINISHED"}                            // fim
 *
 * Regras:
 *   - `{v:{response:{fragments}}}`  -> inicializa fragments (emite content inicial).
 *   - `{p,o,v}` / `{p,v}` (o ausente em /content = APPEND): define o path atual.
 *   - `{v}` puro: APPEND ao path atual (só emite se o path for .../content).
 *   - fragment THINK -> reasoning_content ; RESPONSE -> content.
 */

export interface DeepSeekDelta {
  type: 'delta' | 'usage' | 'finish' | 'error'
  reasoning?: string
  content?: string
  completionTokens?: number
  message?: string
}

const CONTENT_PATH = /^response\/fragments\/(-?\d+)\/content$/

export class DeepSeekStreamParser {
  private buffer = ''
  private fragTypes: string[] = []
  private currentPath = ''

  /** Consome um pedaço cru do stream e devolve os deltas normalizados. */
  feed(chunk: string): DeepSeekDelta[] {
    this.buffer += chunk
    const out: DeepSeekDelta[] = []
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) this.consumeLine(line, out)
    return out
  }

  /** Processa o que sobrou no buffer (chamar ao fim do stream). */
  flush(): DeepSeekDelta[] {
    const out: DeepSeekDelta[] = []
    if (this.buffer.trim()) this.consumeLine(this.buffer, out)
    this.buffer = ''
    return out
  }

  private consumeLine(line: string, out: DeepSeekDelta[]) {
    const t = line.trim()
    if (!t.startsWith('data:')) return // ignora "event:" e linhas em branco
    const dataStr = t.slice(5).trim()
    if (!dataStr || dataStr === '[DONE]') return
    let obj: any
    try { obj = JSON.parse(dataStr) } catch { return }
    this.handle(obj, out)
  }

  private fragTypeAt(index: number): string {
    const i = index < 0 ? this.fragTypes.length + index : index
    return this.fragTypes[i] || 'RESPONSE'
  }

  private emit(fragType: string, text: string, out: DeepSeekDelta[]) {
    if (!text) return
    if (fragType === 'THINK') out.push({ type: 'delta', reasoning: text })
    else out.push({ type: 'delta', content: text })
  }

  private handle(obj: any, out: DeepSeekDelta[]) {
    // Erro embutido no stream (ex.: {"code":40300,"msg":"..."} ou {"error":...}).
    // Sem isto o stream "termina limpo" com resposta vazia e o cliente não
    // fica sabendo que o upstream falhou.
    if (obj && (obj.error !== undefined || (typeof obj.code === 'number' && obj.code !== 0))) {
      const msg = typeof obj.error === 'string'
        ? obj.error
        : obj?.error?.message || obj.msg || obj.message || `upstream code ${obj.code}`
      out.push({ type: 'error', message: String(msg) })
      return
    }

    // Objeto raiz inicial
    if (obj?.v && typeof obj.v === 'object' && obj.v.response && Array.isArray(obj.v.response.fragments)) {
      for (const f of obj.v.response.fragments) {
        this.fragTypes.push(f.type)
        this.emit(f.type, f.content || '', out)
      }
      return
    }

    // Operação com path
    if (typeof obj?.p === 'string') {
      this.currentPath = obj.p

      // Novo(s) fragment(s)
      if (obj.p === 'response/fragments' && Array.isArray(obj.v)) {
        for (const f of obj.v) {
          this.fragTypes.push(f.type)
          this.emit(f.type, f.content || '', out)
        }
        return
      }

      // Conteúdo de um fragment (APPEND ou SET)
      const m = obj.p.match(CONTENT_PATH)
      if (m) {
        this.emit(this.fragTypeAt(parseInt(m[1], 10)), String(obj.v ?? ''), out)
        return
      }

      // Usage em lote
      if (obj.p === 'response' && obj.o === 'BATCH' && Array.isArray(obj.v)) {
        for (const it of obj.v) {
          if (it?.p === 'accumulated_token_usage') {
            out.push({ type: 'usage', completionTokens: Number(it.v) || 0 })
          }
        }
        return
      }

      // Fim
      if (obj.p === 'response/status' && obj.v === 'FINISHED') {
        out.push({ type: 'finish' })
        return
      }

      // Outros paths (elapsed_secs, quasi_status, etc.) -> ignora
      return
    }

    // Delta puro {v} -> APPEND ao path atual, se for um path de conteúdo
    if (obj && 'v' in obj) {
      const m = this.currentPath.match(CONTENT_PATH)
      if (m) this.emit(this.fragTypeAt(parseInt(m[1], 10)), String(obj.v ?? ''), out)
    }
  }
}
