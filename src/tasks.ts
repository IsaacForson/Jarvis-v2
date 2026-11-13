import { DatabaseSync } from 'node:sqlite';
import { integer, text, type Tool } from './tools/types.ts';

type Scheduled = { id: number; task: string; time: string; days: string; last: number };
type Job = { id: number; task: string; created: number; finished: number | null; result: string | null; scheduled: number | null; steps: string; restarts: number };

export type TaskDeps = {
  dbPath: string;
  /**
   * Does one job to the end with the tools, and returns its spoken summary. `done` lists the actions
   * carried out before a restart; `onStep` is called after each new one.
   */
  runJob(task: string, done: string[], onStep: (step: string) => void): Promise<string>;
  /** Says the outcome when Jarvis is free. */
  report(text: string, note: string): void;
  now?: () => Date;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A run missed while the Mac was asleep or off is still done if it is at most this late. */
const CATCH_UP = 12 * 60 * MINUTE;
/** Unfinished jobs older than this are not restarted after Jarvis restarts. */
const RESUME = DAY;
/** A job that has been cut short this often is given up on: it may be what is stopping Jarvis. */
const MAX_RESTARTS = 2;
/** Only the latest actions are handed to a restarted job. */
const MAX_STEPS = 60;
const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** "daily", "weekdays", "weekends" or days such as "mon,wed,fri", as a set of day numbers (0 is Sunday). */
export function parseDays(days: string): Set<number> {
  const value = days.trim().toLowerCase();
  if (value === 'daily' || value === 'every day') return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (value === 'weekdays') return new Set([1, 2, 3, 4, 5]);
  if (value === 'weekends') return new Set([0, 6]);
  const listed = value.split(/[\s,]+/).filter(Boolean).map((day) => NAMES.indexOf(day.slice(0, 3)));
  if (listed.length === 0 || listed.includes(-1)) throw new Error('"days" must be daily, weekdays, weekends, or days such as "mon,wed,fri"');
  return new Set(listed);
}

/** The latest time at or before `now` when this schedule was due. */
export function lastDue(schedule: Pick<Scheduled, 'time' | 'days'>, now: Date): number {
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
  const days = parseDays(schedule.days);
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hours, minutes);
    if (day <= now && days.has(day.getDay())) return day.getTime();
  }
  return 0;
}

/** The next time after `now` when this schedule is due. */
export function nextDue(schedule: Pick<Scheduled, 'time' | 'days'>, now: Date): number {
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
  const days = parseDays(schedule.days);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, hours, minutes);
    if (day > now && days.has(day.getDay())) return day.getTime();
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Jobs Jarvis does on its own: background tasks started on request, and tasks repeated on a schedule
 * ("apply to jobs on LinkedIn every weekday at 8"). Everything is kept on disk, so a job cut short by
 * a restart is started again and a run missed while the Mac was asleep is done when it wakes. Jobs
 * run one at a time, since they share one browser window.
 */
export class Tasks {
  readonly #deps: TaskDeps;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: TaskDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#db = new DatabaseSync(deps.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled (id INTEGER PRIMARY KEY, task TEXT NOT NULL, time TEXT NOT NULL, days TEXT NOT NULL, last INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, task TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER, result TEXT, scheduled INTEGER);`);
    // Added later: what a job has done so far, and how often a restart has cut it short.
    const columns = (this.#db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('steps')) this.#db.exec("ALTER TABLE jobs ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'");
    if (!columns.includes('restarts')) this.#db.exec('ALTER TABLE jobs ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0');
  }

  /** Records a job and queues it behind any job already running. Returns its number. */
  start(task: string, scheduled?: number): number {
    const { lastInsertRowid } = this.#db.prepare('INSERT INTO jobs (task, created, scheduled) VALUES (?, ?, ?)').run(task, this.#now().getTime(), scheduled ?? null);
    const id = Number(lastInsertRowid);
    this.#queue({ id, task, scheduled: scheduled ?? null, steps: '[]' });
    return id;
  }

