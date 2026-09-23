import test from 'node:test'
import assert from 'node:assert'
import os from 'os'
import path from 'path'
import fs from 'fs'

// DB temporário isolado (não toca no data/deepseekproxy.db real).
const TMP = path.join(os.tmpdir(), `dsproxy-test-${process.pid}`)
process.env.DEEPSEEK_DATA_DIR = TMP

const { addAccount } = await import('../core/accounts.ts')
const {
  getNextAccount, getNextAvailableAccount,
  markAccountRateLimited, clearAccountCooldown, getAccountCooldownInfo,
} = await import('../core/account-manager.ts')
const { closeDatabase } = await import('../core/database.ts')

test.after(() => {
  closeDatabase()
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('rotação round-robin cicla pelas contas', () => {
  const a = addAccount('a@test.com', 'p1')
  const b = addAccount('b@test.com', 'p2')
  const c = addAccount('c@test.com', 'p3')

  const first = getNextAccount()
  const second = getNextAccount()
  const third = getNextAccount()
  const fourth = getNextAccount()

  const ids = new Set([first?.id, second?.id, third?.id])
  assert.strictEqual(ids.size, 3, 'três primeiras seleções devem ser distintas')
  assert.ok([a.id, b.id, c.id].every(id => ids.has(id)), 'deve cobrir todas as contas')
  assert.strictEqual(fourth?.id, first?.id, 'a 4ª deve voltar para a 1ª (round-robin)')
})

test('cooldown: conta em cooldown é pulada e depois liberada', () => {
  const target = getNextAccount()!
  markAccountRateLimited(target.id, 60_000, 'RateLimited')

  const info = getAccountCooldownInfo(target.id)
  assert.ok(info?.onCooldown, 'deve estar em cooldown')
  assert.strictEqual(info?.reason, 'RateLimited')

  // getNextAvailableAccount não deve devolver a conta em cooldown (havendo outras).
  for (let i = 0; i < 5; i++) {
    const acc = getNextAvailableAccount(undefined)
    assert.notStrictEqual(acc?.id, target.id, 'não deve selecionar conta em cooldown')
  }

  clearAccountCooldown(target.id)
  assert.strictEqual(getAccountCooldownInfo(target.id), null, 'cooldown deve ser limpo')
})
