import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceLock } from './voice-lock.ts';

// The fake "voiceprint" of a clip is its first two samples, so a test picks the voice directly.
const clip = (x: number, y: number, seconds = 3) => {
  const audio = new Float32Array(seconds * 16_000);
  audio.set([x, y]);
  return audio;
};
const setup = (saved?: number[]) => {
  const store = { saved };
  const lock = new VoiceLock({
    embed: async (audio) => audio.slice(0, 2),
    load: () => store.saved,
    save: (print) => (store.saved = print),
  });
  return { lock, store };
};
const owner = clip(1, 0.1);
const stranger = clip(0.1, 1);

test('with nobody enrolled, anyone may speak', async () => {
  const { lock } = setup();
  assert.equal(lock.enrolled, false);
  assert.deepEqual(await lock.check(stranger), { result: 'open' });
});

test('enrolment takes three long-enough clips, then only the owner passes', async () => {
  const { lock, store } = setup();
  lock.beginEnrolment();
  assert.deepEqual(await lock.check(clip(1, 0, 1)), { result: 'too-short' });
  assert.deepEqual(await lock.check(clip(1, 0)), { result: 'sample' });
  assert.deepEqual(await lock.check(clip(1, 0.2)), { result: 'sample' });
  assert.deepEqual(await lock.check(clip(1, 0.1)), { result: 'enrolled' });
  assert.equal(lock.enrolled, true);
  assert.equal(store.saved?.length, 2);

  const mine = await lock.check(owner);
  const theirs = await lock.check(stranger);
  assert.ok(mine.result === 'owner' && mine.score > 0.99);
  assert.ok(theirs.result === 'stranger' && theirs.score < 0.3);
});

test('a saved voiceprint is used on the next start, and forgetting removes it', async () => {
  const { lock, store } = setup([1, 0]);
  assert.equal((await lock.check(stranger)).result, 'stranger');
  lock.forget();
  assert.equal(store.saved, undefined);
  assert.deepEqual(await lock.check(stranger), { result: 'open' });
});
