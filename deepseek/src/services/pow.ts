/*
 * File: pow.ts
 * Project: deepseekproxy
 *
 * Proof-of-Work (PoW) do chat.deepseek.com — resolvido rodando o WASM oficial
 * do DeepSeek (sha3_wasm_bg.wasm), o mesmo que o app web usa.
 *
 * Fluxo:
 *   1. POST /api/v0/chat/create_pow_challenge { target_path } -> challenge
 *      (algorithm, challenge, salt, difficulty, expire_at, signature, target_path)
 *   2. wasm_solve(challenge, prefix=`${salt}_${expire_at}_`, difficulty) -> answer
 *   3. header x-ds-pow-response = base64(JSON{algorithm, challenge, salt, answer,
 *      signature, target_path})
 *
 * O WASM é autocontido (sem imports) e exporta:
 *   wasm_solve(retptr, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty:f64)
 *   __wbindgen_export_0 (malloc), __wbindgen_add_to_stack_pointer, memory
 *
 * Convenção (wasm-bindgen, Option<f64>): no retptr lê-se um i32 (discriminante)
 * e um f64 (a resposta) em retptr+8.
 */

import fs from 'fs'
import { fileURLToPath } from 'url'

export interface PowChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
  target_path: string
}

export interface PowSolution extends PowChallenge {
  answer: number
}

export const POW_CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge'
export const POW_TARGET_PATH = '/api/v0/chat/completion'

// ---------------------------------------------------------------------------
// Pede um novo PoW challenge (fetch Node; passa pelo AWS WAF com o cookie)
// ---------------------------------------------------------------------------
export async function requestPowChallenge(
  baseUrl: string,
  authToken: string,
  cookie: string,
  userAgent: string,
  targetPath: string = POW_TARGET_PATH,
): Promise<PowChallenge> {
  const res = await fetch(`${baseUrl}${POW_CHALLENGE_PATH}`, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'content-type': 'application/json',
      'authorization': `Bearer ${authToken}`,
      'cookie': cookie,
      'origin': baseUrl,
      'referer': `${baseUrl}/`,
      'user-agent': userAgent,
      'x-app-version': '2.0.0',
      'x-client-version': '2.0.0',
      'x-client-platform': 'web',
    },
    body: JSON.stringify({ target_path: targetPath }),
    // Sem timeout este fetch pode pendurar a requisição inteira antes mesmo
    // do streaming começar (o CHAT_TIMEOUT só cobre o fetch de completion).
    signal: AbortSignal.timeout(15000),
  })

  const rawText = await res.text().catch(() => '')
  if (!res.ok) {
    const err = new Error(`Falha ao obter PoW challenge: ${res.status} ${res.statusText} - ${rawText}`)
    ;(err as any).upstreamStatus = res.status
    throw err
  }
  if (process.env.DISCOVER_POW) console.log('[pow][challenge-raw]', rawText.slice(0, 700))

  const json: any = JSON.parse(rawText)
  const c = json?.data?.biz_data?.challenge ?? json?.challenge ?? json
  if (!c || !c.challenge || !c.salt) {
    throw new Error(`Shape inesperado do PoW challenge: ${rawText.slice(0, 300)}`)
  }
  return {
    algorithm: c.algorithm,
    challenge: c.challenge,
    salt: c.salt,
    difficulty: c.difficulty,
    expire_at: c.expire_at,
    signature: c.signature,
    target_path: c.target_path ?? targetPath,
  }
}

// ---------------------------------------------------------------------------
// WASM solver (instância lazy + cacheada)
// ---------------------------------------------------------------------------
interface WasmExports {
  memory: WebAssembly.Memory
  wasm_solve: (retptr: number, cp: number, cl: number, pp: number, pl: number, diff: number) => void
  __wbindgen_export_0: (size: number, align: number) => number
  __wbindgen_add_to_stack_pointer: (n: number) => number
}

let wasmInstance: WasmExports | null = null

async function getWasm(): Promise<WasmExports> {
  if (wasmInstance) return wasmInstance
  const wasmPath = fileURLToPath(new URL('./sha3_wasm_bg.wasm', import.meta.url))
  const bytes = fs.readFileSync(wasmPath)
  const { instance } = await WebAssembly.instantiate(bytes, {})
  wasmInstance = instance.exports as unknown as WasmExports
  return wasmInstance
}

/**
 * Resolve o challenge rodando o WASM oficial do DeepSeek.
 * prefix = `${salt}_${expire_at}_` (confirmado pelos projetos de reversão).
 */
export async function solveChallenge(challenge: PowChallenge): Promise<PowSolution> {
  const w = await getWasm()

  const encode = (str: string): [number, number] => {
    const buf = Buffer.from(str, 'utf-8')
    const ptr = w.__wbindgen_export_0(buf.length, 1) >>> 0
    new Uint8Array(w.memory.buffer).set(buf, ptr)
    return [ptr, buf.length]
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`

  const retptr = w.__wbindgen_add_to_stack_pointer(-16)
  try {
    const [cp, cl] = encode(challenge.challenge)
    const [pp, pl] = encode(prefix)
    w.wasm_solve(retptr, cp, cl, pp, pl, Number(challenge.difficulty))
    const dv = new DataView(w.memory.buffer)
    const status = dv.getInt32(retptr, true)
    const value = dv.getFloat64(retptr + 8, true)
    // Convenção wasm-bindgen p/ Option<f64>: status 1 = Some (solução), 0 = None.
    // (Confirmado empiricamente: solves bem-sucedidos retornam status=1.)
    if (status === 0) {
      throw new Error('PoW: wasm_solve não encontrou solução (Option::None)')
    }
    if (!Number.isFinite(value)) {
      throw new Error(`PoW: answer inválido (status=${status})`)
    }
    return { ...challenge, answer: Math.floor(value) }
  } finally {
    w.__wbindgen_add_to_stack_pointer(16)
  }
}

/** Serializa a solução no formato do header `x-ds-pow-response` (base64 de JSON). */
export function encodePowHeader(solution: PowSolution): string {
  const payload = {
    algorithm: solution.algorithm,
    challenge: solution.challenge,
    salt: solution.salt,
    answer: solution.answer,
    signature: solution.signature,
    target_path: solution.target_path,
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
}
