import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandRecurrence } from './rrule.ts';

const at = (text: string) => new Date(text);
const days = (dates: Date[]) => dates.map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`);
// A window of one week: Monday 9 Nov to Monday 16 Nov 2026.
const from = at('2026-11-09T00:00');
const to = at('2026-11-16T00:00');

test('a daily event appears every day, at its original time', () => {
  assert.deepEqual(days(expandRecurrence(at('2026-01-05T09:30'), 'FREQ=DAILY;INTERVAL=3', from, to)), ['2026-11-10 09:30', '2026-11-13 09:30']);
});

test('a weekly event repeats on its own weekday, or on the listed days', () => {
  assert.deepEqual(days(expandRecurrence(at('2025-03-06T14:00'), 'FREQ=WEEKLY', from, to)), ['2026-11-12 14:00']);
  assert.deepEqual(days(expandRecurrence(at('2026-11-02T10:00'), 'FREQ=WEEKLY;BYDAY=MO,WE,FR', from, to)), ['2026-11-09 10:00', '2026-11-11 10:00', '2026-11-13 10:00']);
});

test('every second week skips the weeks in between', () => {
  assert.deepEqual(days(expandRecurrence(at('2026-11-03T10:00'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', from, to)), []);
  assert.deepEqual(days(expandRecurrence(at('2026-10-27T10:00'), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', from, to)), ['2026-11-10 10:00']);
});

test('monthly events: by date, by "second Tuesday", and by "last Friday"', () => {
  assert.deepEqual(days(expandRecurrence(at('2026-01-12T08:00'), 'FREQ=MONTHLY', from, to)), ['2026-11-12 08:00']);
  assert.deepEqual(days(expandRecurrence(at('2026-01-13T08:00'), 'FREQ=MONTHLY;BYDAY=2TU', from, to)), ['2026-11-10 08:00']);
  assert.deepEqual(days(expandRecurrence(at('2026-01-30T08:00'), 'FREQ=MONTHLY;BYDAY=-1FR', at('2026-11-23T00:00'), at('2026-11-30T00:00'))), ['2026-11-27 08:00']);
});

test('a yearly event appears on its anniversary', () => {
  assert.deepEqual(days(expandRecurrence(at('1990-11-14T00:00'), 'FREQ=YEARLY', from, to)), ['2026-11-14 00:00']);
});

test('UNTIL and COUNT end a series', () => {
  assert.deepEqual(days(expandRecurrence(at('2026-11-01T09:00'), 'FREQ=DAILY;UNTIL=20261110T235959Z', from, to)), ['2026-11-09 09:00', '2026-11-10 09:00']);
  assert.deepEqual(days(expandRecurrence(at('2026-11-07T09:00'), 'FREQ=DAILY;COUNT=4', from, to)), ['2026-11-09 09:00', '2026-11-10 09:00']);
});

test('the first occurrence itself is included, and unknown rules yield nothing', () => {
  assert.deepEqual(days(expandRecurrence(at('2026-11-11T15:00'), 'FREQ=WEEKLY', from, to)), ['2026-11-11 15:00']);
  assert.deepEqual(expandRecurrence(at('2026-11-11T15:00'), 'FREQ=HOURLY', from, to), []);
});
