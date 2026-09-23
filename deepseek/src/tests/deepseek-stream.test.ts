import test from 'node:test'
import assert from 'node:assert'
import { DeepSeekStreamParser } from '../services/deepseek-stream.ts'

// Amostras no formato real do stream SSE do DeepSeek (deltas por path/operação).
const CONTENT_SSE = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"fragments":[{"id":2,"type":"RESPONSE","content":"Hello","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":", "}',
  '',
  'data: {"v":"world"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":42},{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: close',
  'data: {"click_behavior":"none"}',
  '',
].join('\n')

const REASONING_SSE = [
  'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"id":2,"type":"THINK","content":"Let","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" me think"}',
  '',
  'data: {"v":"."}',
  '',
  'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.2}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"42","references":[],"stage_id":1}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":" is"}',
  '',
  'data: {"v":" the answer"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n')

function drain(sse: string, chunkSize?: number) {
  const p = new DeepSeekStreamParser()
  let content = '', reasoning = '', usage = 0, finished = false
  const apply = (deltas: ReturnType<DeepSeekStreamParser['feed']>) => {
    for (const d of deltas) {
      if (d.type === 'delta') { if (d.content) content += d.content; if (d.reasoning) reasoning += d.reasoning }
      else if (d.type === 'usage') usage = d.completionTokens ?? usage
      else if (d.type === 'finish') finished = true
    }
  }
  if (chunkSize) {
    for (let i = 0; i < sse.length; i += chunkSize) apply(p.feed(sse.slice(i, i + chunkSize)))
  } else {
    apply(p.feed(sse))
  }
  apply(p.flush())
  return { content, reasoning, usage, finished }
}

test('parser: reconstrói conteúdo (initial + APPEND + delta puro)', () => {
  const r = drain(CONTENT_SSE)
  assert.strictEqual(r.content, 'Hello, world')
  assert.strictEqual(r.reasoning, '')
  assert.strictEqual(r.usage, 42)
  assert.strictEqual(r.finished, true)
})

test('parser: separa THINK (reasoning) de RESPONSE (content)', () => {
  const r = drain(REASONING_SSE)
  assert.strictEqual(r.reasoning, 'Let me think.')
  assert.strictEqual(r.content, '42 is the answer')
})

test('parser: robusto a chunks partidos (byte a byte)', () => {
  const r = drain(REASONING_SSE, 1)
  assert.strictEqual(r.reasoning, 'Let me think.')
  assert.strictEqual(r.content, '42 is the answer')
})

test('parser: ignora eventos não-data e linhas em branco', () => {
  const r = drain(CONTENT_SSE, 3)
  assert.strictEqual(r.content, 'Hello, world')
})
