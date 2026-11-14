import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRequest, ToolCall } from './chat.ts';
import { runJob } from './jobs.ts';
import type { Tool } from './tools/types.ts';

const ran: string[] = [];
const tools: Tool[] = [
  { name: 'web_search', description: '', parameters: { type: 'object', properties: {} }, run: async (args) => (ran.push(`search ${String(args.query)}`), 'Three results.') },
  { name: 'move_to_trash', description: '', parameters: { type: 'object', properties: {} }, approval: () => 'move a file to the Trash', run: async () => (ran.push('trash'), 'Moved.') },
  { name: 'send_form', description: '', parameters: { type: 'object', properties: {} }, approval: () => 'send the form', run: async () => (ran.push('sent'), 'Sent.') },
];
/** A pretend model that makes the given calls round by round, then says its summary. */
const model = (rounds: ToolCall[][], summary: string) => {
  const requests: ChatRequest[] = [];
  const chat = (request: ChatRequest) => {
    requests.push(request);
    const calls = rounds.shift();
    return (async function* () {
      if (!calls) yield summary;
      return calls ?? [];
    })();
  };
  return { chat, requests };
};
const call = (name: string, args: object, id: string): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

test('a job uses tools round by round and returns its spoken summary; deleting is never done unasked', async () => {
  ran.length = 0;
  const { chat, requests } = model([[call('web_search', { query: 'flights' }, 'a'), call('move_to_trash', {}, 'b')], [call('send_form', {}, 'c')]], 'The cheapest flight is 400 dollars.');
  const summary = await runJob('Find flights', { chat, model: { model: 'deep' }, tools: () => tools, autonomous: true });
  assert.equal(summary, 'The cheapest flight is 400 dollars.');
  assert.deepEqual(ran, ['search flights', 'sent'], 'autonomous: the form is sent, the file is not trashed');
  const results = requests[1]!.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
  assert.match(results[1]!, /needs his yes/);
  assert.equal(requests[0]!.model, 'deep');
});

test('without autonomy, anything that needs a yes is left for him', async () => {
  ran.length = 0;
  const { chat } = model([[call('send_form', {}, 'a')]], 'I left the form for you.');
  await runJob('Fill the form', { chat, model: { model: 'deep' }, tools: () => tools, autonomous: false });
  assert.deepEqual(ran, []);
});

test('a long report is boiled down to a few spoken sentences', async () => {
  const { chat } = model([], `Now I have all the information. Let me summarize:\n- Amazon: $198\n- Best Buy: $198\n${'Details. '.repeat(50)}`);
  const summary = await runJob('Compare', { chat, model: { model: 'deep' }, tools: () => tools, autonomous: true, summarize: async (answer) => `Both are 198 dollars (${answer.length} characters read).` });
  assert.match(summary, /^Both are 198 dollars \(\d+ characters read\)\.$/);
});

test('each action is reported as it is done, and a restarted job is told what was done before', async () => {
  ran.length = 0;
  const steps: string[] = [];
  const { chat, requests } = model([[call('web_search', { query: 'jobs' }, 'a'), call('move_to_trash', {}, 'b')]], 'Applied to two.');
  await runJob('Apply to jobs', { chat, model: { model: 'deep' }, tools: () => tools, autonomous: true, done: ['web_click {"ref":4}: Applied to Acme'], onStep: (step) => steps.push(step) });
  assert.deepEqual(steps, ['web_search {"query":"jobs"}: Three results.'], 'a refused action is not a step');
  assert.match(String(requests[0]!.messages[1]!.content), /^Apply to jobs\n\nThis task was started earlier[\s\S]*- web_click \{"ref":4\}: Applied to Acme\nDo not repeat them/);
});

test('a background job never sends a message, since nobody can be asked', async () => {
  ran.length = 0;
  const send: Tool = { name: 'send_email', description: '', parameters: { type: 'object', properties: {} }, alwaysAsk: true, approval: () => 'send an email', run: async () => (ran.push('emailed'), 'Sent.') };
  const { chat } = model([[call('send_email', {}, 'a')]], 'I left the email for you.');
  await runJob('Email the report', { chat, model: { model: 'deep' }, tools: () => [send], autonomous: true });
  assert.deepEqual(ran, []);
});
