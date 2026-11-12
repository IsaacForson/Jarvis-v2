import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { factsPrompt, Memory, memoryTools } from './memory.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const open = async (now = () => Date.now()) => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-memory-'));
  dirs.push(dir);
  return { file: join(dir, 'memory.db'), memory: new Memory(join(dir, 'memory.db'), { now }) };
};
const tool = (memory: Memory, name: string) => memoryTools(memory).find((candidate) => candidate.name === name)!;

test('facts survive a restart and reach the instructions', async () => {
  const { file, memory } = await open();
  assert.equal(await tool(memory, 'remember').run({ facts: ['Prefers tea to coffee', 'Dana is his manager'] }), 'Saved.');
  assert.equal(await tool(memory, 'remember').run({ fact: 'Prefers tea to coffee' }), 'Already remembered.');
  await assert.rejects(tool(memory, 'remember').run({ facts: [] }), /must be a list/);
  memory.close();
  const again = new Memory(file);
  assert.match(factsPrompt(again), /- Prefers tea to coffee\n- Dana is his manager/);
  assert.match(await tool(again, 'memories').run({}), /Prefers tea to coffee/);
  again.close();
});

test('nothing remembered means no extra instructions', async () => {
  const { memory } = await open();
  assert.equal(factsPrompt(memory), '');
  assert.equal(await tool(memory, 'memories').run({}), 'Nothing is remembered yet.');
});

test('sentences of one reply become one line, and recall finds it with its neighbours', async () => {
  const { memory } = await open(() => new Date('2026-11-11T10:00:00').getTime());
  memory.log('you', 'When is my dentist appointment?', 1);
  memory.log('jarvis', 'It is on Friday at nine, sir.', 1);
  memory.log('jarvis', 'Shall I set a reminder?', 1);
  memory.log('you', 'What is the weather?', 2);
  memory.log('jarvis', 'Sunny.', 2);
  const found = await tool(memory, 'recall').run({ query: 'dentist' });
  assert.match(found, /you: When is my dentist appointment\?\n10:00 jarvis: It is on Friday at nine, sir\. Shall I set a reminder\?/);
  assert.match(await tool(memory, 'recall').run({ date: '2026-11-11' }), /Sunny\./);
  assert.match(await tool(memory, 'recall').run({ date: '2026-11-10' }), /Nothing was said/);
  assert.match(await tool(memory, 'recall').run({ query: 'holiday' }), /No past conversation/);
  await assert.rejects(tool(memory, 'recall').run({}), /Give words/);
});

test('forgetting asks first, says what will go, and deletes only what names the topic', async () => {
  const { memory } = await open();
  memory.remember('Dana is his manager');
  memory.remember('Prefers tea');
  memory.log('you', 'Dana wants the report by Monday.', 1);
  memory.log('you', 'Order more tea.', 2);
  memory.log('you', 'Forget her.', 3);
  const forget = tool(memory, 'forget');
  assert.equal(forget.approval?.({ topic: 'Dana' }), 'forget everything about Dana: 1 saved fact and 1 line of past conversation');
  assert.equal(forget.approval?.({ topic: 'Bob' }), undefined);
  assert.equal(await forget.run({ topic: 'Dana' }), 'Forgotten: 1 facts and 1 conversation lines.');
  assert.deepEqual(memory.facts().map((fact) => fact.text), ['Prefers tea']);
  assert.match(await tool(memory, 'recall').run({ query: 'tea' }), /Order more tea/);
  assert.match(await tool(memory, 'recall').run({ query: 'Dana report' }), /No past conversation/);
  assert.match(await forget.run({ topic: 'Bob' }), /Nothing remembered/);
});

// A stand-in for the real model: words about drinks point one way, about teeth another, the rest a third.
const embed = async (said: string) => {
  const vec = new Float32Array(3);
  vec[/drink|juice|beverage/i.test(said) ? 0 : /dentist|teeth/i.test(said) ? 1 : 2] = 1;
  return vec;
};

test('recall finds lines by meaning, even with no word in common', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-memory-'));
  dirs.push(dir);
  const memory = new Memory(join(dir, 'memory.db'), { embed });
  memory.log('you', 'My favourite drink is mango juice.', 1);
  memory.log('jarvis', 'Noted.', 1);
  memory.log('you', 'Book the dentist.', 2);
  memory.log('jarvis', 'Booked.', 2);
  const found = await tool(memory, 'recall').run({ query: 'beverages' });
  assert.match(found, /mango juice/);
  assert.doesNotMatch(found, /dentist/);
  assert.match(await tool(memory, 'recall').run({ query: 'teeth' }), /Book the dentist/);
  memory.close();
});

test('lines written before search by meaning existed are indexed on request', async () => {
  const { file, memory } = await open();
  memory.log('you', 'I drink green tea.', 1);
  memory.close();
  const again = new Memory(file, { embed });
  await again.index();
  assert.match(await tool(again, 'recall').run({ query: 'beverage' }), /green tea/);
  again.close();
});

test('forgetting also drops the turn that asked, its reply included, and tells the session', async () => {
  const { memory } = await open();
  let told = 0;
  memory.remember('Dana is his manager');
  memory.log('you', 'Dana likes Mondays.', 1);
  memory.log('you', 'Please forget her.', 2);
  memory.log('jarvis', 'Shall I forget everything about Dana, sir?', 2);
  memory.log('you', 'Yes.', 2);
  assert.match(await memoryTools(memory, { onForget: () => told++ }).find((one) => one.name === 'forget')!.run({ topic: 'Dana' }), /Forgotten/);
  memory.log('jarvis', 'Done, I have forgotten Dana.', 2);
  memory.log('you', 'What time is it?', 3);
  assert.equal(told, 1);
  assert.match(await tool(memory, 'recall').run({ date: new Date().toISOString().slice(0, 10) }), /^[^\n]+\n\d\d:\d\d you: What time is it\?$/);
});
