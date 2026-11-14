import { osascript } from './exec.ts';
import { expandRecurrence } from './rrule.ts';
import { integer, text, type Tool } from './types.ts';

type RawEvent = { calendar: string; title: string; start: string; end: string; allDay: boolean; rule: string | null; place: string | null };

// Runs inside the Calendar app. Each property is fetched for a whole calendar in one request and the
// filtering is done here: asking the app to filter ("whose") took about 45 ms per event, 13 s for one
// holiday calendar. Repeating events are kept whenever their series began before the window ends,
// because the app reports only a series' first occurrence; the repeats are worked out afterwards.
const SCRIPT = (days: number) => `
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime()); to.setDate(to.getDate() + ${days});
  const out = [];
  Application('Calendar').calendars().forEach((calendar) => {
    const events = calendar.events;
    const starts = events.startDate();
    if (starts.length === 0) return;
    const rules = events.recurrence();
    const wanted = starts.map((start, i) => start < to && (rules[i] || start >= from));
    if (!wanted.includes(true)) return;
    const name = calendar.name(), titles = events.summary(), ends = events.endDate(), allDay = events.alldayEvent(), places = events.location();
    wanted.forEach((keep, i) => keep && out.push({ calendar: name, title: titles[i], start: starts[i].toISOString(), end: ends[i].toISOString(), allDay: allDay[i], rule: rules[i] || null, place: places[i] || null }));
  });
  JSON.stringify(out);`;

// Adds one event. The values arrive as JSON, never pasted into the script as code.
const ADD = (event: { title: string; start: number; end: number; place: string; calendar: string }) => `
  const wanted = ${JSON.stringify(event)};
  const Calendar = Application('Calendar');
  const calendars = Calendar.calendars();
  const target = (wanted.calendar && calendars.find((one) => one.name().toLowerCase() === wanted.calendar.toLowerCase())) || calendars.find((one) => one.writable());
  if (!target) throw new Error('No calendar can be written to');
  const event = Calendar.Event({ summary: wanted.title, startDate: new Date(wanted.start), endDate: new Date(wanted.end), location: wanted.place });
  target.events.push(event);
  target.name();`;
const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export type CalendarEvent = { calendar: string; title: string; start: Date; end: Date; allDay: boolean; place?: string };

/** Turns the app's raw answer into the events that fall in [from, to), repeats included, in time order. */
export function eventsInWindow(raw: RawEvent[], from: Date, to: Date): CalendarEvent[] {
  const events = raw.flatMap((event) => {
    const start = new Date(event.start);
    const length = new Date(event.end).getTime() - start.getTime();
    const starts = event.rule ? expandRecurrence(start, event.rule, from, to) : start >= from && start < to ? [start] : [];
    return starts.map((when) => ({
      calendar: event.calendar,
      title: event.title,
      start: when,
      end: new Date(when.getTime() + length),
      allDay: event.allDay,
      ...(event.place ? { place: event.place } : {}),
    }));
  });
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export function describeEvents(events: CalendarEvent[]): string {
  if (events.length === 0) return 'No events in that period.';
  return events
    .map((event) => `${day.format(event.start)}, ${event.allDay ? 'all day' : `${time.format(event.start)} to ${time.format(event.end)}`}: ${event.title}${event.place ? ` (at ${event.place})` : ''} [${event.calendar} calendar]`)
    .join('\n');
}

const WINDOW_DAYS = 31;
const FRESH_MS = 10 * 60_000;
type Fetch = () => Promise<RawEvent[]>;
const fromCalendarApp: Fetch = async () => JSON.parse(await osascript(SCRIPT(WINDOW_DAYS), { javascript: true, timeoutMs: 180_000 })) as RawEvent[];

/**
 * The calendar tool, plus `refresh` to keep its copy of the calendar current. The Calendar app takes
 * 20 to 60 s to answer on this Mac, far too long for a spoken reply, so the next month is read in the
 * background and questions are answered from that copy while it is under ten minutes old.
 */
export function createCalendar(fetch: Fetch = fromCalendarApp, now: () => number = Date.now, add: (script: string) => Promise<string> = (script) => osascript(script, { javascript: true, timeoutMs: 60_000 })) {
  let copy: { at: number; raw: RawEvent[] } | undefined;
  let loading: Promise<RawEvent[]> | undefined;
  const refresh = (): Promise<RawEvent[]> =>
    (loading ??= fetch()
      .then((raw) => {
        copy = { at: now(), raw };
        return raw;
      })
      .finally(() => (loading = undefined)));

  const tool: Tool = {
    name: 'calendar_events',
    description: "Read the user's calendar from the Mac's Calendar app: events from today onwards. Use days=1 for today, 2 for today and tomorrow, 7 for the week.",
    parameters: { type: 'object', properties: { days: { type: 'integer', description: `How many days to cover, starting today (1 to ${WINDOW_DAYS})` } } },
    slow: true,
    run: async (args) => {
      const days = integer(args, 'days', { min: 1, max: WINDOW_DAYS, fallback: 1 });
      const start = new Date(now());
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
      const raw = copy && now() - copy.at < FRESH_MS ? copy.raw : await refresh();
      return describeEvents(eventsInWindow(raw, start, end));
    },
  };
  /** The rest of today's events, from the copy kept by `refresh` (read once if there is none yet). */
  const upcoming = async (): Promise<CalendarEvent[]> => {
    const start = new Date(now());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return eventsInWindow(copy?.raw ?? (await refresh()), start, end);
  };
  const addTool: Tool = {
    name: 'add_calendar_event',
    description: "Put an event in his calendar (the Mac's Calendar app, which syncs to his accounts): a meeting, an appointment, a block of time.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'Local date and time, YYYY-MM-DDTHH:MM' },
        minutes: { type: 'integer', description: 'How long it lasts (default 60)' },
        place: { type: 'string' },
        calendar: { type: 'string', description: 'Which calendar, by name; default his first writable one' },
      },
      required: ['title', 'start'],
    },
    approval: (args) => `add ${text(args, 'title')} to your calendar${typeof args.start === 'string' && Number.isFinite(new Date(args.start).getTime()) ? ` on ${when.format(new Date(args.start))}` : ''}`,
    slow: true,
    run: async (args) => {
      const start = new Date(text(args, 'start')).getTime();
      if (!Number.isFinite(start)) throw new Error('"start" must be a date and time, YYYY-MM-DDTHH:MM');
      const minutes = integer(args, 'minutes', { min: 5, max: 24 * 60, fallback: 60 });
      const name = await add(ADD({ title: text(args, 'title').trim(), start, end: start + minutes * 60_000, place: typeof args.place === 'string' ? args.place : '', calendar: typeof args.calendar === 'string' ? args.calendar : '' }));
      copy = undefined; // the kept copy no longer shows everything
      void refresh().catch(() => {});
      return `Added to the ${name} calendar: ${text(args, 'title').trim()}, ${when.format(start)}, for ${minutes} minutes.`;
    },
  };
  return { tool, addTool, refresh, upcoming };
}
