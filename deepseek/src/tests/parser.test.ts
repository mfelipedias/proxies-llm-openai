import { test } from 'node:test';
import assert from 'node:assert';
import { StreamingToolParser } from '../tools/parser.ts';

test('StreamingToolParser: basic tool call', () => {
  const parser = new StreamingToolParser();

  // Quando há tool call, o texto de lead-in é suprimido (vira pendingLeadIn):
  // clientes OpenAI esperam uma mensagem estruturada de tool_calls.
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
  // Texto após um tool call também é suprimido (já houve tool_call emitido).
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
  // Tool call irrecuperável é descartado; o lead-in é restaurado (sem vazar a tag).
  assert.strictEqual(flushed2.text, 'Invalid ');
  assert.ok(!flushed2.text.includes('<tool_call>'));
});

test('StreamingToolParser: robust parsing of malformed JSON', () => {
  const parser = new StreamingToolParser();
  
  const res = parser.feed('<tool_call>{"name": "broken", "arguments": {"a": 1</tool_call>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'broken');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { a: 1 });
});

test('StreamingToolParser: descarta bloco sem name e não vaza a tag', () => {
  const parser = new StreamingToolParser();

  // Bloco <tool_call> sem "name" é malformado: descartado, sem vazar tag nem args.
  const res1 = parser.feed('Fake: <tool_call> { "only_args": 1 } </tool_call> ');
  assert.strictEqual(res1.toolCalls.length, 0);
  assert.ok(!res1.text.includes('<tool_call>'), 'não deve vazar a tag de abertura');
  assert.ok(!res1.text.includes('only_args'), 'não deve vazar os args internos');

  const res2 = parser.feed('Real: <tool_call>{"name":"r"}</tool_call>');
  assert.strictEqual(res2.toolCalls.length, 1);
  assert.strictEqual(res2.toolCalls[0].name, 'r');
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

// ─── Formatos específicos do DeepSeek ──────────────────────────────────────────

const TOOLS: any[] = [
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'number' } } } } },
];

test('DeepSeek nativo V3: tokens ｜tool▁calls▁begin｜ com fence json', () => {
  const parser = new StreamingToolParser(TOOLS);
  const chunk = 'Vou ler o arquivo.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path": "a.txt"}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
  const res = parser.feed(chunk);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'a.txt' });
  assert.strictEqual(res.text, '', 'lead-in suprimido quando há tool call');
});

test('DeepSeek nativo V3: múltiplas calls no mesmo wrapper', () => {
  const parser = new StreamingToolParser(TOOLS);
  const chunk = '<｜tool▁calls▁begin｜>' +
    '<｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path": "1.txt"}\n```\n<｜tool▁call▁end｜>' +
    '<｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n```json\n{"city": "SP"}\n```\n<｜tool▁call▁end｜>' +
    '<｜tool▁calls▁end｜>';
  const res = parser.feed(chunk);
  assert.strictEqual(res.toolCalls.length, 2);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.strictEqual(res.toolCalls[1].name, 'get_weather');
});

test('DeepSeek nativo V3.1: nome<｜tool▁sep｜>{args} sem fence', () => {
  const parser = new StreamingToolParser(TOOLS);
  const res = parser.feed('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"city":"Tokyo"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>');
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'get_weather');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { city: 'Tokyo' });
});

test('DeepSeek nativo: fragmentado em chunks + flush sem tool▁call▁end', () => {
  const parser = new StreamingToolParser(TOOLS);
  assert.strictEqual(parser.feed('ok <｜tool▁cal').text, 'ok ');
  parser.feed('ls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file\n```json\n{"path"');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read_file');
});

