/*
 * File: chatBridge.test.ts
 * Project: deepseekproxy
 *
 * Regressão ponta a ponta do pipeline de /v1/chat/completions com
 * globalThis.fetch mockado (sem browser, sem rede). Cobre os cenários que já
 * quebraram conversas agênticas em outros portes:
 *   1. non-streaming com tools ativas + resposta em texto puro (content não
 *      pode voltar vazio);
 *   2. non-streaming com tools + <tool_call> (tool_calls + finish_reason);
 *   3. streaming com tool call no formato NATIVO do DeepSeek (tokens ｜▁);
 *   4. erro do upstream NO MEIO do streaming -> SSE termina limpo com
 *      finish_reason + [DONE] (cliente não fica pendurado);
 *   5. stall no meio do streaming -> timeout de inatividade aborta e o SSE
 *      termina limpo;
 *   6. Bearer rejeitado (401) -> re-auth automático e retry transparente;
 *   7. chat_session criada no upstream é apagada ao fim da requisição.
 */
import test from 'node:test'
import assert from 'node:assert'
import os from 'os'
import path from 'path'
import fs from 'fs'

// Ambiente de teste: sem browser real, sem API key, DB temporário isolado.
// STREAM_STALL_TIMEOUT curto para o teste de stall (lido no import do config).
process.env.TEST_MOCK_PLAYWRIGHT = 'true'
process.env.API_KEY = ''
process.env.STREAM_STALL_TIMEOUT = '250'
const TMP = path.join(os.tmpdir(), `dsproxy-bridge-${process.pid}`)
process.env.DEEPSEEK_DATA_DIR = TMP

const { app } = await import('../api/server.ts')
const { addAccount } = await import('../core/accounts.ts')
const { closeDatabase } = await import('../core/database.ts')

addAccount('bridge@deepseek.local', 'pw')

// Challenge real (difficulty 144000) para o WASM resolver o PoW de verdade.
const CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'd416b1d6f9c7101828d59f900a039dea96c543f681343277bd509390524f6273',
  salt: 'eed0e1309a4cf5504866',
  difficulty: 144000,
  expire_at: 1780792281703,
  signature: '36fa6952bd9cd4e4b2dc9eb3d8a8d63836892c3f0d59a9d9f3fc9b84524cca64',
  target_path: '/api/v0/chat/completion',
}

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Lê um arquivo', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]

/** SSE completo do DeepSeek com um único fragment RESPONSE. */
function sseFor(text: string): string {
  return `data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":${JSON.stringify(text)},"references":[],"stage_id":1}]}}}\n\n` +
    'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":7}]}\n\n' +
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
}

const enc = (s: string) => new TextEncoder().encode(s)

const realFetch = globalThis.fetch
const deletedSessions: string[] = []

function mockDeepSeek(
  makeCompletionBody: () => BodyInit | ReadableStream<Uint8Array>,
  opts: { sessionCreate401Times?: number } = {},
) {
  let remaining401 = opts.sessionCreate401Times ?? 0
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/chat_session/create')) {
      if (remaining401 > 0) {
        remaining401--
        return new Response('{"code":40100,"msg":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-bridge' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/chat_session/delete')) {
      try { deletedSessions.push(JSON.parse(init?.body || '{}').chat_session_id) } catch {}
      return new Response('{"code":0}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/create_pow_challenge')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { challenge: CHALLENGE } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/chat/completion')) {
      return new Response(makeCompletionBody() as any, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return realFetch(input, init)
  }) as typeof fetch
}

async function postChat(payload: any): Promise<Response> {
  return app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let raw = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += dec.decode(value)
  }
  return raw
}

function parseSse(raw: string): any[] {
  const chunks: any[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data: ') || t.includes('[DONE]')) continue
    try { chunks.push(JSON.parse(t.slice(6))) } catch {}
  }
  return chunks
}

