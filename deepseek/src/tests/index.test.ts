import test from 'node:test'
import assert from 'node:assert'
import os from 'os'
import path from 'path'
import fs from 'fs'

// Ambiente de teste: sem browser real, sem API key, DB temporário isolado.
process.env.TEST_MOCK_PLAYWRIGHT = 'true'
process.env.API_KEY = ''
const TMP = path.join(os.tmpdir(), `dsproxy-idx-${process.pid}`)
process.env.DEEPSEEK_DATA_DIR = TMP

const { app } = await import('../api/server.ts')
const { addAccount } = await import('../core/accounts.ts')
const { closeDatabase } = await import('../core/database.ts')

// Conta de teste para o roteamento do chat ter um alvo.
addAccount('test@deepseek.local', 'pw')

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

const CONTENT_SSE =
  'data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"Hello","references":[],"stage_id":1}]}}}\n\n' +
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":", world"}\n\n' +
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":7}]}\n\n' +
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'

const REASONING_SSE =
  'data: {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"Hmm","references":[],"stage_id":1}]}}}\n\n' +
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"42","references":[],"stage_id":1}]}\n\n' +
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'

const realFetch = globalThis.fetch
function mockDeepSeek(completionSSE: string) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/chat_session/create')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { chat_session: { id: 'sess-test' } } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/chat_session/delete')) {
      return new Response('{"code":0}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/create_pow_challenge')) {
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { challenge: CHALLENGE } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/chat/completion')) {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(completionSSE)); c.close() } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return realFetch(input, init)
  }) as typeof fetch
}

test.after(() => {
  globalThis.fetch = realFetch
  closeDatabase()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('health: retorna 200', async () => {
  const res = await app.fetch(new Request('http://localhost/health'))
  assert.strictEqual(res.status, 200)
  const body = await res.json()
  assert.ok(body.status === 'ok' || body.status === 'unknown' || body.status === 'unhealthy')
})

test('/v1/models: lista deepseek-chat e deepseek-reasoner', async () => {
  const res = await app.fetch(new Request('http://localhost/v1/models'))
  assert.strictEqual(res.status, 200)
  const body = await res.json()
  assert.strictEqual(body.object, 'list')
  const ids = body.data.map((m: any) => m.id)
  assert.ok(ids.includes('deepseek-chat'))
  assert.ok(ids.includes('deepseek-reasoner'))
})

test('chat non-stream: devolve content no formato OpenAI', async () => {
  mockDeepSeek(CONTENT_SSE)
  try {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: false }),
    }))
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.object, 'chat.completion')
    assert.strictEqual(body.choices[0].message.content, 'Hello, world')
    assert.strictEqual(body.choices[0].finish_reason, 'stop')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('chat non-stream (reasoner): separa reasoning_content de content', async () => {
  mockDeepSeek(REASONING_SSE)
  try {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-reasoner', messages: [{ role: 'user', content: 'q' }], stream: false }),
    }))
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.choices[0].message.content, '42')
    assert.strictEqual(body.choices[0].message.reasoning_content, 'Hmm')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('chat stream: emite chunks SSE com content', async () => {
  mockDeepSeek(CONTENT_SSE)
  try {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'oi' }], stream: true }),
    }))
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream')

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let raw = ''
    while (true) { const { done, value } = await reader.read(); if (done) break; raw += dec.decode(value) }

    let content = ''
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data: ') || t.includes('[DONE]')) continue
      try { const c = JSON.parse(t.slice(6)); content += c.choices?.[0]?.delta?.content || '' } catch {}
    }
    assert.strictEqual(content, 'Hello, world')
    assert.ok(raw.includes('[DONE]'))
  } finally {
    globalThis.fetch = realFetch
  }
})
