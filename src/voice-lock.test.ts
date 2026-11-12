import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrate, type SavedVoice, VoiceLock } from './voice-lock.ts';

// The fake "voiceprint" of a clip is its first two samples, so a test picks the voice directly.
const clip = (x: number, y: number, seconds = 3) => {
  const audio = new Float32Array(seconds * 16_000);
  audio.set([x, y]);
  return audio;
};
const setup = (saved?: SavedVoice) => {
  const store = { saved };
  const lock = new VoiceLock({
    embed: async (audio) => audio.slice(0, 2),
    load: () => store.saved,
    save: (voice) => (store.saved = voice),
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
  // The three clips agree closely, so the pass mark is the highest allowed.
  assert.deepEqual(await lock.check(clip(1, 0.1)), { result: 'enrolled', threshold: 0.88 });
  assert.equal(lock.enrolled, true);
  assert.equal(store.saved?.print.length, 2);
  assert.equal(store.saved?.threshold, 0.88);

  const mine = await lock.check(owner);
  const theirs = await lock.check(stranger);
  assert.ok(mine.result === 'owner' && mine.score > 0.99);
  assert.ok(theirs.result === 'stranger' && theirs.score < 0.3);
});

test('a saved voiceprint is used on the next start, and forgetting removes it', async () => {
  const { lock, store } = setup({ print: [1, 0] });
  assert.equal((await lock.check(stranger)).result, 'stranger');
  lock.forget();
  assert.equal(store.saved, undefined);
  assert.deepEqual(await lock.check(stranger), { result: 'open' });
});

test('the pass mark sits a little under the least alike enrolment clip, within bounds', async () => {
  const at = (degrees: number) => Float32Array.from([Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)]);
  // The clip at 40 degrees scores cos(35 degrees) = 0.82 against the other two, so the mark is 0.77.
  assert.equal(calibrate([at(0), at(10), at(40)]), 0.77);
  assert.equal(calibrate([at(0), at(1), at(2)]), 0.88, 'never so strict that a cold locks him out');
  assert.equal(calibrate([at(0), at(45), at(90)]), 0.7, 'never so loose that anyone passes');

  // A saved pass mark is used on the next start: 0.80 would fail the default 0.82.
  const loose = setup({ print: [1, 0], threshold: 0.75 });
  assert.equal((await loose.lock.check(clip(0.8, 0.6))).result, 'owner');
  assert.equal((await setup({ print: [1, 0] }).lock.check(clip(0.8, 0.6))).result, 'stranger');
});