test.after(() => {
  globalThis.fetch = realFetch
  closeDatabase()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('non-stream + tools: resposta em texto puro preserva o content', async () => {
  mockDeepSeek(() => sseFor('Olá! Posso ajudar com o quê?'))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: false, tools: TOOLS })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.choices[0].message.content, 'Olá! Posso ajudar com o quê?')
    assert.strictEqual(body.choices[0].finish_reason, 'stop')
    assert.ok(!body.choices[0].message.tool_calls, 'não deve inventar tool_calls')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('non-stream + tools: <tool_call> vira tool_calls com finish_reason tool_calls', async () => {
  mockDeepSeek(() => sseFor('<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'leia a.txt' }], stream: false, tools: TOOLS })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    const msg = body.choices[0].message
    assert.ok(msg.tool_calls && msg.tool_calls.length === 1)
    assert.strictEqual(msg.tool_calls[0].function.name, 'read_file')
    assert.deepStrictEqual(JSON.parse(msg.tool_calls[0].function.arguments), { path: 'a.txt' })
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('stream + tools: formato NATIVO DeepSeek (tokens ｜▁) vira tool_calls', async () => {
  const native = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path": "b.txt"}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>'
  mockDeepSeek(() => sseFor(native))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'leia b.txt' }], stream: true, tools: TOOLS })
    assert.strictEqual(res.status, 200)
    const raw = await readAll(res)
    assert.ok(raw.includes('[DONE]'))
    const chunks = parseSse(raw)
    const toolChunk = chunks.find(c => c.choices?.[0]?.delta?.tool_calls)
    assert.ok(toolChunk, 'deve emitir chunk de tool_calls')
    assert.strictEqual(toolChunk.choices[0].delta.tool_calls[0].function.name, 'read_file')
    const finish = chunks.find(c => c.choices?.[0]?.finish_reason)
    assert.strictEqual(finish.choices[0].finish_reason, 'tool_calls')
    const leaked = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('')
    assert.ok(!leaked.includes('tool▁'), 'tokens nativos não podem vazar como texto')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('stream: erro do upstream NO MEIO termina o SSE com finish_reason + [DONE]', async () => {
  mockDeepSeek(() => new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc('data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"Começou","references":[],"stage_id":1}]}}}\n\n'))
      setTimeout(() => c.error(new Error('conexão caiu no meio')), 20)
    },
  }))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: true })
    assert.strictEqual(res.status, 200)
    const raw = await readAll(res) // tem que TERMINAR (não pendurar)
    assert.ok(raw.includes('[DONE]'), 'SSE deve terminar com [DONE] mesmo com erro no meio')
    const chunks = parseSse(raw)
    assert.ok(chunks.some(c => c.choices?.[0]?.finish_reason), 'deve emitir finish_reason')
    const content = chunks.map(c => c.choices?.[0]?.delta?.content || '').join('')
    assert.ok(content.includes('[DeepSeek erro:'), 'deve avisar o erro ao cliente')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('stream: stall no meio dispara timeout de inatividade e termina limpo', async () => {
  mockDeepSeek(() => new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc('data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"Parcial","references":[],"stage_id":1}]}}}\n\n'))
      // nunca fecha nem envia mais nada -> stall
    },
  }))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: true })
    assert.strictEqual(res.status, 200)
    const raw = await readAll(res) // termina via STREAM_STALL_TIMEOUT=250ms
    assert.ok(raw.includes('[DONE]'), 'SSE deve terminar com [DONE] após o stall')
    const content = parseSse(raw).map(c => c.choices?.[0]?.delta?.content || '').join('')
    assert.ok(content.includes('inativo'), 'deve reportar o timeout de inatividade')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('401 no upstream dispara re-auth e a requisição completa com sucesso', async () => {
  mockDeepSeek(() => sseFor('autenticado de novo'), { sessionCreate401Times: 1 })
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: false })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.choices[0].message.content, 'autenticado de novo')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('chat_session criada no upstream é apagada ao fim da requisição', async () => {
  deletedSessions.length = 0
  mockDeepSeek(() => sseFor('ok'))
  try {
    const res = await postChat({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: false })
    assert.strictEqual(res.status, 200)
    await res.json()
    // o delete é fire-and-forget: dá um tick para ele acontecer
    for (let i = 0; i < 20 && deletedSessions.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(deletedSessions.includes('sess-bridge'), 'deve chamar /chat_session/delete com o id criado')
  } finally {
    globalThis.fetch = realFetch
  }
})
