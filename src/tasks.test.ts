import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { lastDue, nextDue, parseDays, Tasks, type TaskDeps } from './tasks.ts';

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const setup = async (start: string, overrides: Partial<TaskDeps> = {}, dbPath?: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tasks-'));
  dirs.push(dir);
  let now = new Date(start);
  const ran: string[] = [];
  const reports: string[] = [];
  const tasks = new Tasks({
    dbPath: dbPath ?? join(dir, 'memory.db'),
    runJob: async (task) => (ran.push(task), `Did: ${task}.`),
    report: (spoken) => reports.push(spoken),
    now: () => now,
    ...overrides,
  });
  const tool = (name: string) => tasks.tools().find((one) => one.name === name)!;
  return { tasks, ran, reports, tool, at: (time: string) => (now = new Date(time)), dbPath: dbPath ?? join(dir, 'memory.db') };
};

test('days are read as daily, weekdays, weekends or a list', () => {
  assert.deepEqual([...parseDays('weekdays')], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseDays('Mon, Wednesday,fri')], [1, 3, 5]);
  assert.throws(() => parseDays('someday'), /must be daily/);
  // Thursday 12 Nov 2026.
  assert.equal(new Date(lastDue({ time: '08:00', days: 'weekdays' }, new Date('2026-11-12T07:00'))).toString(), new Date('2026-11-11T08:00').toString());
  assert.equal(new Date(nextDue({ time: '08:00', days: 'mon' }, new Date('2026-11-12T07:00'))).toString(), new Date('2026-11-16T08:00').toString());
});

test('a scheduled task runs at its time every matching day, once, and reports back', async () => {
  const { tasks, ran, reports, tool, at } = await setup('2026-11-12T07:00');
  assert.match(await tool('schedule_task').run({ task: 'Apply to jobs on LinkedIn', time: '8:00', days: 'weekdays' }), /\[1\] weekdays at 08:00: Apply to jobs on LinkedIn \(next Thu 12 Nov, 08:00\)/);
  tasks.tick();
  assert.deepEqual(ran, [], 'not started at once');
  at('2026-11-12T08:00');
  tasks.tick();
  tasks.tick();
  await tasks.idle();
  assert.deepEqual(ran, ['Apply to jobs on LinkedIn']);
  assert.deepEqual(reports, ['Sir, the scheduled task is done. Did: Apply to jobs on LinkedIn.']);
  at('2026-11-14T08:00'); // Saturday
  tasks.tick();
  at('2026-11-16T08:01'); // Monday
  tasks.tick();
  await tasks.idle();
  assert.equal(ran.length, 2);
  assert.match(await tool('task_results').run({}), /Job 2, started Mon 16 Nov, 08:01: Apply to jobs on LinkedIn\nResult: Did: Apply to jobs on LinkedIn\./);
});

test('a run missed while the Mac slept is done on waking, unless it is over twelve hours late', async () => {
  const { tasks, ran, tool, at } = await setup('2026-11-12T07:00');
  await tool('schedule_task').run({ task: 'Morning job', time: '08:00', days: 'daily' });
  at('2026-11-12T11:30');
  tasks.tick();
  await tasks.idle();
  assert.deepEqual(ran, ['Morning job']);
  at('2026-11-13T20:30');
  tasks.tick();
  await tasks.idle();
  assert.equal(ran.length, 1);
});

test('jobs run one at a time, and a job cut short by a restart is started again', async () => {
  const order: string[] = [];
  const first = await setup('2026-11-12T10:00', {
    runJob: (task) => {
      order.push(`start ${task}`);
      return task === 'A' ? new Promise<string>(() => {}) : Promise.resolve('done'); // A never finishes in this run
    },
  });
  first.tasks.start('A');
  first.tasks.start('B');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ['start A'], 'B waits for A');
  first.tasks.close(); // Jarvis quits with A unfinished and B waiting

  const again = await setup('2026-11-12T11:00', {}, first.dbPath);
  again.tasks.resume();
  await again.tasks.idle();
  assert.deepEqual(again.ran, ['A', 'B']);
});

test('cancelling a scheduled task is asked about; bad schedules are refused', async () => {
  const { tasks, tool } = await setup('2026-11-12T07:00');
  await tool('schedule_task').run({ task: 'Check the news', time: '09:30', days: 'mon,fri' });
  assert.equal(tool('cancel_scheduled_task').approval?.({ id: 1 }), 'remove the scheduled task: Check the news');
  assert.match(await tool('cancel_scheduled_task').run({ id: 1 }), /will not run again/);
  assert.equal(await tool('scheduled_tasks').run({}), 'No tasks are scheduled.');
  await assert.rejects(tool('schedule_task').run({ task: 'x', time: '25:00', days: 'daily' }), /HH:MM/);
  await assert.rejects(tool('schedule_task').run({ task: 'x', time: '09:00', days: 'often' }), /must be daily/);
  assert.deepEqual(tasks.nextRuns(), []);
});

test('a failed job is reported as failed', async () => {
  const { tasks, reports } = await setup('2026-11-12T10:00', { runJob: async () => Promise.reject(new Error('model offline')) });
  tasks.start('x');
  await tasks.idle();
  assert.deepEqual(reports, ['Sir, the background task failed: model offline.']);
});

test('the next runs of scheduled tasks are known, for waking the Mac', async () => {
  const { tasks, tool } = await setup('2026-11-12T07:00');
  await tool('schedule_task').run({ task: 'x', time: '08:00', days: 'weekdays' });
  assert.deepEqual(tasks.nextRuns(), [new Date('2026-11-12T08:00').getTime()]);
});

test('a restarted job is told what it had already done, and is dropped after being cut short three times', async () => {
  const first = await setup('2026-11-12T10:00', {
    runJob: (_task, _done, onStep) => {
      onStep('web_click {"ref":4}: Applied to Acme');
      return new Promise<string>(() => {}); // cut short after one action
    },
  });
  first.tasks.start('Apply to five jobs');
  await new Promise((resolve) => setTimeout(resolve, 5));
  first.tasks.close();

  let told: string[] = [];
  const cutShort = { runJob: (_task: string, done: string[]) => ((told = done), new Promise<string>(() => {})) };
  for (const hour of ['11', '12']) {
    const again = await setup(`2026-11-12T${hour}:00`, cutShort, first.dbPath);
    again.tasks.resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    again.tasks.close();
  }
  assert.deepEqual(told, ['web_click {"ref":4}: Applied to Acme']);

  const last = await setup('2026-11-12T13:00', {}, first.dbPath);
  last.tasks.resume();
  await last.tasks.idle();
  assert.deepEqual(last.ran, [], 'not started a fourth time');
  assert.match(await last.tool('task_results').run({}), /Dropped: it was cut short three times/);
});
