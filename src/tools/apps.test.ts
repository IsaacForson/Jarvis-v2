import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appTools, type Control, describeWindow, keyRule, pressRule } from './apps.ts';

const control = (over: Partial<Control>): Control => ({ path: 'w.0', role: 'AXButton', label: 'OK', secure: false, ...over });

test('ordinary controls are pressed unasked; risky ones are asked about by name and app', () => {
  assert.equal(pressRule(control({ label: 'bold', role: 'AXCheckBox' }), 'TextEdit'), undefined);
  assert.equal(pressRule(control({ label: 'New Folder' }), 'Finder'), undefined);
  assert.equal(pressRule(control({ label: 'Send' }), 'Mail'), 'press "Send" in Mail');
  assert.equal(pressRule(control({ label: 'Empty Trash' }), 'Finder'), 'press "Empty Trash" in Finder');
  assert.ok(pressRule(control({ label: 'Buy Now' }), 'App Store') instanceof Error);
});

test('Return is asked about in messaging apps and when the app is unknown, not elsewhere', () => {
  assert.equal(keyRule('return', 'Slack'), 'press Return in Slack, which may send a message');
  assert.equal(keyRule('cmd+return', 'Mail'), 'press Return in Mail, which may send a message');
  assert.equal(keyRule('return', undefined), 'press Return in the app in front, which may send a message');
  assert.equal(keyRule('return', 'Finder'), undefined);
  assert.equal(keyRule('cmd+n', 'Slack'), undefined);
});

test('deleting and quitting shortcuts are asked about', () => {
  assert.equal(keyRule('cmd+delete', 'Finder'), 'press Command-Delete in Finder, which may delete something');
  assert.equal(keyRule('Cmd+Q', 'Notes'), 'quit Notes');
  assert.equal(keyRule('delete', 'Notes'), undefined);
});

test('a window is described with its text and numbered controls', () => {
  assert.equal(
    describeWindow({
      app: 'TextEdit',
      window: 'Untitled',
      texts: ['Untitled', 'Untitled'],
      items: [control({ role: 'AXTextArea', label: '', value: 'Hello' }), control({ role: 'AXPopUpButton', label: 'typeface' }), control({ role: 'AXTextField', label: 'Password', secure: true })],
    }),
    ['App: TextEdit, window "Untitled"', '', 'Text in the window: Untitled', '', 'Controls you can use, by number:', '[1] text area (now: Hello)', '[2] pop up button "typeface"', '[3] text field "Password" (password field)'].join('\n'),
  );
});

test('the tools drive the helper with the right route, and refuse what they must', async () => {
  const calls: string[][] = [];
  const window = { app: 'Notes', window: 'Notes', texts: [], items: [control({ label: 'New Note', path: 'w.1.2' }), control({ role: 'AXTextField', label: 'Password', secure: true, path: 'w.3' }), control({ label: 'Pay now', path: 'w.4' })] };
  const tools = appTools(async (args) => {
    calls.push(args);
    return JSON.stringify(window);
  }, async () => {});
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

  await assert.rejects(tool('app_click').run({ ref: 1 }), /no control 1/, 'nothing can be pressed before the window is read');
  assert.match(await tool('app_read').run({ app: 'Notes' }), /\[1\] button "New Note"/);
  await tool('app_click').run({ ref: 1 });
  await assert.rejects(tool('app_type').run({ ref: 2, text: 'hunter2' }), /password field/);
  await assert.rejects(tool('app_click').run({ ref: 3 }), /spend money/);
  await tool('key_press').run({ keys: 'cmd + n' });
  assert.deepEqual(calls, [
    ['tree', '--app', 'Notes'],
    ['press', 'w.1.2', 'AXButton', '--app', 'Notes'],
    ['tree', '--app', 'Notes'],
    ['key', 'cmd+n', '--app', 'Notes'],
    ['tree', '--app', 'Notes'],
  ]);
});

