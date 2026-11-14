import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLanguage, sayWith } from './language.ts';

test('a language is found by its English name, its own name or its code; English and unknown ones are not', () => {
  assert.equal(findLanguage('French')?.code, 'fr');
  assert.equal(findLanguage(' español ')?.voice, 'Mónica');
  assert.equal(findLanguage('de')?.name, 'German');
  assert.equal(findLanguage('English'), undefined);
  assert.equal(findLanguage('Klingon'), undefined);
});

test('a Mac voice speaks a sentence and the sound comes back', async () => {
  const speech = await sayWith('Thomas', 'Bonjour, monsieur.');
  assert.equal(speech.sampleRate, 24000);
  assert.ok(speech.samples.length > 12_000, 'at least half a second of sound');
  assert.ok(speech.samples.some((sample) => Math.abs(sample) > 0.05), 'not silence');
});
