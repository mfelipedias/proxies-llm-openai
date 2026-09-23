import { test } from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = '1';

import { Mutex } from '../services/playwright.ts';

const tick = () => new Promise(r => setTimeout(r, 0));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('Mutex: exclusão mútua e ordem FIFO', async () => {
  const m = new Mutex();
  const order: number[] = [];

  const r1 = await m.acquire();
  const p2 = m.acquire().then(r => { order.push(2); return r; });
  const p3 = m.acquire().then(r => { order.push(3); return r; });

  await tick();
  assert.deepEqual(order, [], 'nenhum waiter deve adquirir enquanto o lock está retido');

  r1();
  const r2 = await p2;
  await tick();
  assert.deepEqual(order, [2], 'o primeiro da fila deve adquirir primeiro');

  r2();
  const r3 = await p3;
  await tick();
  assert.deepEqual(order, [2, 3], 'a fila deve ser respeitada (FIFO)');
  r3();
});

test('Mutex: double-release é no-op (não concede dois waiters de uma vez)', async () => {
  const m = new Mutex();
  let secondAcquired = false;
  let thirdAcquired = false;

  const r1 = await m.acquire();
  const p2 = m.acquire().then(r => { secondAcquired = true; return r; });
  const p3 = m.acquire().then(r => { thirdAcquired = true; return r; });

  r1();
  r1(); // release duplicado — deve ser ignorado
  await tick();

  assert.equal(secondAcquired, true, 'exatamente um waiter deve ter adquirido');
  assert.equal(thirdAcquired, false, 'o double-release NÃO pode liberar o segundo waiter');

  const r2 = await p2;
  r2();
  await tick();
  assert.equal(thirdAcquired, true, 'após release legítimo, o próximo adquire normalmente');
  (await p3)();
});

test('Mutex: takeover por timeout não corrompe o estado', async () => {
  const m = new Mutex();

  const r1 = await m.acquire(); // detentor "travado": nunca libera
  let taken = false;
  const p2 = m.acquire(50).then(r => { taken = true; return r; });

  await sleep(120);
  assert.equal(taken, true, 'o waiter deve assumir o lock após o timeout');
  const r2 = await p2;

  // Release tardio do detentor despejado: deve ser no-op (token defasado).
  r1();

  let thirdTaken = false;
  const p3 = m.acquire(5000).then(r => { thirdTaken = true; return r; });
  await tick();
  assert.equal(thirdTaken, false, 'release do detentor despejado não pode conceder o lock indevidamente');

  r2();
  const r3 = await p3;
  await tick();
  assert.equal(thirdTaken, true, 'o lock é serializado corretamente após o takeover');
  r3();
});
