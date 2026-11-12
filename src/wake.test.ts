import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isForgetVoiceCommand, isLearnVoiceCommand, isSleepCommand, parseWake } from './wake.ts';

test('a name at the start says who is addressed, with or without a greeting', () => {
  assert.deepEqual(parseWake('Hey Jarvis.'), { name: 'jarvis', rest: '' });
  assert.deepEqual(parseWake('Jarvis, what time is it?'), { name: 'jarvis', rest: 'what time is it?' });
  assert.deepEqual(parseWake(' okay, Javis! Are you there?'), { name: 'jarvis', rest: 'Are you there?' });
  assert.deepEqual(parseWake('Friday, are you there?'), { name: 'friday', rest: 'are you there?' });
  assert.deepEqual(parseWake('Hey Friday'), { name: 'friday', rest: '' });
});

test('speech that is not addressed to either is left as it is', () => {
  for (const text of ['What time is it?', 'I told him about Jarvis yesterday.', 'Hey Jarvison', 'See you on Friday.', '']) {
    assert.deepEqual(parseWake(text), { rest: text }, text);
  }
});

test('short dismissals are sleep commands', () => {
  for (const text of ['Go to sleep.', 'Stop listening.', 'Goodnight', "That's all.", 'go quiet']) {
    assert.equal(isSleepCommand(text), true, text);
  }
});

test('ordinary sentences that mention sleep are not', () => {
  for (const text of ['I want to go to sleep early tonight, remind me.', 'How do I sleep better?', 'Listen to this.']) {
    assert.equal(isSleepCommand(text), false, text);
  }
});

test('voice-lock commands are recognised, and long sentences about voices are not', () => {
  assert.equal(isLearnVoiceCommand('Learn my voice.'), true);
  assert.equal(isLearnVoiceCommand('Please remember my voice'), true);
  assert.equal(isForgetVoiceCommand('Forget my voice.'), true);
  assert.equal(isLearnVoiceCommand('Forget my voice.'), false);
  assert.equal(isLearnVoiceCommand('Do you think a computer could ever learn to copy my voice exactly?'), false);
});
