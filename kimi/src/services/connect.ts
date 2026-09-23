/*
 * connect.ts — Codec do protocolo Connect-RPC (streaming) usado pelo kimi.com.
 *
 * Enquadramento (mesmo p/ request e response): cada mensagem é
 *   [1 byte flag][4 bytes length big-endian][payload]
 * Flag bit 0x02 marca o frame final (end-of-stream); seu payload são os
 * trailers do Connect (ex.: `{}` em sucesso, ou `{"error":{...}}`).
 *
 * Referência do protocolo capturada na recon — ver kimi/PLAN.md (Fase 1).
 */

const END_STREAM_FLAG = 0x02

/** Serializa um objeto JSON em UM frame Connect (flag 0 = mensagem normal). */
export function encodeConnectFrame(obj: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt8(0, 0)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

export interface ConnectFrame {
  /** true quando é o frame final (trailers) — flag & 0x02. */
  endStream: boolean
  /** payload já parseado como JSON (objeto). */
  json: any
}

/**
 * Decodifica um ReadableStream (corpo do fetch) de frames Connect, emitindo
 * cada frame conforme chega. Acumula bytes parciais entre chunks da rede.
 */
export async function* decodeConnectStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ConnectFrame> {
  const reader = body.getReader()
  let buf = new Uint8Array(0)

  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf, 0)
    next.set(chunk, buf.length)
    buf = next
  }

  while (true) {
    const { done, value } = await reader.read()
    if (value) append(value)

    // consome quantos frames completos houver no buffer
    while (buf.length >= 5) {
      const flag = buf[0]
      const len = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]
      if (buf.length < 5 + len) break // frame incompleto, espera mais bytes
      const payload = buf.subarray(5, 5 + len)
      buf = buf.subarray(5 + len)
      let json: any = null
      try {
        json = JSON.parse(Buffer.from(payload).toString('utf8'))
      } catch {
        json = { _raw: Buffer.from(payload).toString('utf8') }
      }
      yield { endStream: (flag & END_STREAM_FLAG) !== 0, json }
    }

    if (done) break
  }
}
