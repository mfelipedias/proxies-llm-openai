import test from 'node:test'
import assert from 'node:assert'
import { solveChallenge, encodePowHeader, type PowChallenge } from '../services/pow.ts'

// Challenge real capturado do chat.deepseek.com (difficulty 144000).
const CHALLENGE: PowChallenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'd416b1d6f9c7101828d59f900a039dea96c543f681343277bd509390524f6273',
  salt: 'eed0e1309a4cf5504866',
  difficulty: 144000,
  expire_at: 1780792281703,
  signature: '36fa6952bd9cd4e4b2dc9eb3d8a8d63836892c3f0d59a9d9f3fc9b84524cca64',
  target_path: '/api/v0/chat/completion',
}

test('solveChallenge: WASM resolve o PoW e devolve um answer inteiro positivo', async () => {
  const sol = await solveChallenge(CHALLENGE)
  assert.ok(Number.isInteger(sol.answer), 'answer deve ser inteiro')
  assert.ok(sol.answer > 0, 'answer deve ser > 0 para difficulty 144000')
  // determinístico: mesma entrada -> mesma resposta
  const sol2 = await solveChallenge(CHALLENGE)
  assert.strictEqual(sol.answer, sol2.answer)
})

test('encodePowHeader: produz base64 de JSON com os campos esperados', async () => {
  const sol = await solveChallenge(CHALLENGE)
  const header = encodePowHeader(sol)
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'))
  assert.strictEqual(decoded.algorithm, 'DeepSeekHashV1')
  assert.strictEqual(decoded.challenge, CHALLENGE.challenge)
  assert.strictEqual(decoded.salt, CHALLENGE.salt)
  assert.strictEqual(decoded.signature, CHALLENGE.signature)
  assert.strictEqual(decoded.target_path, CHALLENGE.target_path)
  assert.strictEqual(decoded.answer, sol.answer)
})
