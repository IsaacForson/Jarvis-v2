import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { briefingTime, chase, Initiative, type InitiativeDeps, type Mail } from './initiative.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** An initiative with a settable clock that records what it says. */
const setup = async (start: string, overrides: Partial<InitiativeDeps> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-initiative-'));
  dirs.push(dir);
  let now = new Date(start);
  const said: string[] = [];
  const briefings: string[] = [];
  let busy = false;
  const initiative = new Initiative({
    dbPath: join(dir, 'memory.db'),
    announce: async (text) => (busy ? false : (said.push(text), true)),
    initiate: async (instruction) => (busy ? false : (briefings.push(instruction), true)),
    now: () => now,
    ...overrides,
  });
  const tool = (name: string) => initiative.tools().find((one) => one.name === name)!;
  return {
    initiative,
    said,
    briefings,
    tool,
    at: (time: string) => (now = new Date(time)),
    setBusy: (value: boolean) => (busy = value),
  };
};

test('a reminder is spoken at its time and chased, firmer and sooner, until it is done', async () => {
  const { initiative, said, tool, at } = await setup('2026-11-12T10:00');
  assert.match(await tool('set_reminder').run({ text: 'call Dana', at: '2026-11-12T10:30' }), /Reminder 1 set for Thu 12 Nov, 10:30/);
  await initiative.tick();
  assert.deepEqual(said, []);
  at('2026-11-12T10:30');
  await initiative.tick();
  await initiative.tick();
  assert.deepEqual(said, ['Sir, a reminder: call Dana.'], 'said once, not on every tick');
  at('2026-11-12T11:00');
  await initiative.tick();
  at('2026-11-12T11:15');
  await initiative.tick();
  assert.deepEqual(said.slice(1), ['Sir, just checking: call Dana. Is it done?', 'Sir, call Dana is still waiting.']);
  assert.match(await tool('reminders').run({}), /\[1\] .*call Dana \(already said, waiting on him\)/);
  await tool('reminder_done').run({ id: 1 });
  at('2026-11-12T13:00');
  await initiative.tick();
  assert.equal(said.length, 3);
  assert.equal(await tool('reminders').run({}), 'No reminders or alarms are set.');
});

test('an alarm repeats every minute until he answers; a daily one comes back tomorrow', async () => {
  const { initiative, said, tool, at } = await setup('2026-11-12T06:00');
  await tool('set_reminder').run({ text: 'Time to get up', at: '2026-11-12T06:30', alarm: true, daily: true });
  at('2026-11-12T06:30');
  await initiative.tick();
  at('2026-11-12T06:31');
  await initiative.tick();
  assert.deepEqual(said, ['Sir, it is 06:30. Time to get up.', 'Sir, your alarm: Time to get up. It is 06:31.'], 'alarms ring in quiet hours');
  initiative.heard();
  at('2026-11-12T06:40');
  await initiative.tick();
  assert.equal(said.length, 2);
  assert.match(await tool('reminders').run({}), /Fri 13 Nov, 06:30: alarm, Time to get up \(every day\)/);
});

test('overnight a reminder waits for the morning, and nothing is said while Jarvis is busy', async () => {
  const { initiative, said, tool, at, setBusy } = await setup('2026-11-12T22:00');
  await tool('set_reminder').run({ text: 'water the plants', in_minutes: 90 });
  at('2026-11-12T23:30');
  await initiative.tick();
  assert.deepEqual(said, []);
  assert.match(await tool('reminders').run({}), /Fri 13 Nov, 07:00: water the plants/);
  at('2026-11-13T07:00');
  setBusy(true);
  await initiative.tick();
  assert.deepEqual(said, []);
  setBusy(false);
  await initiative.tick();
  assert.deepEqual(said, ['Sir, a reminder: water the plants.']);
});

test('snoozing puts it off; bad times are refused', async () => {
  const { initiative, said, tool, at } = await setup('2026-11-12T10:00');
  await tool('set_reminder').run({ text: 'stretch', in_minutes: 5 });
  at('2026-11-12T10:05');
  await initiative.tick();
  assert.match(await tool('snooze_reminder').run({ id: 1, minutes: 20 }), /Snoozed until 10:25/);
  at('2026-11-12T10:20');
  await initiative.tick();
  at('2026-11-12T10:25');
  await initiative.tick();
  assert.deepEqual(said, ['Sir, a reminder: stretch.', 'Sir, just checking: stretch. Is it done?']);
  await assert.rejects(tool('set_reminder').run({ text: 'x', at: '2026-11-12T09:00' }), /already passed/);
  await assert.rejects(tool('set_reminder').run({ text: 'x', at: 'soon' }), /must be a date/);
  await assert.rejects(tool('reminder_done').run({ id: 9 }), /no reminder 9/);
});

