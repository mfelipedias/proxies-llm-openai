import { test } from 'node:test';
import assert from 'node:assert';
import { getIncrementalDelta } from '../routes/chat.ts';

test('getIncrementalDelta: handles strictly cumulative stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = 'const x = 1;\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = 'const x = 1;\nconst y = 2;\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: handles strictly incremental stream correctly', () => {
  let accumulated = '';
  
  // Step 1
  let chunk1 = 'const x = 1;';
  let res1 = getIncrementalDelta(accumulated, chunk1);
  assert.strictEqual(res1.delta, 'const x = 1;');
  accumulated = res1.matchedContent;
  
  // Step 2
  let chunk2 = '\nconst y = 2;';
  let res2 = getIncrementalDelta(accumulated, chunk2);
  assert.strictEqual(res2.delta, '\nconst y = 2;');
  accumulated = res2.matchedContent;

  // Step 3
  let chunk3 = '\nconst z = 3;';
  let res3 = getIncrementalDelta(accumulated, chunk3);
  assert.strictEqual(res3.delta, '\nconst z = 3;');
  accumulated = res3.matchedContent;
  
  assert.strictEqual(accumulated, 'const x = 1;\nconst y = 2;\nconst z = 3;');
});

test('getIncrementalDelta: does not suffer from false-positive repetitive word overlap bugs', () => {
  // Previously, if oldStr ended in a common keyword and newStr started/contained the same keyword,
  // it would incorrectly match them and strip them. Let's verify this is fixed.
  let accumulated = 'import { useState } from \'react\';\nimport {';
  let nextChunk = ' Button } from \'@/components/ui/button\';';
  
  let res = getIncrementalDelta(accumulated, nextChunk);
  // It should treat the next chunk as strictly incremental and return it unchanged.
  assert.strictEqual(res.delta, ' Button } from \'@/components/ui/button\';');
  assert.strictEqual(res.matchedContent, 'import { useState } from \'react\';\nimport { Button } from \'@/components/ui/button\';');
});

test('getIncrementalDelta: incremental chunk sharing a short prefix with the START of the accumulated content is NOT mangled (regressão)', () => {
  // Antes: bastava 4 chars de prefixo em comum para tratar como cumulativo,
  // e o chunk "The result..." perdia o "The " quando o acumulado começava igual.
  const accumulated = 'The quick brown fox jumps over the lazy dog. ';
  const nextChunk = 'The result is 42.';

  const res = getIncrementalDelta(accumulated, nextChunk);
  assert.strictEqual(res.delta, 'The result is 42.');
  assert.strictEqual(res.matchedContent, accumulated + nextChunk);
});

test('getIncrementalDelta: cumulative stream longer than 2000 chars does not duplicate content (regressão)', () => {
  // Antes: a janela de scan parava em 2000 chars e o delta re-emitia tudo
  // após a posição 2000 a cada chunk cumulativo.
  const base = 'a'.repeat(3000);
  const next = base + 'NEW';

  const res = getIncrementalDelta(base, next);
  assert.strictEqual(res.delta, 'NEW');
  assert.strictEqual(res.matchedContent, next);
});

test('getIncrementalDelta: cumulative resend SHORTER than accumulated emits nothing new', () => {
  const accumulated = 'Hello world, this is the full content.';
  const regressed = 'Hello world';

  const res = getIncrementalDelta(accumulated, regressed);
  assert.strictEqual(res.delta, '');
  assert.strictEqual(res.matchedContent, accumulated);
});
