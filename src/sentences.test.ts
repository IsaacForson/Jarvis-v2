import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript, sentences } from './sentences.ts';

const split = async (pieces: string[]) => {
  async function* stream() {
    yield* pieces;
  }
  const out: string[] = [];
  for await (const sentence of sentences(stream())) out.push(sentence);
  return out;
};

test('yields each sentence as soon as the next one starts', async () => {
  assert.deepEqual(await split(['Good mor', 'ning, sir. It is ', 'nine. Shall', ' we begin?']), [
    'Good morning, sir.',
    'It is nine.',
    'Shall we begin?',
  ]);
});

test('several sentences in one piece are all split', async () => {
  assert.deepEqual(await split(['One. Two! Three? Four']), ['One.', 'Two!', 'Three?', 'Four']);
});

test('decimals and closing quotes stay inside their sentence', async () => {
  assert.deepEqual(await split(['It is 3.', '5 degrees. He said "stop." Then left.']), [
    'It is 3.5 degrees.',
    'He said "stop."',
    'Then left.',
  ]);
});

test('empty and whitespace-only input yields nothing', async () => {
  assert.deepEqual(await split([]), []);
  assert.deepEqual(await split(['  ', '\n']), []);
});

test('cleanTranscript drops non-speech markers', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(music) What time  is it? [noise]'), 'What time is it?');
});
