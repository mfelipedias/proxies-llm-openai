import { test } from 'node:test';
import assert from 'node:assert';
import { addAccount, removeAccount, loadAccounts } from '../core/accounts.ts';
import {
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
  clearAccountCooldown,
} from '../core/account-manager.ts';

// Os testes usam contas próprias no SQLite (prefixo rot-test-) e SEMPRE as
// removem no finally. A versão antiga gravava accounts.json, que o
// getDatabase() migrava para o banco REAL e deixava contas fake para trás.

const TEST_IDS = ['rot-test-1', 'rot-test-2', 'rot-test-3'];

function addTestAccounts(): void {
  addAccount('rotation1@rotation-test.local', 'pw1', TEST_IDS[0]);
  addAccount('rotation2@rotation-test.local', 'pw2', TEST_IDS[1]);
  addAccount('rotation3@rotation-test.local', 'pw3', TEST_IDS[2]);
}

function removeTestAccounts(): void {
  for (const id of TEST_IDS) {
    try { removeAccount(id); } catch { /* já removida */ }
    clearAccountCooldown(id);
  }
}

test('Account Rotation: round-robin cycles through every account without repetition', () => {
  addTestAccounts();
  try {
    const total = loadAccounts().length;
    const seen: string[] = [];
    for (let i = 0; i < total; i++) {
      const acc = getNextAccount();
      assert.ok(acc, 'getNextAccount must return an account');
      seen.push(acc.id);
    }
    // Um ciclo completo visita cada conta exatamente uma vez.
    assert.strictEqual(new Set(seen).size, total, 'no repetition within one full cycle');
    for (const id of TEST_IDS) {
      assert.ok(seen.includes(id), `cycle must include ${id}`);
    }
  } finally {
    removeTestAccounts();
  }
});

test('Account Rotation: getNextAvailableAccount skips every account in the exclude set (regressão do loop infinito)', () => {
  addTestAccounts();
  try {
    const allIds = new Set(loadAccounts().map(a => a.id));

    // Com TODAS as contas já tentadas, retorna null (antes: devolvia uma conta
    // já tentada e o chat.ts entrava em ping-pong infinito).
    assert.strictEqual(getNextAvailableAccount(allIds), null);

    // Mesmo com todas em cooldown (fallback "menor cooldown"), o exclude vale.
    for (const id of allIds) markAccountRateLimited(id, 60_000, 'TestCooldown');
    assert.strictEqual(getNextAvailableAccount(allIds), null);

    // Excluindo todas MENOS uma, devolve exatamente a restante (via fallback
    // de menor cooldown).
    const allButOne = new Set([...allIds].filter(id => id !== TEST_IDS[0]));
    const candidate = getNextAvailableAccount(allButOne);
    assert.ok(candidate);
    assert.strictEqual(candidate.id, TEST_IDS[0]);
  } finally {
    for (const a of loadAccounts()) clearAccountCooldown(a.id);
    removeTestAccounts();
  }
});

test('Account Rotation: string skip keeps backward compatibility', () => {
  addTestAccounts();
  try {
    const acc = getNextAvailableAccount(TEST_IDS[0]);
    assert.ok(acc);
    assert.notStrictEqual(acc.id, TEST_IDS[0]);
  } finally {
    removeTestAccounts();
  }
});
