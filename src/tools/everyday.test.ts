import assert from 'node:assert/strict';
import { test } from 'node:test';
import { everydayTools } from './everyday.ts';

const setup = (selected = '') => {
  const helper: string[][] = [];
  const ran: string[][] = [];
  let clipboard = 'what he copied earlier';
  const tools = everydayTools({
    helper: async (args) => {
      helper.push(args);
      if (args[0] === 'key' && selected) clipboard = selected; // Command-C copies the selection
      return '{}';
    },
    run: async (file, args) => (ran.push([file, ...args]), args[0] === 'list' ? 'Lights off\nFocus on' : ''),
    paste: async () => clipboard,
    copy: async (value) => void (clipboard = value),
  });
  return { tool: (name: string) => tools.find((one) => one.name === name)!, helper, ran, clipboard: () => clipboard };
};

test('music actions press the media keys; an unknown action is refused', async () => {
  const { tool, helper } = setup();
  assert.equal(await tool('music').run({ action: 'play_pause' }), 'Pressed play/pause.');
  await tool('music').run({ action: 'next' });
  assert.deepEqual(helper, [['media', 'play'], ['media', 'next']]);
  await assert.rejects(tool('music').run({ action: 'louder' }), /must be play_pause/);
});

test('shortcuts are listed, and running one is asked about by name', async () => {
  const { tool, ran } = setup();
  assert.equal(await tool('list_shortcuts').run({}), 'Lights off\nFocus on');
  assert.equal(tool('run_shortcut').approval?.({ name: 'Lights off' }), 'run your shortcut Lights off');
  assert.equal(await tool('run_shortcut').run({ name: 'Lights off' }), 'Done.');
  assert.deepEqual(ran.at(-1), ['shortcuts', 'run', 'Lights off']);
});

test('reading the selection copies it and then puts his clipboard back', async () => {
  const { tool, helper, clipboard } = setup('the highlighted sentence');
  assert.equal(await tool('read_selection').run({}), 'the highlighted sentence');
  assert.deepEqual(helper, [['key', 'cmd+c']]);
  assert.equal(clipboard(), 'what he copied earlier');

  const none = setup();
  assert.match(await none.tool('read_selection').run({}), /Nothing is selected/);
  assert.equal(none.clipboard(), 'what he copied earlier');
});

test('the clipboard is read and written', async () => {
  const { tool, clipboard } = setup();
  assert.equal(await tool('read_clipboard').run({}), 'what he copied earlier');
  assert.equal(await tool('write_clipboard').run({ text: 'Bonjour' }), 'It is on the clipboard.');
  assert.equal(clipboard(), 'Bonjour');
});
