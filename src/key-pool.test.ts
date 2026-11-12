import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AllKeysCoolingError, KeyPool, parseKeys } from './key-pool.ts';

test('parseKeys splits on commas and whitespace and drops duplicates and blanks', () => {
  assert.deepEqual(parseKeys(' a, b,,a\n c '), ['a', 'b', 'c']);
  assert.deepEqual(parseKeys(undefined), []);
});

test('an empty pool is refused', () => {
  assert.throws(() => new KeyPool([]), /No API keys/);
});

test('keys are handed out in turn and wrap around', () => {
  const pool = new KeyPool(['a', 'b', 'c']);
  assert.deepEqual([1, 2, 3, 4].map(() => pool.next().key), ['a', 'b', 'c', 'a']);
});

test('a cooling key is skipped until its cooldown ends', () => {
  let now = 0;
  const pool = new KeyPool(['a', 'b'], () => now);
  pool.cooldown(pool.next().index); // a hits its limit
  assert.deepEqual([pool.next().key, pool.next().key], ['b', 'b']);
  now = 60_000;
  assert.deepEqual([pool.next().key, pool.next().key], ['a', 'b']);
});

test('when every key is cooling the error says how long to wait', () => {
  let now = 0;
  const pool = new KeyPool(['a', 'b'], () => now);
  pool.cooldown(0);
  now = 20_000;
  pool.cooldown(1);
  assert.throws(() => pool.next(), (error: unknown) => {
    assert.ok(error instanceof AllKeysCoolingError);
    assert.equal(error.retryInMs, 40_000);
    return true;
  });
});

test('cooldown rejects an index that is not in the pool', () => {
  assert.throws(() => new KeyPool(['a']).cooldown(1), RangeError);
});
