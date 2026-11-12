import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSleepCommand, parseWake } from './wake.ts';

test('the name at the start wakes Jarvis, with or without a greeting', () => {
  assert.deepEqual(parseWake('Hey Jarvis.'), { woke: true, rest: '' });
  assert.deepEqual(parseWake('Jarvis, what time is it?'), { woke: true, rest: 'what time is it?' });
  assert.deepEqual(parseWake(' okay, Javis! Are you there?'), { woke: true, rest: 'Are you there?' });
});

test('speech that is not addressed to Jarvis does not wake it', () => {
  for (const text of ['What time is it?', 'I told him about Jarvis yesterday.', 'Hey Jarvison', '']) {
    assert.equal(parseWake(text).woke, false, text);
  }
});

test('short dismissals put Jarvis to sleep', () => {
  for (const text of ['Go to sleep, Jarvis.', 'Stop listening.', 'Goodnight Jarvis', "That's all, Jarvis.", 'Jarvis, go quiet']) {
    assert.equal(isSleepCommand(text), true, text);
  }
});

test('ordinary sentences that mention sleep do not', () => {
  for (const text of ['I want to go to sleep early tonight, remind me.', 'How do I sleep better?', 'Listen to this.']) {
    assert.equal(isSleepCommand(text), false, text);
  }
});