  #queue(job: Pick<Job, 'id' | 'task' | 'scheduled' | 'steps'>): void {
    this.#chain = this.#chain.then(async () => {
      let result: string;
      let spoken: string;
      const steps = JSON.parse(job.steps) as string[];
      const record = (step: string) => {
        steps.push(step);
        this.#db.prepare('UPDATE jobs SET steps = ? WHERE id = ?').run(JSON.stringify(steps.slice(-MAX_STEPS)), job.id);
      };
      try {
        result = await this.#deps.runJob(job.task, steps.slice(-MAX_STEPS), record);
        spoken = `Sir, the ${job.scheduled ? 'scheduled' : 'background'} task is done. ${result}`;
      } catch (error) {
        result = `Failed: ${error instanceof Error ? error.message : String(error)}`;
        spoken = `Sir, the ${job.scheduled ? 'scheduled' : 'background'} task failed: ${error instanceof Error ? error.message : String(error)}.`;
      }
      this.#db.prepare('UPDATE jobs SET finished = ?, result = ? WHERE id = ?').run(this.#now().getTime(), result, job.id);
      this.#deps.report(spoken, `This was job ${job.id}: ${job.task}`);
    });
  }

  /** Waits until every queued job has finished. */
  idle(): Promise<void> {
    return this.#chain;
  }

  /** Starts again the jobs a restart cut short, if they are recent; older ones are marked as dropped. */
  resume(): void {
    const now = this.#now().getTime();
    for (const job of this.#db.prepare('SELECT * FROM jobs WHERE finished IS NULL ORDER BY id').all() as Job[]) {
      if (now - job.created > RESUME) this.#db.prepare("UPDATE jobs SET finished = ?, result = 'Dropped: Jarvis was off for too long' WHERE id = ?").run(now, job.id);
      else if (job.restarts >= MAX_RESTARTS) this.#db.prepare("UPDATE jobs SET finished = ?, result = 'Dropped: it was cut short three times' WHERE id = ?").run(now, job.id);
      else {
        this.#db.prepare('UPDATE jobs SET restarts = restarts + 1 WHERE id = ?').run(job.id);
        this.#queue(job);
      }
    }
  }

  /** Starts scheduled tasks that are due, including runs missed by up to twelve hours. */
  tick(): void {
    const now = this.#now();
    for (const schedule of this.#db.prepare('SELECT * FROM scheduled').all() as Scheduled[]) {
      const due = lastDue(schedule, now);
      if (due > schedule.last && now.getTime() - due <= CATCH_UP) {
        this.#db.prepare('UPDATE scheduled SET last = ? WHERE id = ?').run(now.getTime(), schedule.id);
        this.start(schedule.task, schedule.id);
      }
    }
  }

  /** When the scheduled tasks are next due, for waking the Mac in time. */
  nextRuns(): number[] {
    const now = this.#now();
    return (this.#db.prepare('SELECT * FROM scheduled').all() as Scheduled[]).map((schedule) => nextDue(schedule, now));
  }

  tools(): Tool[] {
    const describe = (schedule: Scheduled) => `[${schedule.id}] ${schedule.days} at ${schedule.time}: ${schedule.task} (next ${when.format(nextDue(schedule, this.#now()))})`;
    return [
      {
        name: 'background_task',
        description:
          'Start a long job that runs in the background while he does other things, such as researching a topic across several pages, comparing options, applying to jobs or tidying files, using the same tools. Describe the whole task and what to report. The outcome is spoken when it is done; say so now and carry on.',
        parameters: { type: 'object', properties: { task: { type: 'string', description: 'The complete task, with every detail needed' } }, required: ['task'] },
        run: async (args) => `Background task ${this.start(text(args, 'task'))} started. Its outcome will be spoken when it is done.`,
      },
      {
        name: 'schedule_task',
        description:
          'Make a job repeat on a schedule, done in the background like background_task, e.g. "Open LinkedIn and apply to five new full-stack engineer jobs that fit his profile, then report which" every weekday at 08:00. Write the task in full, as instructions for doing it alone. Runs missed while the Mac was asleep are done when it wakes.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The complete task, with every detail needed' },
            time: { type: 'string', description: 'Local time, HH:MM (24-hour)' },
            days: { type: 'string', description: 'daily, weekdays, weekends, or days such as "mon,wed,fri"' },
          },
          required: ['task', 'time', 'days'],
        },
        run: async (args) => {
          const time = text(args, 'time').trim();
          if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('"time" must be HH:MM, 24-hour');
          const days = text(args, 'days').trim().toLowerCase();
          parseDays(days);
          // Counted as already done for any time before now, so it starts at the next due time, not at once.
          const { lastInsertRowid } = this.#db.prepare('INSERT INTO scheduled (task, time, days, last) VALUES (?, ?, ?, ?)').run(text(args, 'task').trim(), time.padStart(5, '0'), days, this.#now().getTime());
          const schedule = this.#db.prepare('SELECT * FROM scheduled WHERE id = ?').get(lastInsertRowid) as Scheduled;
          return `Scheduled: ${describe(schedule)}.`;
        },
      },
      {
        name: 'scheduled_tasks',
        description: 'List the tasks set to repeat on a schedule, with their numbers.',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          const all = this.#db.prepare('SELECT * FROM scheduled ORDER BY id').all() as Scheduled[];
          return all.length ? all.map(describe).join('\n') : 'No tasks are scheduled.';
        },
      },
      {
        name: 'cancel_scheduled_task',
        description: 'Stop a scheduled task from repeating, by its number. The user is asked first.',
        parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        approval: (args) => {
          const found = this.#db.prepare('SELECT * FROM scheduled WHERE id = ?').get(args.id as number) as Scheduled | undefined;
          return found ? `remove the scheduled task: ${found.task.slice(0, 120)}` : undefined;
        },
        run: async (args) => {
          const id = integer(args, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
          if (this.#db.prepare('DELETE FROM scheduled WHERE id = ?').run(id).changes === 0) throw new Error(`There is no scheduled task ${id}.`);
          return `Scheduled task ${id} will not run again.`;
        },
      },
      {
        name: 'task_results',
        description: 'What background and scheduled jobs did recently: each task, when it ran and what it reported. Use it when he asks how a job went.',
        parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many, newest first (default 5)' } } },
        run: async (args) => {
          const jobs = this.#db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(integer(args, 'limit', { min: 1, max: 30, fallback: 5 })) as Job[];
          if (!jobs.length) return 'No jobs have run yet.';
          return jobs.map((job) => `Job ${job.id}, started ${when.format(job.created)}: ${job.task}\n${job.finished ? `Result: ${job.result}` : 'Still running or waiting its turn.'}`).join('\n\n');
        },
      },
    ];
  }

  close(): void {
    this.#db.close();
  }
}