test('several controls can be pressed in one call, in order, with the rules applied to all of them', async () => {
  const calls: string[][] = [];
  const window = { app: 'Calculator', window: 'Calculator', texts: [], items: [control({ label: '1', path: 'w.1' }), control({ label: '2', path: 'w.2' }), control({ label: 'Delete', path: 'w.3' }), control({ label: 'Buy', path: 'w.4' })] };
  const tools = appTools(async (args) => (calls.push(args), JSON.stringify(window)), async () => {});
  const click = tools.find((candidate) => candidate.name === 'app_click')!;
  await tools.find((candidate) => candidate.name === 'app_read')!.run({});
  calls.length = 0;

  await click.run({ refs: [1, 2, 1] });
  assert.deepEqual(calls.map((call) => call.slice(0, 2).join(' ')), ['press w.1', 'press w.2', 'press w.1', 'tree --app']);
  assert.equal(click.approval?.({ refs: [1, 2] }), undefined);
  assert.equal(click.approval?.({ refs: [1, 3] }), 'press "Delete" in Calculator');
  await assert.rejects(click.run({ refs: [1, 4] }), /spend money/);
  await assert.rejects(click.run({ refs: [1, 9] }), /no control 9/);
  await assert.rejects(click.run({ refs: [] }), /1 to 20/);

  calls.length = 0;
  await click.run({ labels: ['2', '1', 'delete'] });
  assert.deepEqual(calls.map((call) => call.slice(0, 2).join(' ')), ['press w.2', 'press w.1', 'press w.3', 'tree --app'], 'labels match whatever their case');
  assert.equal(click.approval?.({ labels: ['1', 'Delete'] }), 'press "Delete" in Calculator');
  await assert.rejects(click.run({ labels: ['7'] }), /No control is labelled "7"/);
});

test('menus are listed and chosen by route; risky commands and Quit are asked about', async () => {
  const calls: string[][] = [];
  const tools = appTools(async (args) => {
    calls.push(args);
    if (args[0] === 'menus') return JSON.stringify({ app: 'Notes', items: [{ title: 'New Note', enabled: true, submenu: false }, { title: 'Export', enabled: false, submenu: true }] });
    return JSON.stringify({ app: 'Notes', window: 'Notes', texts: [], items: [] });
  }, async () => {});
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  await tool('app_read').run({});
  assert.equal(await tool('app_menus').run({ menu: 'File' }), 'Items in the File menu of Notes:\nNew Note\nExport (has a submenu) (greyed out)');
  await tool('app_menu').run({ path: ['File', 'New Note'] });
  assert.deepEqual(calls.at(-2), ['menu', 'File', 'New Note', '--app', 'Notes']);
  assert.equal(tool('app_menu').approval?.({ path: ['File', 'New Note'] }), undefined);
  assert.equal(tool('app_menu').approval?.({ path: ['Edit', 'Delete'] }), 'choose "Edit > Delete" from the menus of Notes');
  assert.equal(tool('app_menu').approval?.({ path: ['Notes', 'Quit Notes'] }), 'choose "Notes > Quit Notes" from the menus of Notes');
  await assert.rejects(tool('app_menu').run({ path: ['Store', 'Buy Now'] }), /spend money/);
  await assert.rejects(tool('app_menu').run({ path: ['File'] }), /must list the menu and the item/);
});

test('a control that moved since the window was read is found again by its label', async () => {
  const calls: string[][] = [];
  let moved = false;
  const tools = appTools(async (args) => {
    calls.push(args);
    if (args[0] === 'press' && args[1] === 'w.5' && moved) throw new Error('The window has changed since it was read. Read it again.');
    return JSON.stringify({ app: 'Calculator', window: '', texts: [], items: [control({ label: '7', path: moved ? 'w.6' : 'w.5' }), control({ label: '', path: 'w.9' })] });
  }, async () => {});
  await tools.find((candidate) => candidate.name === 'app_read')!.run({});
  moved = true;
  calls.length = 0;
  await tools.find((candidate) => candidate.name === 'app_click')!.run({ labels: ['7'] });
  assert.deepEqual(calls.map((call) => call.slice(0, 2).join(' ')), ['press w.5', 'tree --app', 'press w.6', 'tree --app']);
});
