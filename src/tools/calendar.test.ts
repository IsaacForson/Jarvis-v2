import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCalendar, describeEvents, eventsInWindow } from './calendar.ts';

const local = (text: string) => new Date(text).toISOString();
const from = new Date('2026-11-12T00:00');
const to = new Date('2026-11-13T00:00');

test('one-off and repeating events are merged in time order, with the repeat moved to its day', () => {
  const events = eventsInWindow(
    [
      { calendar: 'Work', title: 'Design review', start: local('2026-11-12T15:00'), end: local('2026-11-12T16:00'), allDay: false, rule: null, place: 'Room 2' },
      { calendar: 'Work', title: 'Stand-up', start: local('2026-01-05T09:00'), end: local('2026-01-05T09:15'), allDay: false, rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', place: null },
      { calendar: 'Home', title: 'Old dentist visit', start: local('2026-11-01T10:00'), end: local('2026-11-01T11:00'), allDay: false, rule: null, place: null },
      { calendar: 'Home', title: 'Holiday', start: local('2026-11-12T00:00'), end: local('2026-11-13T00:00'), allDay: true, rule: null, place: null },
    ],
    from,
    to,
  );
  assert.equal(
    describeEvents(events),
    [
      'Thursday 12 November, all day: Holiday [Home calendar]',
      'Thursday 12 November, 09:00 to 09:15: Stand-up [Work calendar]',
      'Thursday 12 November, 15:00 to 16:00: Design review (at Room 2) [Work calendar]',
    ].join('\n'),
  );
});

test('an empty period says so', () => {
  assert.equal(describeEvents(eventsInWindow([], from, to)), 'No events in that period.');
});

test('the tool answers from its copy while fresh, and reads the app again once it is stale', async () => {
  let clock = new Date('2026-11-12T08:00').getTime();
  let reads = 0;
  const calendar = createCalendar(async () => {
    reads++;
    return [{ calendar: 'Work', title: `Review ${reads}`, start: local('2026-11-12T15:00'), end: local('2026-11-12T16:00'), allDay: false, rule: null, place: null }];
  }, () => clock);

  await calendar.refresh(); // the background read at start-up
  assert.match(await calendar.tool.run({ days: 1 }), /Review 1/);
  assert.match(await calendar.tool.run({}), /Review 1/);
  assert.equal(reads, 1, 'no second read while the copy is fresh');

  clock += 11 * 60_000;
  assert.match(await calendar.tool.run({ days: 1 }), /Review 2/);
  await assert.rejects(calendar.tool.run({ days: 99 }), /whole number from 1 to 31/);
});

test('two refreshes at once share one read of the app', async () => {
  let reads = 0;
  const calendar = createCalendar(async () => {
    reads++;
    return [];
  });
  await Promise.all([calendar.refresh(), calendar.refresh()]);
  assert.equal(reads, 1);
});

test('an event is added with its values passed as data, and asked about by name and time', async () => {
  const scripts: string[] = [];
  const calendar = createCalendar(async () => [], () => new Date('2026-11-12T09:00').getTime(), async (script) => (scripts.push(script), 'Work'));
  assert.equal(calendar.addTool.approval?.({ title: 'Dentist', start: '2026-11-13T15:00' }), 'add Dentist to your calendar on Fri 13 Nov, 15:00');
  assert.equal(await calendar.addTool.run({ title: 'Dentist"); evil(', start: '2026-11-13T15:00', minutes: 30 }), 'Added to the Work calendar: Dentist"); evil(, Fri 13 Nov, 15:00, for 30 minutes.');
  assert.match(scripts[0]!, /"title":"Dentist\\"\); evil\("/, 'a quote in the title cannot end the string and run as code');
  assert.match(scripts[0]!, new RegExp(`"end":${new Date('2026-11-13T15:30').getTime()}`));
  await assert.rejects(calendar.addTool.run({ title: 'x', start: 'tomorrow' }), /must be a date and time/);
});
