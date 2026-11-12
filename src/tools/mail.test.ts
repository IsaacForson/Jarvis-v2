import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUnread } from './mail.ts';

const mail = [
  { id: 7, from: 'Ama <ama@example.com>', subject: 'Invoice overdue', received: new Date('2026-11-12T08:05').toISOString() },
  { id: 9, from: 'Kofi <kofi@example.com>', subject: '', received: new Date('2026-11-12T11:40').toISOString() },
  { id: 3, from: 'News <news@example.com>', subject: 'Weekly digest', received: new Date('2026-11-10T06:00').toISOString() },
];

test('unread email is listed newest first with ids, and the cap is stated', () => {
  assert.equal(
    describeUnread(mail, 2),
    ['3 unread emails, newest 2 shown:', '[id 9] Thu 12 Nov, 11:40, from Kofi <kofi@example.com>: (no subject)', '[id 7] Thu 12 Nov, 08:05, from Ama <ama@example.com>: Invoice overdue'].join('\n'),
  );
});

test('an empty inbox says so', () => {
  assert.equal(describeUnread([], 10), 'No unread email.');
});
