import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWav, encodeWav, resample } from './wav.ts';

test('encodeWav writes a valid 16-bit mono header and clamps loud samples', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -1, 2]), 16000);
  const view = new DataView(wav.buffer);
  const text = (from: number, to: number) => new TextDecoder().decode(wav.subarray(from, to));
  assert.equal(wav.length, 44 + 8);
  assert.equal(text(0, 4) + text(8, 16) + text(36, 40), 'RIFFWAVEfmt data');
  assert.equal(view.getUint32(4, true), 36 + 8);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true)), [0, 16384, -32767, 32767]);
});

test('resample changes the length by the rate ratio and keeps the shape', () => {
  const out = resample(new Float32Array([0, 3, 6, 9, 12, 15]), 24000, 16000);
  assert.deepEqual([...out], [0, 4.5, 9, 13.5]);
  const same = new Float32Array([1, 2]);
  assert.equal(resample(same, 16000, 16000), same);
});

test('decodeWav reads back what encodeWav wrote, and refuses what is not a WAV', () => {
  const { samples, sampleRate } = decodeWav(encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 24000));
  assert.equal(sampleRate, 24000);
  assert.deepEqual([...samples].map((value) => Math.round(value * 100) / 100), [0, 0.5, -0.5, 1]);
  assert.throws(() => decodeWav(new Uint8Array(60)), /Not a WAV/);
});