test('the morning briefing runs once a day at its time, not in quiet hours, and waits if busy', async () => {
  const { initiative, briefings, at, setBusy, tool } = await setup('2026-11-12T06:59', { briefingAt: '07:30' });
  await tool('set_reminder').run({ text: 'call the bank', at: '2026-11-12T15:00' });
  await tool('set_reminder').run({ text: 'dentist', at: '2026-11-14T09:00' });
  await initiative.tick();
  at('2026-11-12T07:29');
  await initiative.tick();
  assert.equal(briefings.length, 0);
  at('2026-11-12T07:30');
  setBusy(true);
  await initiative.tick();
  setBusy(false);
  at('2026-11-12T07:31');
  await initiative.tick();
  await initiative.tick();
  assert.equal(briefings.length, 1);
  assert.match(briefings[0]!, /calendar.*email.*weather.*reminders/);
  assert.match(briefings[0]!, /His reminders and alarms for today: 15:00 call the bank\./);
  at('2026-11-13T07:45');
  await initiative.tick();
  assert.equal(briefings.length, 2);
});

test('urgent new email is spoken about unasked, once; other mail and old mail are not', async () => {
  const mail: Mail[] = [
    { id: 1, from: 'Old Friend <old@example.com>', subject: 'URGENT from last week', received: '2026-11-05T10:00:00' },
    { id: 2, from: 'Dana Smith <dana@work.com>', subject: 'URGENT: server down', received: '2026-11-12T09:55:00' },
    { id: 3, from: 'Shop <deals@shop.com>', subject: 'Big sale', received: '2026-11-12T09:58:00' },
  ];
  const asked: number[] = [];
  const { initiative, said, at } = await setup('2026-11-12T10:00', {
    unreadMail: async () => mail,
    isUrgent: async (one) => (asked.push(one.id), /urgent/i.test(one.subject)),
  });
  await initiative.tick();
  assert.deepEqual(said, ['Sir, an urgent email from Dana Smith: URGENT: server down.']);
  assert.deepEqual(asked, [2, 3], 'mail older than two hours is left for the briefing');
  mail.push({ id: 4, from: 'boss@work.com', subject: 'Urgent: call me', received: '2026-11-12T10:03:00' });
  at('2026-11-12T10:02');
  await initiative.tick();
  assert.equal(said.length, 1, 'mail is checked every five minutes');
  at('2026-11-12T10:05');
  await initiative.tick();
  assert.deepEqual(said.slice(1), ['Sir, an urgent email from boss@work.com: Urgent: call me.']);
  assert.deepEqual(asked, [2, 3, 4], 'each email is judged once');
});

test('a meeting is announced ten minutes ahead, once', async () => {
  const event = { calendar: 'Work', title: 'Standup', start: new Date('2026-11-12T10:15'), end: new Date('2026-11-12T10:30'), allDay: false, place: 'Room 2' };
  const { initiative, said, at } = await setup('2026-11-12T10:00', { upcoming: async () => [event] });
  await initiative.tick();
  assert.deepEqual(said, []);
  at('2026-11-12T10:06');
  await initiative.tick();
  at('2026-11-12T10:07');
  await initiative.tick();
  assert.deepEqual(said, ['Sir, Standup starts in 9 minutes, at Room 2.']);
});

test('wellbeing: a break after ninety minutes of work, and a word after midnight', async () => {
  let idle = 0;
  const { initiative, said, at } = await setup('2026-11-12T14:00', { idleSeconds: async () => idle });
  await initiative.tick();
  at('2026-11-12T15:00');
  idle = 600; // a ten-minute break resets the stretch
  await initiative.tick();
  idle = 0;
  at('2026-11-12T15:10');
  await initiative.tick();
  at('2026-11-12T16:39');
  await initiative.tick();
  assert.deepEqual(said, []);
  at('2026-11-12T16:40');
  await initiative.tick();
  assert.deepEqual(said, ['You have been at it for an hour and a half without a break, sir. Stretch your legs, perhaps?']);
  at('2026-11-13T00:20');
  idle = 600;
  await initiative.tick();
  idle = 0;
  await initiative.tick();
  await initiative.tick();
  assert.deepEqual(said.slice(1), ['It is 00:20, sir. Past midnight. Time to call it a night, perhaps?']);
});

test('reminders get firmer each time they are said', () => {
  const now = new Date('2026-11-12T09:00');
  assert.equal(chase({ text: 'pay rent', level: 3, alarm: 0 }, now), 'Sir, I must insist: pay rent. Say done, snooze it, or drop it.');
  assert.equal(chase({ text: 'pay rent', level: 9, alarm: 0 }, now), 'Sir, I must insist: pay rent. Say done, snooze it, or drop it.');
});

