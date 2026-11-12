import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWaker, pmsetDate } from './power.ts';

test('wakes are booked two minutes early, once each, only within the next day', async () => {
  const booked: string[] = [];
  const wake = createWaker(async (date) => booked.push(date));
  const now = new Date('2026-11-12T22:00').getTime();
  const at = (time: string) => new Date(time).getTime();
  await wake([at('2026-11-13T07:00'), at('2026-11-13T07:00:30'), at('2026-11-12T22:01'), at('2026-11-14T08:00')], now);
  await wake([at('2026-11-13T07:00')], now);
  assert.deepEqual(booked, ['11/13/26 06:58:00']);
  assert.equal(pmsetDate(at('2026-01-05T09:07:45')), '01/05/26 09:07:00');
});

test('without the one-time permission it stops trying after the first refusal', async () => {
  let tries = 0;
  const wake = createWaker(async () => {
    tries++;
    throw new Error('sudo: a password is required');
  });
  const now = new Date('2026-11-12T10:00').getTime();
  await wake([now + 3_600_000, now + 7_200_000], now);
  await wake([now + 3_600_000], now);
  assert.equal(tries, 1);
});
