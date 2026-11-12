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