test('a briefing missed while the Mac slept is given when it is back, but not in quiet hours', async () => {
  const { initiative, briefings, at } = await setup('2026-11-12T23:10', { briefingAt: '08:30' });
  await initiative.tick();
  assert.equal(briefings.length, 0);
  at('2026-11-13T15:00');
  await initiative.tick();
  assert.equal(briefings.length, 1);
});

test('the times to wake the Mac for: reminders and the next briefing', async () => {
  const { tool, initiative } = await setup('2026-11-12T10:00', { briefingAt: '08:00' });
  await tool('set_reminder').run({ text: 'call Dana', at: '2026-11-12T15:00' });
  assert.deepEqual(initiative.nextTimes().map((time) => new Date(time).toString()), [new Date('2026-11-12T15:00').toString(), new Date('2026-11-13T08:00').toString()]);
});

test('a failed build or deployment is spoken about once, if it is recent', async () => {
  const failures = [
    { id: 'run 1', text: 'the CI run on shop, branch main, failed', at: new Date('2026-11-12T09:50').getTime() },
    { id: 'deploy 2', text: 'the production deployment of shop failed', at: new Date('2026-11-10T09:00').getTime() },
  ];
  const { initiative, said, at } = await setup('2026-11-12T10:00', { failures: async () => failures });
  await initiative.tick();
  at('2026-11-12T10:06');
  await initiative.tick();
  assert.deepEqual(said, ['Sir, the CI run on shop, branch main, failed.']);
});

test('an urgent email is chased until it is read', async () => {
  let mail: Mail[] = [{ id: 7, from: 'Dana <dana@work.com>', subject: 'Contract today', received: '2026-11-12T09:59:00' }];
  const { initiative, said, at, tool } = await setup('2026-11-12T10:00', { unreadMail: async () => mail, isUrgent: async () => true });
  await initiative.tick();
  assert.match(await tool('reminders').run({}), /12:00: reply to Dana about "Contract today"/);
  at('2026-11-12T12:00');
  await initiative.tick();
  assert.equal(said.at(-1), 'Sir, a reminder: reply to Dana about "Contract today".');
  mail = []; // he has read it
  at('2026-11-12T12:30');
  await initiative.tick();
  assert.equal(said.length, 2, 'not chased again once read');
  assert.equal(await tool('reminders').run({}), 'No reminders or alarms are set.');
});

test('an email that could not be judged is looked at again, and the others are not announced twice', async () => {
  const mail: Mail[] = [
    { id: 1, from: 'Dana <dana@work.com>', subject: 'Urgent: sign today', received: '2026-11-12T09:55:00' },
    { id: 2, from: 'Sam <sam@work.com>', subject: 'Urgent: call me', received: '2026-11-12T09:56:00' },
  ];
  let down = true;
  const { initiative, said, tool, at } = await setup('2026-11-12T10:00', {
    unreadMail: async () => mail,
    isUrgent: async (one) => {
      if (one.id === 2 && down) throw new Error('model unreachable');
      return true;
    },
  });
  await initiative.tick();
  down = false;
  at('2026-11-12T10:06');
  await initiative.tick();
  assert.deepEqual(said, ['Sir, an urgent email from Dana: Urgent: sign today.', 'Sir, an urgent email from Sam: Urgent: call me.']);
  assert.equal((await tool('reminders').run({})).split('\n').length, 2, 'one follow-up each');
});

test('a mistyped briefing time means 08:00', () => {
  assert.deepEqual(briefingTime('7:30'), [7, 30]);
  for (const bad of [undefined, '', '8am', '25:00', '08:61']) assert.deepEqual(briefingTime(bad), [8, 0]);
});

test('the evening recap is given once, after its time, and only while he is at the Mac', async () => {
  let idle = 600;
  const { initiative, briefings, at, tool } = await setup('2026-11-12T20:59', { briefingAt: '08:00', recapAt: '21:00', idleSeconds: async () => idle });
  await tool('set_reminder').run({ text: 'call Dana', at: '2026-11-13T10:00' });
  const recaps = () => briefings.filter((one) => /evening recap/.test(one));
  await initiative.tick();
  at('2026-11-12T21:00');
  await initiative.tick();
  assert.equal(recaps().length, 0, 'not before its time, and not to an empty room');
  idle = 5;
  await initiative.tick();
  await initiative.tick();
  assert.equal(recaps().length, 1);
  assert.match(recaps()[0]!, /his reminders: Fri 13 Nov, 10:00 call Dana/);
  at('2026-11-13T21:30');
  await initiative.tick();
  assert.equal(recaps().length, 2, 'and again the next evening');
});
