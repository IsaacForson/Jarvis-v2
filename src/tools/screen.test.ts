import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenTools } from './screen.ts';

const setup = (under: { app: string; role: string; label: string }, where: { x: number; y: number } | 'nowhere' = { x: 500, y: 250 }) => {
  const calls: string[][] = [];
  const tools = screenTools({
    capture: async () => 'jpeg',
    describe: async (_jpeg, question) => `answer to: ${question}`,
    locate: async () => (where === 'nowhere' ? undefined : where),
    helper: async (args) => {
      calls.push(args);
      return JSON.stringify(args[0] === 'screen' ? { width: 1800, height: 1000 } : args[0] === 'at' ? under : {});
    },
  });
  return { calls, tool: (name: string) => tools.find((candidate) => candidate.name === name)! };
};

test('reading the screen passes the question to the model that can see', async () => {
  const { tool } = setup({ app: '', role: '', label: '' });
  assert.equal(await tool('read_screen').run({ question: 'What does the error say?' }), 'answer to: What does the error say?');
  assert.equal(await tool('read_screen').run({}), 'answer to: Describe what is on this screen.');
});

test('a find reports what is really at the spot, and the click is always asked about first', async () => {
  const { tool, calls } = setup({ app: 'Spotify', role: 'AXButton', label: 'Play' });
  assert.equal(tool('screen_click').approval?.({}), undefined);
  await assert.rejects(tool('screen_click').run({}), /Call screen_find first/);

  assert.match(await tool('screen_find').run({ target: 'the Play button' }), /What is actually there is the button "Play" in Spotify/);
  assert.deepEqual(calls.at(-1), ['at', '900', '250'], 'thousandths of the picture become points on the screen');
  assert.equal(tool('screen_click').approval?.({}), 'click the button "Play" in Spotify, which I found by sight');
  assert.match(await tool('screen_click').run({}), /Clicked the button "Play"/);
  assert.deepEqual(calls.at(-1), ['click', '900', '250']);
  await assert.rejects(tool('screen_click').run({}), /Call screen_find first/, 'one find allows one click');
});

test('a payment button found by sight is refused, and a failed find says so', async () => {
  const pay = setup({ app: 'Safari', role: 'AXButton', label: 'Buy now' });
  await pay.tool('screen_find').run({ target: 'the buy button' });
  await assert.rejects(pay.tool('screen_click').run({}), /spend money/);
  assert.ok(!pay.calls.some((call) => call[0] === 'click'));

  await assert.rejects(setup({ app: '', role: '', label: '' }, 'nowhere').tool('screen_find').run({ target: 'x' }), /could not find/);
  await assert.rejects(setup({ app: '', role: '', label: '' }, { x: 1500, y: 2 }).tool('screen_find').run({ target: 'x' }), /could not find/);
});