test('DSML: <｜DSML｜function_calls> com invokes e tipagem string=', () => {
  const parser = new StreamingToolParser(TOOLS);
  const chunk = '<｜DSML｜function_calls>' +
    '<｜DSML｜invoke name="get_weather">' +
    '<｜DSML｜parameter name="city" string="true">Tokyo</｜DSML｜parameter>' +
    '<｜DSML｜parameter name="days" string="false">5</｜DSML｜parameter>' +
    '</｜DSML｜invoke>' +
    '</｜DSML｜function_calls>';
  const res = parser.feed(chunk);
  assert.strictEqual(res.toolCalls.length, 1);
  assert.strictEqual(res.toolCalls[0].name, 'get_weather');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { city: 'Tokyo', days: 5 });
});

test('XML degradado: <function_calls><invoke name=...> sem prefixo DSML', () => {
  const parser = new StreamingToolParser(TOOLS);
  const chunk = '<function_calls><invoke name="read_file"><parameter name="path">b.txt</parameter></invoke>' +
    '<invoke name="get_weather"><parameter name="city">RJ</parameter></invoke></function_calls>';
  const res = parser.feed(chunk);
  assert.strictEqual(res.toolCalls.length, 2);
  assert.strictEqual(res.toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(res.toolCalls[0].arguments, { path: 'b.txt' });
  assert.strictEqual(res.toolCalls[1].name, 'get_weather');
});

test('Bare JSON: tool-call cru sem tags (nome conhecido) recuperado no flush', () => {
  const parser = new StreamingToolParser(TOOLS);
  const r1 = parser.feed('{"name": "read_file", "argum');
  assert.strictEqual(r1.text, '', 'JSON aberto deve ser retido, não vazado');
  parser.feed('ents": {"path": "x.txt"}}');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(flushed.toolCalls[0].arguments, { path: 'x.txt' });
});

test('Bare JSON em fence ```json também é recuperado', () => {
  const parser = new StreamingToolParser(TOOLS);
  parser.feed('```json\n{"name": "get_weather", "arguments": {"city": "POA"}}\n```');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'get_weather');
});

test('Bare JSON: NÃO recupera quando o nome não é tool conhecida', () => {
  const parser = new StreamingToolParser(TOOLS);
  const text = 'Exemplo de payload: {"name": "João", "arguments": "nenhum"}';
  let out = parser.feed(text).text;
  out += parser.flush().text;
  assert.strictEqual(out, text, 'JSON normal deve voltar como texto intacto');
});

test('Bare JSON: sem tools ativas, nada é retido nem recuperado', () => {
  const parser = new StreamingToolParser();
  const text = '{"name": "read_file", "arguments": {}}';
  let out = parser.feed(text).text;
  out += parser.flush().text;
  assert.strictEqual(out, text);
});

test('Narração [调用 X]: recuperada no flush com args JSON', () => {
  const parser = new StreamingToolParser(TOOLS);
  parser.feed('[调用 read_file] {"path": "c.txt"}');
  const flushed = parser.flush();
  assert.strictEqual(flushed.toolCalls.length, 1);
  assert.strictEqual(flushed.toolCalls[0].name, 'read_file');
  assert.deepStrictEqual(flushed.toolCalls[0].arguments, { path: 'c.txt' });
});

test('Narração [Calling tool X]: recuperada; nome desconhecido vira texto', () => {
  const parser = new StreamingToolParser(TOOLS);
  parser.feed('[Calling tool get_weather]');
  const ok = parser.flush();
  assert.strictEqual(ok.toolCalls.length, 1);
  assert.strictEqual(ok.toolCalls[0].name, 'get_weather');

  const parser2 = new StreamingToolParser(TOOLS);
  const text = '[Calling tool nao_existe]';
  let out = parser2.feed(text).text;
  out += parser2.flush().text;
  assert.strictEqual(out, text, 'narração com tool desconhecida volta como texto');
});

test('Texto normal com chaves/colchetes não gera falso positivo', () => {
  const parser = new StreamingToolParser(TOOLS);
  const text = 'Em JS, use `const x = {}` e arrays `[1, 2]`. O objeto {a: 1} é literal.';
  let out = parser.feed(text).text;
  out += parser.flush().text;
  assert.strictEqual(out, text);
});
