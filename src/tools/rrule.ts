const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;
const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const daysBetween = (from: Date, to: Date) => Math.round((midnight(to).getTime() - midnight(from).getTime()) / DAY_MS);

/**
 * The start times, within [from, to), of a repeating event, given its first start and its iCalendar
 * rule such as "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE". Calendar's scripting interface hands back only the
 * first occurrence, so the repeats are worked out here.
 * shortcut: covers daily, weekly, monthly and yearly rules with INTERVAL, COUNT, UNTIL, BYDAY and
 * BYMONTHDAY; single occurrences that were moved or deleted are not known to it.
 */
export function expandRecurrence(start: Date, rule: string, from: Date, to: Date): Date[] {
  const part = Object.fromEntries(rule.split(';').map((pair) => pair.split('=') as [string, string]));
  const interval = Math.max(1, Number(part.INTERVAL) || 1);
  const count = Number(part.COUNT) || Infinity;
  const until = part.UNTIL
    ? new Date(`${part.UNTIL.slice(0, 4)}-${part.UNTIL.slice(4, 6)}-${part.UNTIL.slice(6, 8)}T23:59:59`)
    : undefined;
  const byDay = (part.BYDAY ?? '').split(',').filter(Boolean).map((token) => ({ ordinal: parseInt(token, 10) || 0, weekday: WEEKDAYS.indexOf(token.slice(-2)) }));
  const byMonthDay = (part.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number);
  // Weeks are counted from the Monday of the first occurrence's week.
  const firstMonday = new Date(midnight(start).getTime() - ((start.getDay() + 6) % 7) * DAY_MS);

  const matches = (day: Date): boolean => {
    const months = (day.getFullYear() - start.getFullYear()) * 12 + day.getMonth() - start.getMonth();
    switch (part.FREQ) {
      case 'DAILY':
        return daysBetween(start, day) % interval === 0;
      case 'WEEKLY':
        return Math.floor(daysBetween(firstMonday, day) / 7) % interval === 0 && (byDay.length ? byDay.some((by) => by.weekday === day.getDay()) : day.getDay() === start.getDay());
      case 'MONTHLY': {
        if (months % interval !== 0) return false;
        if (byDay.length) {
          const nth = Math.ceil(day.getDate() / 7); // this is the nth such weekday of its month
          const lastOfMonth = day.getDate() + 7 > new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
          return byDay.some((by) => by.weekday === day.getDay() && (by.ordinal === 0 || by.ordinal === nth || (by.ordinal === -1 && lastOfMonth)));
        }
        return byMonthDay.length ? byMonthDay.includes(day.getDate()) : day.getDate() === start.getDate();
      }
      case 'YEARLY':
        return (day.getFullYear() - start.getFullYear()) % interval === 0 && day.getMonth() === start.getMonth() && day.getDate() === start.getDate();
      default:
        return false;
    }
  };

  const found: Date[] = [];
  let seen = 0;
  // Walk day by day from the first occurrence; COUNT can only be honoured by counting from the start.
  // The cap (150 years of days) only stops a runaway loop; a birthday series can start decades back.
  for (let day = midnight(start), guard = 0; day < to && guard < 366 * 150; guard++, day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (until && day > until) break;
    if (!matches(day)) continue;
    if (++seen > count) break;
    const occurrence = new Date(day.getFullYear(), day.getMonth(), day.getDate(), start.getHours(), start.getMinutes());
    if (occurrence >= from && occurrence < to) found.push(occurrence);
  }
  return found;
}
