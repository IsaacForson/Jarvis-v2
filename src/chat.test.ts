import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type ChatRequest, createChat } from './chat.ts';
import { AllKeysCoolingError, KeyPool } from './key-pool.ts';

// A stand-in for NVIDIA's API: the key decides the response, and every request is recorded.
const requests: { key: string; body: Record<string, unknown> }[] = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const key = (req.headers.authorization ?? '').replace('Bearer ', '');
  const body = JSON.parse(raw) as Record<string, unknown>;
  const model = body.model;
  requests.push({ key, body });

  if (model === 'stalled') return; // never answers; the connection is closed when the tests end
  const refusal = model === 'missing' ? 404 : key.startsWith('limited') ? 429 : key.startsWith('revoked') ? 401 : key.startsWith('down') ? 502 : 0;
  if (refusal) {
    res.writeHead(refusal, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'refused' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const delta of [{ role: 'assistant' }, { content: 'Good ' }, { reasoning_content: 'hm' }, { content: 'morning.' }]) {
    res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});

let baseURL = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const ask = async (keys: string[], extraBody?: Record<string, unknown>, more: Partial<ChatRequest> = {}) => {
  requests.length = 0;
  const pool = new KeyPool(keys);
  const chat = createChat(pool, baseURL);
  let text = '';
  for await (const piece of chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], extraBody, ...more })) text += piece;
  return { text, pool };
};

test('streams the reply text and leaves out the thinking', async () => {
  const { text } = await ask(['good']);
  assert.equal(text, 'Good morning.');
});

test('sends model-specific fields along with the request', async () => {
  await ask(['good'], { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(requests[0]?.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(requests[0]?.body.stream, true);
});

test('a rate-limited key is rested and the next key answers', async () => {
  const { text, pool } = await ask(['limited', 'good']);
  assert.equal(text, 'Good morning.');
  assert.deepEqual(requests.map((r) => r.key), ['limited', 'good']);
  assert.equal(pool.next().key, 'good', 'the limited key stays out of rotation');
});

test('when every key is rate-limited it stops after one try each', async () => {
  await assert.rejects(ask(['limited-1', 'limited-2']), AllKeysCoolingError);
  assert.equal(requests.length, 2);
});

test('a rejected key is named by position and its value is not leaked', async () => {
  await assert.rejects(ask(['good-unused', 'revoked-secret'].reverse()), (error: Error) => {
    assert.match(error.message, /API key #1 was rejected \(HTTP 401\)/);
    assert.doesNotMatch(error.message, /revoked-secret/);
    return true;
  });
  assert.equal(requests.length, 1, 'a bad key is reported, not silently skipped');
});

test('a server error is retried on the next key', async () => {
  const { text } = await ask(['down', 'good']);
  assert.equal(text, 'Good morning.');
});

test('a server that stays down fails after three tries', async () => {
  await assert.rejects(ask(['down-1', 'down-2']), /502/);
  assert.equal(requests.length, 3);
});

test('a model that stalls or is missing is replaced by the next one on the list', async () => {
  const { text } = await ask(['good'], undefined, {
    model: 'stalled',
    timeoutMs: 100,
    fallbacks: [{ model: 'missing' }, { model: 'backup', extraBody: { effort: 'low' } }],
  });
  assert.equal(text, 'Good morning.');
  assert.deepEqual(requests.map((r) => r.body.model), ['stalled', 'missing', 'backup']);
  assert.equal(requests[2]?.body.effort, 'low', "the backup model's own settings are sent, not the first model's");
});
