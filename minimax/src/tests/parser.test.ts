import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('StreamingToolParser: basic tool call', () => {
  const parser = new StreamingToolParser();

  // Comportamento atual: o lead-in antes de um tool_call é suprimido (a mensagem
  // OpenAI vira um turno só de tool_calls). Ver pendingLeadIn em feed().
  const result = parser.feed('Hello! <tool_call>{"name": "t1", "arguments": {"a": 1}}</tool_call>');
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 't1');
});

test('StreamingToolParser: multiple tool calls', () => {
  const parser = new StreamingToolParser();

  const result = parser.feed('<tool_call>{"name": "t2", "arguments": {}}</tool_call><tool_call>{"name": "t3", "arguments": {}}</tool_call>');
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 2);
  assert.strictEqual(result.toolCalls[0].name, 't2');
  assert.strictEqual(result.toolCalls[1].name, 't3');
});

test('StreamingToolParser: fragmented tool call', () => {
  const parser = new StreamingToolParser();

  assert.strictEqual(parser.feed('Text <tool_').text, 'Text ');
  assert.strictEqual(parser.feed('call>{"name": ').text, '');
  const final = parser.feed('"frag", "arguments": {}}</tool_call> trailing');

  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, 'frag');
  // Texto após o tool_call também é suprimido (turno é só tool_calls).
  assert.strictEqual(final.text, '');
});

test('StreamingToolParser: flush partial content', () => {
  const parser = new StreamingToolParser();

  parser.feed('Unfinished tag <tool_');
  assert.strictEqual(parser.flush().text, '<tool_');

  const parser2 = new StreamingToolParser();
  parser2.feed('Broken tool <tool_call>{"name": "healable"');
  const flushed = parser2.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'healable');

  const parser3 = new StreamingToolParser();
  parser3.feed('Invalid <tool_call>NOT_JSON');
  const flushed2 = parser3.flush();
  // Nunca vazamos XML interno: tool_call irrecuperável → restaura o lead-in.
  assert.strictEqual(flushed2.text, 'Invalid ');
});

test('StreamingToolParser: robust parsing of malformed JSON', () => {
  const parser = new StreamingToolParser();

  const res = parser.feed('<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test('StreamingToolParser: never leaks internal XML, restores lead-in', () => {
  const parser = new StreamingToolParser();

  // Bloco sem "name" é malformado → descartado, sem vazar as tags; lead-in volta.
  const res1 = parser.feed('Fake: <tool_call> { "only_args": 1 } </tool_call> ');
  assert.ok(!res1.text.includes('<tool_call>'), 'Should NOT leak start tag');
  assert.ok(!res1.text.includes('</tool_call>'), 'Should NOT leak end tag');
  assert.ok(res1.text.startsWith('Fake:'), 'lead-in restored');
  assert.strictEqual(res1.toolCalls.length, 0);

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 'r');
});

const READ_TOOL = [{
  type: 'function' as const,
  function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}];

test('StreamingToolParser: native <minimax:tool_call> format (JSON body)', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  const res = parser.feed('<minimax:tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</minimax:tool_call>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.strictEqual(res.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: native <minimax:tool_call> with <invoke>/<parameter> body', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  const res = parser.feed(
    '<minimax:tool_call>\n<invoke name="read_file">\n<parameter name="path">package.json</parameter>\n</invoke>\n</minimax:tool_call>'
  );
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.strictEqual(res.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: <minimax:tool_call> fragmented across chunks', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  assert.strictEqual(parser.feed('ok <minimax').text, 'ok ');
  parser.feed(':tool_call>{"name": "read_file", "argu');
  const final = parser.feed('ments": {"path": "a.txt"}}</minimax:tool_call>');
  assert.strictEqual(final.toolCalls.length, 1);
  assert.strictEqual(final.toolCalls[0].name, 'read_file');
  assert.strictEqual(final.toolCalls[0].arguments.path, 'a.txt');
});

test('StreamingToolParser: Claude <invoke> format', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  const res = parser.feed('<invoke name="read_file">\n<parameter name="path">package.json</parameter>\n</invoke>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.strictEqual(res.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: <tool_call_block> wrapper', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  const res = parser.feed(
    '<tool_call_block>\n<invoke name="read_file">\n<parameter name="path">package.json</parameter>\n</invoke>\n</tool_call_block>'
  );
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.strictEqual(res.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: bare JSON tool call (no tags) recovered at flush', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  // Alguns modelos emitem JSON cru com lixo no início e sem o wrapper <tool_call>.
  const r1 = parser.feed('④\n{"name": "read_file", "arguments": {"path": "package.json"}}\n');
  // Durante o feed, o JSON fica retido (não vaza como texto antes de validar).
  assert.strictEqual(r1.toolCalls.length, 0);
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read_file');
  assert.strictEqual(flushed.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: bare JSON split across chunks (open brace at boundary)', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  // O `{` chega no fim de um chunk, sem o `"name"` ainda — não pode vazar como texto.
  parser.feed('EREAD_FILE({');
  parser.feed('"name": "read_file", "arguments": {"path": ');
  parser.feed('"package.json"}})');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read_file');
  assert.strictEqual(flushed.toolCalls[0].arguments.path, 'package.json');
});

test('StreamingToolParser: bare JSON with UNKNOWN tool name stays as text', () => {
  const parser = new StreamingToolParser(READ_TOOL as any);
  parser.feed('{"name": "not_a_real_tool", "arguments": {"x": 1}}');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 0, 'no false positive');
  assert.ok(flushed.text.includes('not_a_real_tool'), 'unrecognized JSON returned as text');
});

test('StreamingToolParser: bare JSON ignored when no tools active', () => {
  const parser = new StreamingToolParser();
  const r = parser.feed('{"name": "read_file", "arguments": {"path": "x"}}');
  const flushed = parser.flush();
  assert.strictEqual(r.toolCalls.length + flushed.toolCalls.length, 0);
  assert.ok((r.text + flushed.text).includes('read_file'));
});

test('StreamingToolParser: handles multiple tool calls in array format', () => {
  const parser = new StreamingToolParser();

  const chunk = `<tool_call>[
  {"name": "bash", "arguments": {"command": "ls", "description": "List files"}},
  {"name": "read", "arguments": {"path": "test.txt"}}
]</tool_call>`;

  const result = parser.feed(chunk);
  assert.strictEqual(result.toolCalls.length, 2, 'Should extract both tool calls');
  assert.strictEqual(result.toolCalls[0].name, 'bash');
  assert.strictEqual(result.toolCalls[1].name, 'read');
  assert.strictEqual(result.toolCalls[0].arguments.command, 'ls');
});
