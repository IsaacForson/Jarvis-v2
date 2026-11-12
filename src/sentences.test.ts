import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTranscript, sentences, speakable } from './sentences.ts';

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

test('a markdown list is spoken as plain items, without symbols or numbers', async () => {
  assert.deepEqual(await split(['Here is **your** list:\n', '- Eggs\n- *Milk*\n', '1. Bread\n2. `Tea`\n', '### Done - enjoy.']), [
    'Here is your list:',
    'Eggs',
    'Milk',
    'Bread',
    'Tea',
    'Done, enjoy.',
  ]);
});

test('symbols on their own are skipped, but a bare number is still an answer', async () => {
  assert.deepEqual(await split(['---\n', '***\n', '4.']), ['4.']);
});

test('speakable keeps ordinary words, hyphens and link labels', () => {
  assert.equal(speakable('A well-known [site](https://example.com) costs -5 or 3.5.'), 'A well-known site costs -5 or 3.5.');
});
