import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureTurn, median } from './timing.ts';

// Each piece "arrives" 100 ms after the previous one on a fake clock.
const timed = (pieces: string[]) => {
  let clock = 0;
  async function* stream() {
    for (const piece of pieces) {
      clock += 100;
      yield piece;
    }
  }
  return measureTurn(stream(), () => clock);
};

test('times the first text, the first whole sentence and the full reply', async () => {
  const timing = await timed(['Good', ' morning', ', sir.', ' It is', ' nine.']);
  assert.deepEqual(timing, {
    firstTextMs: 100,
    firstSentenceMs: 400, // known once the piece after "sir." arrives
    totalMs: 500,
    text: 'Good morning, sir. It is nine.',
  });
});

test('a decimal point does not count as the end of a sentence', async () => {
  const timing = await timed(['It is 3.', '5 degrees', ' outside.', ' Cold.']);
  assert.equal(timing.firstSentenceMs, 400);
});

test('a reply with no sentence ending is speakable only when complete', async () => {
  const timing = await timed(['On it', ' sir']);
  assert.equal(timing.firstSentenceMs, timing.totalMs);
});

test('an empty reply is an error, not a zero', async () => {
  await assert.rejects(timed([]), /no text/);
});

test('median handles odd, even and empty lists', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), RangeError);
});
