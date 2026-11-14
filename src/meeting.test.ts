import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createNotes } from './meeting.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const setup = async (write: (transcript: string) => Promise<string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-notes-'));
  dirs.push(dir);
  return { dir, notes: createNotes({ dir, write, now: () => new Date('2026-11-14T10:05') }) };
};

test('a meeting is written up: the summary is spoken, the notes and every word are saved', async () => {
  let given = '';
  const { dir, notes } = await setup(async (transcript) => ((given = transcript), 'You agreed to ship on Monday.\n---\n## Decisions\n- Ship on Monday'));
  notes.start();
  notes.add('Let us ship on Monday.');
  notes.add('Agreed.');
  assert.equal(await notes.end(), 'You agreed to ship on Monday. The notes are in your Documents folder, under Meeting notes.');
  assert.equal(given, '10:05 Let us ship on Monday.\n10:05 Agreed.');
  assert.deepEqual(await readdir(dir), ['Meeting 2026-11-14 10.05.md']);
  assert.equal(await readFile(join(dir, 'Meeting 2026-11-14 10.05.md'), 'utf8'), '# Meeting 2026-11-14 10.05\n\n## Decisions\n- Ship on Monday\n\n## Transcript\n\n10:05 Let us ship on Monday.\n10:05 Agreed.\n');
});

test('if the summary cannot be written, what was said is still saved; an empty meeting saves nothing', async () => {
  const { dir, notes } = await setup(async () => {
    throw new Error('model offline');
  });
  notes.start();
  assert.match(await notes.end(), /Nothing was said/);
  assert.deepEqual(await readdir(dir), []);
  notes.start();
  notes.add('One thing was said.');
  assert.match(await notes.end(), /could not write the summary.*is saved/);
  assert.match(await readFile(join(dir, 'Meeting 2026-11-14 10.05.md'), 'utf8'), /## Transcript\n\n10:05 One thing was said\./);
});
