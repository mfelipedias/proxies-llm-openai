import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from '../api/server.js';

delete process.env.API_KEY;

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.z.ai')) {
      // Handle models list request separately if handler doesn't
      if (urlStr.includes('/api/models')) {
         return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
      }
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedBody = '';

  const restore = setupFetchMock((url, init) => {
    capturedBody = init?.body as string || '';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // The proxy transforms messages into a Qwen-compatible prompt.
    // Verify the prompt (in the request body) contains context from all messages.
    assert.ok(capturedBody.includes('hello') || capturedBody.includes('User: hello'), 'Must include user message');
    assert.ok(capturedBody.includes('thinking about hello'), 'Must include reasoning content');
    assert.ok(capturedBody.includes('tool_call') || capturedBody.includes('"name": "test"'), 'Must include tool call info');
    assert.ok(capturedBody.includes('Tool Response (test): success') || capturedBody.includes('success'), 'Must include tool response');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "   ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "  hello  ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "\\n\\n  ", "phase": "answer"}}]}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.6-plus', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"content": "done", "phase": "answer"}}], "usage": {"output_tokens": 10}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{role: 'user', content: 'test'}],
        stream: true,
        stream_options: { include_usage: true }
      })
    });

    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

// O proxy GLM é STATELESS (sem parent_id/sessão server-side): cada turno deve
// reenviar o histórico COMPLETO serializado no prompt. Substitui o antigo teste
// de session-parent-tracking, que era específico do Qwen.
test('stateless-history: each turn resends the full serialized conversation', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    capturedPayloads.push(JSON.parse(init?.body as string || '{}'));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    // Turn 1
    const res1 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    }));
    assert.strictEqual(res1.status, 200);
    await res1.text();

    // Turn 2
    const res2 = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    }));
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    const prompt2 = JSON.stringify(capturedPayloads[1]);
    assert.ok(prompt2.includes('Turn 1'), 'Turn 2 must resend turn 1');
    assert.ok(prompt2.includes('Response 1'), 'Turn 2 must resend the assistant response');
    assert.ok(prompt2.includes('Turn 2'), 'Turn 2 must include the new user message');
  } finally {
    restore();
  }
});
