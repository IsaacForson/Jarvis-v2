import { createCalendar } from './calendar.ts';
import { fileTools } from './files.ts';
import { macTools } from './mac.ts';
import { mailTools } from './mail.ts';
import { screenTools } from './screen.ts';
import { terminalTools } from './terminal.ts';
import type { Tool } from './types.ts';

/** Everything Jarvis can do on this Mac, and a `refresh` that keeps slow sources (the calendar) read ahead. */
export function createTools(options: { describeImage: Parameters<typeof screenTools>[0] }): { tools: Tool[]; refresh(): Promise<unknown> } {
  const calendar = createCalendar();
  return {
    tools: [...macTools, ...fileTools(), ...terminalTools, ...screenTools(options.describeImage), calendar.tool, ...mailTools],
    refresh: calendar.refresh,
  };
}
