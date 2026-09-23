import { test } from 'node:test';
import assert from 'node:assert';
import { truncateSerializedHistory, estimateTokenCount, type PromptSegment } from '../utils/context-truncation.ts';

const SYSTEM = '# TOOLS AVAILABLE\nuse <tool_call> tags\n\n';

function seg(role: string, text: string): PromptSegment {
  return { role, text };
}

test('truncateSerializedHistory: keeps system prompt and most recent turns', () => {
  const filler = 'x'.repeat(400); // ~115 tokens por turno
  const segments: PromptSegment[] = [];
  for (let i = 0; i < 50; i++) {
    segments.push(seg('user', `User: pergunta ${i} ${filler}\n\n`));
    segments.push(seg('assistant', `Assistant: resposta ${i} ${filler}\n\n`));
  }

  const result = truncateSerializedHistory(SYSTEM, segments, 3000);

  assert.ok(result.startsWith(SYSTEM), 'system prompt preserved verbatim at the start');
  assert.ok(result.includes('truncated'), 'truncation marker present');
  assert.ok(result.includes('resposta 49'), 'most recent turn kept');
  assert.ok(!result.includes('pergunta 0 '), 'oldest turn dropped');
  assert.ok(estimateTokenCount(result) <= 3000, 'result fits the context window');
});

test('truncateSerializedHistory: never starts kept history with orphan tool responses', () => {
  const filler = 'y'.repeat(7000); // turno grande para forçar corte logo após
  const segments: PromptSegment[] = [
    seg('user', `User: antiga ${filler}\n\n`),
    seg('assistant', 'Assistant: <tool_call>{"name":"read_file"}</tool_call>\n\n'),
    seg('tool', 'Tool Response (read_file): conteudo antigo\n\n'),
    seg('tool', 'Tool Response (read_file): outro conteudo\n\n'),
    seg('user', 'User: pergunta atual\n\n'),
  ];

  const result = truncateSerializedHistory(SYSTEM, segments, 600);

  assert.ok(result.includes('pergunta atual'), 'current turn kept');
  const history = result.slice(result.indexOf('truncated'));
  assert.ok(!history.includes('Tool Response'), 'orphan tool responses skipped at the cut boundary');
});

test('truncateSerializedHistory: always keeps at least the last turn', () => {
  const huge = 'z'.repeat(50_000);
  const segments: PromptSegment[] = [
    seg('user', `User: ${huge}\n\n`),
  ];
  const result = truncateSerializedHistory(SYSTEM, segments, 1000);
  assert.ok(result.includes('User: '), 'last turn present even when over budget');
});
