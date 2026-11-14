import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Routines } from './routines.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

test('a routine is taught, named in the instructions, run by name whatever the capitals, changed and removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-routines-'));
  dirs.push(dir);
  const routines = new Routines(join(dir, 'memory.db'));
  const tool = (name: string) => routines.tools().find((one) => one.name === name)!;
  assert.equal(routines.prompt(), '');
  await tool('save_routine').run({ name: 'Work Mode', steps: 'Open Cursor and Slack. Set the volume to 20.' });
  assert.match(routines.prompt(), /Routines he has taught you: "work mode"\./);
  assert.match(await tool('run_routine').run({ name: 'work  mode' }), /in order, then tell him briefly that it is done:\nOpen Cursor and Slack\. Set the volume to 20\.$/);
  await tool('save_routine').run({ name: 'work mode', steps: 'Open Cursor only.' });
  assert.equal(await tool('routines').run({}), '"work mode": Open Cursor only.');
  await assert.rejects(tool('run_routine').run({ name: 'party mode' }), /no routine called "party mode". The routines are: work mode\./);

  // Kept on disk for the next start.
  const again = new Routines(join(dir, 'memory.db')).tools().find((one) => one.name === 'delete_routine')!;
  assert.equal(again.approval?.({ name: 'work mode' }), 'delete the routine work mode');
  assert.equal(await again.run({ name: 'Work mode' }), 'Removed.');
  assert.equal(routines.prompt(), '');
});
