import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Library, passages } from './library.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// A pretend "meaning": one dimension a topic, so texts about the same topic point the same way.
const TOPICS = ['contract', 'recipe', 'invoice'];
const embed = async (value: string) => {
  const raw = TOPICS.map((topic) => (value.toLowerCase().includes(topic) ? 1 : 0.01));
  const length = Math.hypot(...raw);
  return Float32Array.from(raw.map((one) => one / length));
};

test('documents are taken in a few at a time, found by meaning, and kept in step with the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-library-'));
  dirs.push(dir);
  const root = join(dir, 'Documents');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'deal.txt'), 'The contract says we agreed on 650 a month.');
  await writeFile(join(root, 'soup.md'), 'A recipe for groundnut soup.');
  await writeFile(join(root, 'photo.png'), 'not a document');
  await writeFile(join(root, '.env'), 'contract secret');
  await writeFile(join(root, 'node_modules', 'readme.md'), 'a contract in a dependency');
  let now = 0;
  const read: string[] = [];
  const library = new Library({ dbPath: join(dir, 'library.db'), roots: [root], embed, now: () => now, readText: async (path) => (read.push(path), (await import('node:fs/promises')).readFile(path, 'utf8')) });

  assert.equal(await library.sync(1), 1, 'one taken in, one still waiting');
  assert.equal(await library.sync(1), 0);
  assert.deepEqual(read.map((path) => path.slice(root.length + 1)).sort(), ['deal.txt', 'soup.md'], 'no pictures, secrets or dependencies');
  assert.deepEqual((await library.search('which contract')).map((one) => one.text), ['The contract says we agreed on 650 a month.']);
  assert.match(await library.tool().run({ query: 'the contract' }), /deal\.txt\n"The contract says we agreed on 650 a month\."$/);
  assert.match(await library.tool().run({ query: 'an invoice' }), /Nothing in his 2 indexed documents matches/);

  // Later: one file changed, one deleted.
  await writeFile(join(root, 'deal.txt'), 'The contract was cancelled.');
  await utimes(join(root, 'deal.txt'), new Date(), new Date(Date.now() + 5000));
  await rm(join(root, 'soup.md'));
  now = 11 * 60_000;
  await library.sync();
  assert.deepEqual((await library.search('contract')).map((one) => one.text), ['The contract was cancelled.']);
  assert.deepEqual(await library.search('recipe'), []);
});

test('a long document is cut into passages at its paragraphs', () => {
  const parts = passages(`${'First point. '.repeat(40)}\n\n${'Second point. '.repeat(40)}\n\nShort end.`);
  assert.equal(parts.length, 2, 'the short last paragraph joins the one before it');
  assert.ok(parts.every((part) => part.length <= 700));
  assert.match(parts[0]!, /^First point\./);
  assert.match(parts[1]!, /^Second point\..*Short end\.$/);
});
