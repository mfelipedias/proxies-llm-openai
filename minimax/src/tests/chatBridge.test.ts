/*
 * Testes E2E do pipeline atual (bridge Playwright mockada via
 * TEST_MOCK_PLAYWRIGHT + __setTestBridgeScript): exercitam o chat.ts real —
 * parser de tool-calls, streaming e non-streaming — sem browser.
 */
import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../api/server.js';
import { __setTestBridgeScript } from '../services/playwright.ts';

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}];

const chunk = (msg: string) => `data:${JSON.stringify({ type: 6, agent_message_chunk: { msg_content: msg } })}`;
const thinking = (msg: string) => `data:${JSON.stringify({ type: 6, agent_message_chunk: { thinking_content: msg } })}`;
const finish = () => 'data:{"type":6,"agent_message_chunk":{"msg_content":"","finish":true,"finish_reason":"stop"}}';

async function postChat(body: any): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function readSse(res: Response): Promise<any[]> {
  const text = await res.text();
  const events: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* heartbeat etc. */ }
  }
  return events;
}

test('non-streaming sem tools devolve content', async () => {
  __setTestBridgeScript([chunk('Olá, mundo!'), finish()]);
  const res = await postChat({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'oi' }], stream: false });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.object, 'chat.completion');
  assert.strictEqual(body.choices[0].message.content, 'Olá, mundo!');
  assert.strictEqual(body.choices[0].finish_reason, 'stop');
});

test('non-streaming COM tools e resposta em texto puro NÃO volta vazia (regressão)', async () => {
  __setTestBridgeScript([thinking('pensando...'), chunk('A resposta é 42.'), finish()]);
  const res = await postChat({
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: 'quanto é 6*7?' }],
    tools: TOOLS,
    stream: false,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.choices[0].message.content, 'A resposta é 42.');
  assert.strictEqual(body.choices[0].message.reasoning_content, 'pensando...');
  assert.strictEqual(body.choices[0].finish_reason, 'stop');
  assert.ok(!body.choices[0].message.tool_calls);
});

test('non-streaming COM tools e <tool_call> devolve tool_calls estruturado', async () => {
  __setTestBridgeScript([
    chunk('<tool_call>{"name": "read_file", "argu'),
    chunk('ments": {"path": "package.json"}}</tool_call>'),
    finish(),
  ]);
  const res = await postChat({
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: 'leia o package.json' }],
    tools: TOOLS,
    stream: false,
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const msg = body.choices[0].message;
  assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
  assert.strictEqual(msg.content, null);
  assert.strictEqual(msg.tool_calls.length, 1);
  assert.strictEqual(msg.tool_calls[0].function.name, 'read_file');
  assert.deepStrictEqual(JSON.parse(msg.tool_calls[0].function.arguments), { path: 'package.json' });
});

test('streaming COM tools e formato nativo <minimax:tool_call> emite tool_calls', async () => {
  __setTestBridgeScript([
    chunk('<minimax:tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</minimax:tool_call>'),
    finish(),
  ]);
  const res = await postChat({
    model: 'MiniMax-M3',
    messages: [{ role: 'user', content: 'leia a.txt' }],
    tools: TOOLS,
    stream: true,
  });
  assert.strictEqual(res.status, 200);
  const events = await readSse(res);
  const toolEvents = events.filter(e => e.choices?.[0]?.delta?.tool_calls);
  assert.strictEqual(toolEvents.length, 1);
  assert.strictEqual(toolEvents[0].choices[0].delta.tool_calls[0].function.name, 'read_file');
  const finishEvent = events.find(e => e.choices?.[0]?.finish_reason);
  assert.strictEqual(finishEvent.choices[0].finish_reason, 'tool_calls');
});

test('streaming sem tools encaminha content e termina com finish_reason', async () => {
  __setTestBridgeScript([thinking('hmm'), chunk('Oi!'), chunk(' Tudo bem?'), finish()]);
  const res = await postChat({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'oi' }], stream: true });
  assert.strictEqual(res.status, 200);
  const text = await res.clone().text();
  assert.ok(text.includes('data: [DONE]'), 'stream termina com [DONE]');
  const events = await readSse(res);
  const content = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
  assert.strictEqual(content, 'Oi! Tudo bem?');
  const reasoning = events.map(e => e.choices?.[0]?.delta?.reasoning_content || '').join('');
  assert.strictEqual(reasoning, 'hmm');
});
