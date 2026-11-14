import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { devTools } from './dev.ts';

let root = '';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jarvis-dev-'));
  await mkdir(join(root, 'Personal', 'jarvis', '.git'), { recursive: true });
  await mkdir(join(root, 'Personal', 'jarvis', 'packages', 'inner', '.git'), { recursive: true });
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'Personal', 'jarvis', '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  await writeFile(join(root, 'Personal', 'jarvis', 'package.json'), JSON.stringify({ scripts: { test: 'x', build: 'y' } }));
});
after(() => rm(root, { recursive: true, force: true }));

test('projects are found by their git folder, with branch and scripts; one inside another is not listed twice', async () => {
  const [list] = devTools(root);
  assert.equal(await list!.run({}), 'jarvis (branch dev): scripts test, build');
});

test('a command runs inside the named project; a failure comes back with what it printed', async () => {
  const run = devTools(root, 2000)[1]!;
  assert.match(await run.run({ project: 'Jarvis', command: 'pwd' }), /^In jarvis: It finished without an error\.\n.*Personal\/jarvis$/);
  assert.match(await run.run({ project: 'jarvis', command: 'echo 2 tests failed; exit 3' }), /It failed \(exit 3\)\.\n2 tests failed$/);
  await assert.rejects(run.run({ project: 'nothing', command: 'pwd' }), /no project called "nothing". The projects are: jarvis\./);
  await assert.rejects(run.run({ project: 'jarvis', command: 'sudo rm -rf /' }), /sudo/);
  await assert.rejects(run.run({ project: 'jarvis', command: 'cat .env' }), /keys or passwords/);
});

test('looking at git needs no yes; anything else is asked about by name', () => {
  const run = devTools(root)[1]!;
  assert.equal(run.approval?.({ project: 'jarvis', command: 'git log --since=yesterday --oneline' }), undefined);
  assert.equal(run.approval?.({ project: 'jarvis', command: 'git status; rm -rf .' }), 'run git status; rm -rf . in the jarvis project');
  assert.equal(run.approval?.({ project: 'jarvis', command: 'npm test' }), 'run npm test in the jarvis project');
});
