import { exec } from './tools/exec.ts';

const MINUTE = 60_000;
const two = (value: number) => String(value).padStart(2, '0');
/** The date format pmset reads: MM/dd/yy HH:mm:ss, local time. */
export const pmsetDate = (at: number) => {
  const date = new Date(at);
  return `${two(date.getMonth() + 1)}/${two(date.getDate())}/${two(date.getFullYear() % 100)} ${two(date.getHours())}:${two(date.getMinutes())}:00`;
};

/**
 * Asks macOS to wake the Mac from sleep shortly before each coming alarm, reminder, briefing or
 * scheduled task, so they happen even when the Mac was asleep. Scheduling a wake needs administrator
 * rights; `npm run allow-wake` grants exactly this one command (pmset schedule wake) once.
 * A Mac that is shut down, or asleep with its lid closed on battery, still cannot be reached.
 */
export function createWaker(schedule: (date: string) => Promise<unknown> = (date) => exec('sudo', ['-n', '/usr/bin/pmset', 'schedule', 'wake', date])) {
  const done = new Set<number>();
  let allowed: boolean | undefined;
  return async (times: number[], now = Date.now()): Promise<void> => {
    if (allowed === false) return;
    for (const time of times) {
      // Two minutes early, so Jarvis is listening again by the time it is due.
      const at = Math.floor((time - 2 * MINUTE) / MINUTE) * MINUTE;
      if (at <= now + MINUTE || at > now + 24 * 60 * MINUTE || done.has(at)) continue;
      try {
        await schedule(pmsetDate(at));
        done.add(at);
        allowed = true;
      } catch {
        if (allowed === undefined) console.log('[jarvis] To let Jarvis wake the Mac from sleep for alarms and scheduled tasks, run once: npm run allow-wake');
        allowed ??= false;
        return;
      }
    }
  };
}
