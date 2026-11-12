import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileTools, safePath } from './files.ts';

// A pretend home folder, with a secret outside it and a link pointing out.
let base = '';
let home = '';
before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'jarvis-files-')));
  home = join(base, 'home');
  await mkdir(join(home, 'Documents'), { recursive: true });
  await mkdir(join(home, '.ssh'));
  await writeFile(join(home, 'Documents', 'notes.txt'), 'buy milk');
  await writeFile(join(home, '.env'), 'KEY=secret');
  await writeFile(join(base, 'outside.txt'), 'not yours');
  await symlink(join(base, 'outside.txt'), join(home, 'shortcut.txt'));
});
after(() => rm(base, { recursive: true, force: true }));

const tool = (name: string) => fileTools(home).find((candidate) => candidate.name === name)!;

test('paths inside the home folder are accepted, with ~ meaning home', async () => {
  assert.equal(await safePath('~/Documents/notes.txt', home), join(home, 'Documents', 'notes.txt'));
  assert.equal(await safePath('Documents/new/file.txt', home), join(home, 'Documents', 'new', 'file.txt'));
});

test('paths that leave the home folder are refused, including through a link', async () => {
  for (const path of ['/etc/passwd', '../outside.txt', '~/../outside.txt', '~/shortcut.txt']) {
    await assert.rejects(safePath(path, home), /outside your home folder/, path);
  }
});

test('secrets are refused even inside the home folder', async () => {
  for (const path of ['~/.env', '~/.ssh/id_ed25519', '~/Documents/server.pem', '~/.env.local', '~/Library/Keychains/login.keychain-db']) {
    await assert.rejects(safePath(path, home), /secrets/, path);
  }
});

test('read_file returns text and list_folder hides dot files', async () => {
  assert.equal(await tool('read_file').run({ path: '~/Documents/notes.txt' }), 'buy milk');
  assert.equal(await tool('list_folder').run({ path: '~' }), 'Documents/\nshortcut.txt');
  await assert.rejects(tool('read_file').run({ path: 42 }), /"path" must be/);
});

test('write_file asks first, then saves inside home only', async () => {
  assert.equal(tool('write_file').approval?.({ path: '~/Documents/list.txt', content: 'x' }), 'save the file ~/Documents/list.txt');
  await tool('write_file').run({ path: '~/Documents/sub/list.txt', content: 'eggs' });
  assert.equal(await readFile(join(home, 'Documents', 'sub', 'list.txt'), 'utf8'), 'eggs');
  await assert.rejects(tool('write_file').run({ path: '/tmp/evil.txt', content: 'x' }), /outside your home folder/);
});

test('move_to_trash always asks first', () => {
  assert.equal(tool('move_to_trash').approval?.({ path: '~/Documents/notes.txt' }), 'move ~/Documents/notes.txt to the Trash');
});
