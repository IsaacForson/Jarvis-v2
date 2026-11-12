import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

const trashed: string[] = [];
// A pretend Trash: the real one must not fill up with test files.
const trash = async (path: string) => {
  trashed.push(basename(path));
  await rename(path, join(base, basename(path)));
};
const tool = (name: string) => fileTools(home, async (path) => `text of ${basename(path)}`, trash).find((candidate) => candidate.name === name)!;

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

test('Word documents are written from HTML, read as text, and edited in place keeping their formatting', async () => {
  trashed.length = 0;
  const doc = '~/Documents/letter.docx';
  assert.equal(await tool('write_file').run({ path: doc, content: '<h1>Offer</h1><p>Dear Dana, the fee is <b>500 dollars</b>.</p>' }), 'Saved ~/Documents/letter.docx.');
  assert.deepEqual(trashed, [], 'a new file has no old version');
  assert.match(await tool('read_file').run({ path: doc }), /Offer\s+Dear Dana, the fee is 500 dollars\./);
  assert.match(await tool('edit_file').run({ path: doc, find: '500 dollars', replace: '650 dollars' }), /Changed it in ~\/Documents\/letter\.docx\. The old version is in the Trash\./);
  assert.match(await tool('read_file').run({ path: doc }), /the fee is 650 dollars\./);
  assert.match(await tool('read_file').run({ path: doc, html: true }), /<b>650 dollars<\/b>/, 'bold survives the edit');
  assert.match(trashed[0]!, /^letter \(before Jarvis edit \d\d\.\d\d\)\.docx$/);
  await assert.rejects(tool('edit_file').run({ path: doc, find: 'nowhere', replace: 'x' }), /not in the document/);
});

test('plain text is edited exactly once unless every occurrence is asked for; PDFs are read, not written', async () => {
  const notes = '~/Documents/todo.txt';
  await tool('write_file').run({ path: notes, content: 'milk\neggs\nmilk\n' });
  await assert.rejects(tool('edit_file').run({ path: notes, find: 'milk', replace: 'oat milk' }), /appear 2 times/);
  await tool('edit_file').run({ path: notes, find: 'milk', replace: 'oat milk', all: true });
  assert.equal(await readFile(join(home, 'Documents', 'todo.txt'), 'utf8'), 'oat milk\neggs\noat milk\n');
  await writeFile(join(home, 'Documents', 'report.pdf'), '%PDF');
  assert.equal(await tool('read_file').run({ path: '~/Documents/report.pdf' }), 'text of report.pdf');
  await assert.rejects(tool('write_file').run({ path: '~/Documents/report.pdf', content: 'x' }), /cannot write PDFs/);
  assert.ok((await readdir(base)).some((name) => name.startsWith('todo (before Jarvis edit')));
});
