import { DatabaseSync } from 'node:sqlite';
import type { CalendarEvent } from './tools/calendar.ts';
import { integer, text, type Tool } from './tools/types.ts';

export type Mail = { id: number; from: string; subject: string; received: string };
type Reminder = { id: number; base: number; due: number; text: string; alarm: number; daily: number; level: number; fired: number };
/** Something to say unasked. Alarms and late-night nudges are said in quiet hours; the rest waits or is dropped. */
type Item = { key: string; text: string; note?: string; kind: 'alarm' | 'late' | 'report' | 'urgent' | 'event' | 'nudge'; spoken?: () => void };

export type InitiativeDeps = {
  dbPath: string;
  /** Speaks up unasked; false when Jarvis is busy, and the item is offered again on the next tick. */
  announce(text: string, note?: string): Promise<boolean>;
  /** Runs a whole turn from an instruction (the morning briefing); false when busy. */
  initiate(instruction: string): Promise<boolean>;
  unreadMail?(): Promise<Mail[]>;
  isUrgent?(mail: Mail): Promise<boolean>;
  /** Events from now on, today. */
  upcoming?(): Promise<CalendarEvent[]>;
  /** Seconds since the keyboard or mouse was last used. */
  idleSeconds?(): Promise<number>;
  now?: () => Date;
  /** "HH:MM"; default 08:00. */
  briefingAt?: string;
};

const MINUTE = 60_000;
const QUIET_FROM = 23; // hours, local time
const QUIET_TO = 7;
const MAIL_EVERY = 5 * MINUTE;
const MAIL_FRESH = 2 * 60 * MINUTE;
const EVENT_WARNING = 10 * MINUTE;
const AWAY = 5 * 60; // seconds idle that count as a break
const STRETCH = 90 * MINUTE;
/** Gaps between repeats of an unanswered reminder: firmer and sooner each time, then hourly. */
const CHASE = [30, 15, 10, 5].map((minutes) => minutes * MINUTE);
const ALARM_REPEATS = 15;
/** A briefing missed by more than this (the Mac was asleep, say) is skipped for the day. */
const BRIEFING_LATE = 4 * 60 * MINUTE;
const BRIEFING = (reminders: string) =>
  `Give him his morning briefing now: greet him, then today's calendar, his unread email (say which look important, and mention any that have waited more than a day for him), the weather, and his reminders for today. Use your tools for the calendar, the email and the weather. His reminders and alarms for today: ${reminders}. Keep it to a few spoken sentences.`;

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const isQuiet = (now: Date) => now.getHours() >= QUIET_FROM || now.getHours() < QUIET_TO;
const sender = (from: string) => from.replace(/\s*<.*>\s*$/, '').replace(/^"|"$/g, '') || from;
const localDay = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

/** What an unanswered reminder says, firmer each time. */
export function chase(reminder: Pick<Reminder, 'text' | 'level' | 'alarm'>, now: Date): string {
  if (reminder.alarm) return reminder.level === 0 ? `Sir, it is ${clock.format(now)}. ${reminder.text.charAt(0).toUpperCase()}${reminder.text.slice(1)}.` : `Sir, your alarm: ${reminder.text}. It is ${clock.format(now)}.`;
  return [
    `Sir, a reminder: ${reminder.text}.`,
    `Sir, just checking: ${reminder.text}. Is it done?`,
    `Sir, ${reminder.text} is still waiting.`,
  ][reminder.level] ?? `Sir, I must insist: ${reminder.text}. Say done, snooze it, or drop it.`;
}

/**
 * Jarvis's initiative: reminders and alarms, the morning briefing, watching email and the calendar,
 * and wellbeing nudges. `tick` runs every half minute; quiet hours (23:00 to 07:00) hold everything but alarms.
 * shortcut: deploys are not watched; there is no deploy source on this Mac yet.
 */
