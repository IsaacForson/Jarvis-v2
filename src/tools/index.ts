import { appTools } from './apps.ts';
import { createCalendar } from './calendar.ts';
import { exec } from './exec.ts';
import { fileTools } from './files.ts';
import { installTools } from './install.ts';
import { macTools } from './mac.ts';
import { mailBody, mailTools, unreadMail } from './mail.ts';
import { type ScreenOptions, screenTools } from './screen.ts';
import { terminalTools } from './terminal.ts';
import type { Tool } from './types.ts';
import { weatherTool } from './weather.ts';
import { webTools } from './web.ts';

/** Everything Jarvis can do on this Mac, and a `refresh` that keeps slow sources (the calendar) read ahead. */
export function createTools(options: {
  describeImage: ScreenOptions['describe'];
  locateOnScreen: ScreenOptions['locate'];
  browserProfileDir: string;
  /** Path of the compiled accessibility helper (dist/ax). */
  accessibilityHelper: string;
}): {
  tools: Tool[];
  refresh(): Promise<unknown>;
  upcoming: ReturnType<typeof createCalendar>['upcoming'];
  unreadMail: typeof unreadMail;
  mailBody: typeof mailBody;
  /** Closes what the tools opened (the browser window). */
  close(): Promise<void>;
} {
  const calendar = createCalendar();
  const web = webTools({ profileDir: options.browserProfileDir });
  const helper = (args: string[]) => exec(options.accessibilityHelper, args, { timeoutMs: 20_000 });
  return {
    tools: [...macTools, ...installTools(), ...fileTools(undefined, (path) => exec(options.accessibilityHelper, ['pdftext', path], { timeoutMs: 60_000 })), ...terminalTools, ...screenTools({ describe: options.describeImage, locate: options.locateOnScreen, helper }), calendar.tool, ...mailTools, weatherTool, ...web.tools, ...appTools(helper)],
    refresh: calendar.refresh,
    upcoming: calendar.upcoming,
    unreadMail,
    mailBody,
    close: web.close,
  };
}
