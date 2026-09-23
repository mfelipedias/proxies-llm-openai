/*
 * Testes E2E do pipeline atual (headers mockados via TEST_MOCK_PLAYWRIGHT +
 * fetch upstream mockado): exercitam o chat.ts real — parser de tool-calls,
 * streaming, non-streaming e encerramento limpo do SSE — sem browser e sem
 * rede. Equivalente ao chatBridge.test.ts do minimax.
 */
import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../api/server.js';

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}];

const enc = new TextEncoder();
const answer = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content } }] })}\n\n`;
const thinking = (thoughts: string[]) => `data: ${JSON.stringify({ choices: [{ delta: { phase: 'thinking_summary', extra: { summary_thought: { content: thoughts } } } }] })}\n\n`;
const upstreamDone = () => 'data: [DONE]\n\n';

/** Mocka o fetch upstream do chat.qwen.ai com um script de chunks SSE. */
function setupUpstream(makeBody: () => ReadableStream<Uint8Array>): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('chat.qwen.ai')) {
      if (url.includes('/api/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      if (url.includes('/api/v2/chat/completions')) {
        return new Response(makeBody(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

function scriptedBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    }
  });
}

async function postChat(body: any): Promise<Response> {
  return await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function readSse(res: Response): Promise<{ events: any[]; raw: string }> {
  const raw = await res.text();
  const events: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* heartbeat etc. */ }
  }
  return { events, raw };
}

test('non-streaming COM tools e resposta em texto puro NÃO volta vazia', async () => {
  const restore = setupUpstream(() => scriptedBody([
    thinking(['pensando...']),
    answer('A resposta'),
    answer(' é 42.'),
    upstreamDone(),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
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
  } finally {
    restore();
  }
});

test('non-streaming COM tools e <tool_call> fragmentado devolve tool_calls estruturado', async () => {
  const restore = setupUpstream(() => scriptedBody([
    answer('<tool_call>{"name": "read_file", "argu'),
    answer('ments": {"path": "package.json"}}</tool_call>'),
    upstreamDone(),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
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
  } finally {
    restore();
  }
});

test('non-streaming: bloco <tool_call> malformado NÃO vaza XML no content (regressão)', async () => {
  const restore = setupUpstream(() => scriptedBody([
    answer('Vou tentar: <tool_call>NOT_JSON_AT_ALL</tool_call> fim.'),
    upstreamDone(),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'oi' }],
      tools: TOOLS,
      stream: false,
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const content = body.choices[0].message.content || '';
    assert.ok(!content.includes('<tool_call>'), 'não vaza a tag de abertura');
    assert.ok(!content.includes('</tool_call>'), 'não vaza a tag de fechamento');
    assert.ok(content.includes('Vou tentar:'), 'lead-in preservado');
  } finally {
    restore();
  }
});

test('streaming: formato nativo Qwen3-Coder emite tool_calls e finish_reason tool_calls', async () => {
  const restore = setupUpstream(() => scriptedBody([
    answer('<tool_call>\n<function=read_file>\n<parameter=path>\na.txt\n</parameter>\n</function>\n</tool_call>'),
    upstreamDone(),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'leia a.txt' }],
      tools: TOOLS,
      stream: true,
    });
    assert.strictEqual(res.status, 200);
    const { events } = await readSse(res);
    const toolEvents = events.filter(e => e.choices?.[0]?.delta?.tool_calls);
    assert.strictEqual(toolEvents.length, 1);
    assert.strictEqual(toolEvents[0].choices[0].delta.tool_calls[0].function.name, 'read_file');
    assert.deepStrictEqual(JSON.parse(toolEvents[0].choices[0].delta.tool_calls[0].function.arguments), { path: 'a.txt' });
    const finishEvent = events.find(e => e.choices?.[0]?.finish_reason);
    assert.strictEqual(finishEvent.choices[0].finish_reason, 'tool_calls');
  } finally {
    restore();
  }
});

test('streaming: [DONE] prematuro do upstream não encerra o SSE antes do finish_reason (regressão)', async () => {
  const restore = setupUpstream(() => scriptedBody([
    answer('Olá!'),
    upstreamDone(), // upstream manda [DONE] no MEIO — não pode ser repassado já
    answer(' Tudo bem?'),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'oi' }],
      stream: true,
    });
    assert.strictEqual(res.status, 200);
    const { events, raw } = await readSse(res);

    const doneCount = (raw.match(/data: \[DONE\]/g) || []).length;
    assert.strictEqual(doneCount, 1, 'exatamente UM [DONE] (o nosso, no fim)');

    const dataLines = raw.split('\n').filter(l => l.startsWith('data: '));
    assert.strictEqual(dataLines[dataLines.length - 1], 'data: [DONE]', '[DONE] é a última linha de dados');

    const content = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
    assert.strictEqual(content, 'Olá! Tudo bem?', 'conteúdo após o [DONE] prematuro ainda é entregue');

    const finishEvent = events.find(e => e.choices?.[0]?.finish_reason);
    assert.ok(finishEvent, 'finish_reason presente');
  } finally {
    restore();
  }
});

test('streaming: erro no MEIO do stream termina o SSE limpo (chunk de erro + finish + [DONE])', async () => {
  // pull-based: entrega o 1º chunk e só erra no pull seguinte (c.error logo
  // após enqueue descartaria a fila e o chunk nunca chegaria ao consumidor).
  const restore = setupUpstream(() => {
    let pulls = 0;
    return new ReadableStream({
      pull(c) {
        if (pulls++ === 0) c.enqueue(enc.encode(answer('Começando a resposta')));
        else c.error(new Error('upstream connection reset'));
      }
    });
  });
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'oi' }],
      stream: true,
    });
    assert.strictEqual(res.status, 200);
    const { events, raw } = await readSse(res);

    assert.ok(raw.includes('data: [DONE]'), 'stream termina com [DONE] mesmo com erro upstream');

    const content = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
    assert.ok(content.includes('Começando a resposta'), 'conteúdo recebido antes do erro é preservado');
    assert.ok(content.includes('[Qwen error:'), 'chunk de erro presente');

    const finishEvent = events.find(e => e.choices?.[0]?.finish_reason);
    assert.ok(finishEvent, 'finish_reason presente mesmo com erro no meio');
  } finally {
    restore();
  }
});

test('streaming sem tools encaminha content/reasoning e termina com finish_reason', async () => {
  const restore = setupUpstream(() => scriptedBody([
    thinking(['hmm']),
    answer('Oi!'),
    answer(' Tudo bem?'),
    upstreamDone(),
  ]));
  try {
    const res = await postChat({
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'oi' }],
      stream: true,
    });
    assert.strictEqual(res.status, 200);
    const { events, raw } = await readSse(res);
    assert.ok(raw.includes('data: [DONE]'), 'stream termina com [DONE]');
    const content = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
    assert.strictEqual(content, 'Oi! Tudo bem?');
    const reasoning = events.map(e => e.choices?.[0]?.delta?.reasoning_content || '').join('');
    assert.strictEqual(reasoning, 'hmm');
  } finally {
    restore();
  }
});