export class Initiative {
  readonly #deps: InitiativeDeps;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  #queue: Item[] = [];
  #ticking = false;
  #mailCheckedAt = 0;
  #warned = new Set<string>();
  #activeSince: number | undefined;
  #lastNudge = 0;

  constructor(deps: InitiativeDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#db = new DatabaseSync(deps.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, base INTEGER NOT NULL, due INTEGER NOT NULL, text TEXT NOT NULL, alarm INTEGER NOT NULL, daily INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 0, fired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }

  #get(key: string): string | undefined {
    return (this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  #set(key: string, value: string): void {
    this.#db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Queues something to say, once per key. */
  say(item: Item): void {
    if (!this.#queue.some((queued) => queued.key === item.key)) this.#queue.push(item);
  }

  /** The user spoke: a ringing alarm has been answered. */
  heard(): void {
    const now = this.#now().getTime();
    for (const alarm of this.#db.prepare('SELECT * FROM reminders WHERE alarm = 1 AND fired > 0').all() as Reminder[]) {
      this.#finish(alarm, now);
      this.#queue = this.#queue.filter((item) => !item.key.startsWith(`reminder ${alarm.id} `));
    }
  }

  #finish(reminder: Reminder, now: number): void {
    if (!reminder.daily) return void this.#db.prepare('DELETE FROM reminders WHERE id = ?').run(reminder.id);
    let next = reminder.base;
    while (next <= now) next += 24 * 60 * MINUTE;
    this.#db.prepare('UPDATE reminders SET base = ?, due = ?, level = 0, fired = 0 WHERE id = ?').run(next, next, reminder.id);
  }

  async tick(): Promise<void> {
    if (this.#ticking) return; // the last tick is still waiting on Mail or the calendar
    this.#ticking = true;
    try {
      const now = this.#now();
      this.#reminders(now);
      await Promise.all([this.#brief(now), this.#mail(now), this.#calendar(now), this.#wellbeing(now)].map((step) => step.catch((error: unknown) => console.error('[jarvis] initiative:', error instanceof Error ? error.message : error))));
      await this.#deliver();
    } finally {
      this.#ticking = false;
    }
  }

  #reminders(now: Date): void {
    const due = this.#db.prepare('SELECT * FROM reminders WHERE due <= ? ORDER BY due').all(now.getTime()) as Reminder[];
    for (const reminder of due) {
      if (isQuiet(now) && !reminder.alarm) {
        // Overnight only alarms speak; a reminder waits for the morning.
        const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() >= QUIET_FROM ? 1 : 0), QUIET_TO);
        this.#db.prepare('UPDATE reminders SET due = ? WHERE id = ?').run(morning.getTime(), reminder.id);
        continue;
      }
      this.say({
        key: `reminder ${reminder.id} ${reminder.level}`,
        kind: reminder.alarm ? 'alarm' : 'report',
        text: chase(reminder, now),
        note: `This was reminder ${reminder.id}; use its number with reminder_done or snooze_reminder.`,
        spoken: () => {
          const at = this.#now().getTime();
          if (reminder.alarm && reminder.level + 1 >= ALARM_REPEATS) return this.#finish(reminder, at);
          const gap = reminder.alarm ? MINUTE : (CHASE[reminder.level] ?? 60 * MINUTE);
          this.#db.prepare('UPDATE reminders SET due = ?, level = level + 1, fired = ? WHERE id = ?').run(at + gap, at, reminder.id);
        },
      });
    }
  }

  async #brief(now: Date): Promise<void> {
    const [hours, minutes] = (this.#deps.briefingAt ?? '08:00').split(':').map(Number);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (isQuiet(now) || now < at || now.getTime() - at.getTime() > BRIEFING_LATE || this.#get('briefed') === localDay(now)) return;
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const today = (this.#db.prepare('SELECT * FROM reminders WHERE due < ? ORDER BY due').all(end) as Reminder[]).map((one) => `${clock.format(one.due)} ${one.alarm ? 'alarm: ' : ''}${one.text}`);
    if (await this.#deps.initiate(BRIEFING(today.join('; ') || 'none'))) this.#set('briefed', localDay(now));
  }

  async #mail(now: Date): Promise<void> {
    const { unreadMail, isUrgent } = this.#deps;
    if (!unreadMail || !isUrgent || now.getTime() - this.#mailCheckedAt < MAIL_EVERY) return;
    this.#mailCheckedAt = now.getTime();
    const seen = new Set<number>(JSON.parse(this.#get('mailSeen') ?? '[]') as number[]);
    const fresh = (await unreadMail()).filter((mail) => !seen.has(mail.id));
    for (const mail of fresh) {
      seen.add(mail.id);
      // Only mail from the last two hours is news worth interrupting for; older mail is for the briefing.
      if (now.getTime() - new Date(mail.received).getTime() > MAIL_FRESH) continue;
      if (!isQuiet(now) && (await isUrgent(mail))) {
        this.say({ key: `mail ${mail.id}`, kind: 'urgent', text: `Sir, an urgent email from ${sender(mail.from)}: ${mail.subject}.`, note: `It is email id ${mail.id}; read_email can open it.` });
      }
    }
    this.#set('mailSeen', JSON.stringify([...seen].slice(-500)));
  }

  async #calendar(now: Date): Promise<void> {
    if (!this.#deps.upcoming || isQuiet(now)) return;
    for (const event of await this.#deps.upcoming()) {
      const key = `${event.title} ${event.start.getTime()}`;
      const ahead = event.start.getTime() - now.getTime();
      if (event.allDay || ahead < 0 || ahead > EVENT_WARNING || this.#warned.has(key)) continue;
      this.#warned.add(key);
      const minutes = Math.max(1, Math.round(ahead / MINUTE));
      this.say({ key, kind: 'event', text: `Sir, ${event.title} starts in ${minutes} minute${minutes === 1 ? '' : 's'}${event.place ? `, at ${event.place}` : ''}.` });
    }
  }

  async #wellbeing(now: Date): Promise<void> {
    if (!this.#deps.idleSeconds) return;
    const idle = await this.#deps.idleSeconds();
    const at = now.getTime();
    if (idle >= AWAY) return void (this.#activeSince = undefined);
    this.#activeSince ??= at;
    // Up past midnight and still at the Mac: said even in quiet hours, since he is clearly awake.
    if (now.getHours() < 4 && this.#get('lateNudge') !== localDay(now)) {
      this.#set('lateNudge', localDay(now));
      this.say({ key: `late ${localDay(now)}`, kind: 'late', text: `It is ${clock.format(now)}, sir. Past midnight. Time to call it a night, perhaps?` });
    }
    if (at - Math.max(this.#activeSince, this.#lastNudge) >= STRETCH) {
      this.#lastNudge = at;
      const hours = (at - this.#activeSince) / (60 * MINUTE);
      this.say({ key: `break ${at}`, kind: 'nudge', text: `You have been at it for ${hours < 2 ? 'an hour and a half' : `${Math.floor(hours)} hours`} without a break, sir. Stretch your legs, perhaps?` });
    }
  }

  async #deliver(): Promise<void> {
    const quiet = isQuiet(this.#now());
    // Overnight, urgent mail and calendar news is left for the briefing; reports and nudges wait for morning.
    if (quiet) this.#queue = this.#queue.filter((item) => item.kind !== 'urgent' && item.kind !== 'event');
    const order = ['alarm', 'urgent', 'event', 'report', 'late', 'nudge'];
    this.#queue.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    for (const item of [...this.#queue]) {
      if (quiet && item.kind !== 'alarm' && item.kind !== 'late') continue;
      if (!(await this.#deps.announce(item.text, item.note))) return; // busy: try again next tick
      this.#queue = this.#queue.filter((queued) => queued !== item);
      item.spoken?.();
    }
  }

  tools(): Tool[] {
    const list = () => this.#db.prepare('SELECT * FROM reminders ORDER BY due').all() as Reminder[];
    const find = (args: Record<string, unknown>) => {
      const id = integer(args, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
      const found = this.#db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
      if (!found) throw new Error(`There is no reminder ${id}. List them with reminders.`);
      return found;
    };
    return [
      {
        name: 'set_reminder',
        description:
          'Set a reminder or an alarm that Jarvis speaks at the given time. A reminder repeats, firmer each time, until he says it is done, drops it or snoozes it; an alarm repeats every minute until he answers. Also use it, after offering, when he says he will do something later.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to remind him of, e.g. "call Dana"' },
            at: { type: 'string', description: 'Local date and time, YYYY-MM-DDTHH:MM' },
            in_minutes: { type: 'integer', description: 'Instead of at: how many minutes from now' },
            alarm: { type: 'boolean', description: 'An alarm rather than a reminder' },
            daily: { type: 'boolean', description: 'Repeat every day at this time' },
          },
          required: ['text'],
        },
        run: async (args) => {
          const now = this.#now().getTime();
          const due = typeof args.in_minutes === 'number' ? now + integer(args, 'in_minutes', { min: 1, max: 60 * 24 * 365, fallback: 1 }) * MINUTE : new Date(text(args, 'at')).getTime();
          if (!Number.isFinite(due)) throw new Error('"at" must be a date and time, YYYY-MM-DDTHH:MM');
          if (due <= now) throw new Error('That time has already passed.');
          const { lastInsertRowid } = this.#db
            .prepare('INSERT INTO reminders (base, due, text, alarm, daily) VALUES (?, ?, ?, ?, ?)')
            .run(due, due, text(args, 'text').trim(), args.alarm === true ? 1 : 0, args.daily === true ? 1 : 0);
          return `${args.alarm === true ? 'Alarm' : 'Reminder'} ${lastInsertRowid} set for ${when.format(due)}${args.daily === true ? ', every day' : ''}.`;
        },
      },
      {
        name: 'reminders',
        description: 'List the reminders and alarms that are set, with their numbers.',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          const all = list();
          return all.length ? all.map((one) => `[${one.id}] ${when.format(one.due)}: ${one.alarm ? 'alarm, ' : ''}${one.text}${one.daily ? ' (every day)' : ''}${one.fired ? ' (already said, waiting on him)' : ''}`).join('\n') : 'No reminders or alarms are set.';
        },
      },
      {
        name: 'reminder_done',
        description: 'Mark a reminder or alarm as done, or drop it, by its number. A daily one moves on to tomorrow.',
        parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        run: async (args) => {
          const reminder = find(args);
          this.#finish(reminder, this.#now().getTime());
          this.#queue = this.#queue.filter((item) => !item.key.startsWith(`reminder ${reminder.id} `));
          return `Done: ${reminder.text}.`;
        },
      },
      {
        name: 'snooze_reminder',
        description: 'Put a reminder or alarm off for some minutes, by its number.',
        parameters: { type: 'object', properties: { id: { type: 'integer' }, minutes: { type: 'integer', description: 'Default 10' } }, required: ['id'] },
        run: async (args) => {
          const reminder = find(args);
          const due = this.#now().getTime() + integer(args, 'minutes', { min: 1, max: 60 * 24 * 7, fallback: 10 }) * MINUTE;
          this.#db.prepare('UPDATE reminders SET due = ?, fired = 0 WHERE id = ?').run(due, reminder.id);
          this.#queue = this.#queue.filter((item) => !item.key.startsWith(`reminder ${reminder.id} `));
          return `Snoozed until ${clock.format(due)}: ${reminder.text}.`;
        },
      },
    ];
  }

  close(): void {
    this.#db.close();
  }
}
