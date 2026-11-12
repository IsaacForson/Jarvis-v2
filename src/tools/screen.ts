import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec.ts';
import { PAYMENT } from './rules.ts';
import { integer, text, type Tool } from './types.ts';

/** Takes a picture of the main display and returns it as base64 JPEG. Nothing is left on disk. */
async function captureScreen(): Promise<string> {
  const file = join(tmpdir(), `jarvis-screen-${process.pid}-${Date.now()}.jpg`);
  try {
    await exec('screencapture', ['-x', '-t', 'jpg', file]).catch(() => {
      throw new Error('I am not allowed to see the screen. Screen Recording must be switched on for this app in System Settings, under Privacy and Security.');
    });
    // Halve the size first: a full Retina capture is slow to send and no easier to read.
    await exec('sips', ['-Z', '1600', file]);
    return (await readFile(file)).toString('base64');
  } finally {
    await rm(file, { force: true }); // a screenshot can show anything; never leave it on disk
  }
}

type Spot = { x: number; y: number; app: string; role: string; label: string };
const naming = (spot: Spot) => {
  const what = spot.role.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() || 'spot';
  return `the ${what}${spot.label ? ` "${spot.label}"` : ''}${spot.app ? ` in ${spot.app}` : ''}`;
};

export type ScreenOptions = {
  /** Sends a JPEG to a model that can see, with a question, and returns its answer. */
  describe(jpegBase64: string, question: string): Promise<string>;
  /** Asks a model that can see where something is: x and y from 0 to 1000 across the picture, or undefined if it cannot say. */
  locate(jpegBase64: string, target: string): Promise<{ x: number; y: number } | undefined>;
  /** Runs the native accessibility helper (dist/ax). */
  helper(args: string[]): Promise<string>;
  capture?: () => Promise<string>;
  /** Runs macOS's screencapture with these arguments (or starts it, for a recording, and returns a stop function). */
  screencapture?: (args: string[]) => Promise<unknown>;
  record?: (args: string[]) => { stop(): Promise<void> };
  /** Where screenshots and recordings are saved; default the Desktop, as macOS does. */
  saveDir?: string;
  now?: () => Date;
};

/** Starts `screencapture -v`, which records until it is interrupted, then finishes the file. */
const startRecording = (args: string[]) => {
  const child = spawn('screencapture', args, { stdio: 'ignore' });
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    stop: async () => {
      child.kill('SIGINT');
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    },
  };
};

/**
 * Seeing the screen, and clicking what is seen. Only the main display is captured.
 * shortcut: a second monitor is invisible to these tools; capture the display holding the front window when that matters.
 */
export function screenTools(options: ScreenOptions): Tool[] {
  const capture = options.capture ?? captureScreen;
  const screencapture = options.screencapture ?? ((args: string[]) => exec('screencapture', args));
  const record = options.record ?? startRecording;
  const saveDir = options.saveDir ?? join(homedir(), 'Desktop');
  const now = options.now ?? (() => new Date());
  // Named the way macOS names them, e.g. "Screenshot 2026-11-12 at 19.40.05.png".
  const named = (kind: string, extension: string) => {
    const at = now();
    const two = (value: number) => String(value).padStart(2, '0');
    return join(saveDir, `${kind} ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} at ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.${extension}`);
  };
  const friendly = (path: string) => path.replace(homedir(), '~');
  let recording: { path: string; stop(): Promise<void>; timer: ReturnType<typeof setTimeout> } | undefined;
  const stopRecording = async (): Promise<string> => {
    if (!recording) throw new Error('No screen recording is running.');
    const { path, stop, timer } = recording;
    recording = undefined;
    clearTimeout(timer);
    await stop();
    return path;
  };
  let spot: Spot | undefined;

  /** Finds a described thing by sight and asks the Mac what is really there. */
  const find = async (target: string): Promise<Spot> => {
    const found = await options.locate(await capture(), target);
    if (!found || !(found.x >= 0 && found.x <= 1000 && found.y >= 0 && found.y <= 1000)) throw new Error(`I could not find ${target} on the screen. Describe it differently, or check it is visible.`);
    const screen = JSON.parse(await options.helper(['screen'])) as { width: number; height: number };
    const x = Math.round((found.x / 1000) * screen.width);
    const y = Math.round((found.y / 1000) * screen.height);
    // Sight is fallible (tested: one toolbar button in four was misplaced), so ask the Mac what is really there.
    const under = JSON.parse(await options.helper(['at', String(x), String(y)])) as { app: string; role: string; label: string };
    return { x, y, ...under };
  };

  return [
    {
      name: 'take_screenshot',
      description: 'Take a screenshot, as the user would with Command-Shift-3: of the whole screen, or of just the front window, saved to the Desktop, or copied to the clipboard to paste somewhere.',
      parameters: {
        type: 'object',
        properties: { window: { type: 'boolean', description: 'Only the front window' }, clipboard: { type: 'boolean', description: 'Copy it to the clipboard instead of saving a file' } },
      },
      run: async (args) => {
        const area = args.window === true ? ['-o', '-l', String((JSON.parse(await options.helper(['frontwindow'])) as { id: number }).id)] : [];
        if (args.clipboard === true) {
          await screencapture(['-x', '-c', ...area]);
          return `Copied a screenshot of ${args.window === true ? 'the front window' : 'the screen'} to the clipboard.`;
        }
        const path = named('Screenshot', 'png');
        await screencapture(['-x', ...area, path]);
        return `Saved a screenshot of ${args.window === true ? 'the front window' : 'the screen'} as ${friendly(path)}.`;
      },
    },
    {
      name: 'start_screen_recording',
      description: 'Start recording the screen to a video on the Desktop, optionally with sound from the microphone. It runs until stop_screen_recording, or at most an hour.',
      parameters: { type: 'object', properties: { sound: { type: 'boolean', description: 'Record the microphone too' } } },
      run: async (args) => {
        if (recording) throw new Error(`A recording is already running, into ${friendly(recording.path)}.`);
        const path = named('Screen Recording', 'mov');
        const started = record(['-v', '-x', ...(args.sound === true ? ['-g'] : []), path]);
        recording = { path, stop: started.stop, timer: setTimeout(() => void stopRecording().catch(() => {}), 60 * 60_000) };
        return `Recording the screen${args.sound === true ? ' with sound' : ''} into ${friendly(path)}. Say when to stop.`;
      },
    },
    {
      name: 'stop_screen_recording',
      description: 'Stop the screen recording and save the video.',
      parameters: { type: 'object', properties: {} },
      run: async () => `Stopped. The recording is saved as ${friendly(await stopRecording())}.`,
    },
    {
      name: 'read_screen',
      description: "Look at what is on the user's screen right now and answer a question about it, e.g. what an error says or what a page shows.",
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'What to find out from the screen' } } },
      slow: true,
      run: async (args) => options.describe(await capture(), typeof args.question === 'string' && args.question.trim() ? args.question : 'Describe what is on this screen.'),
    },
    {
      name: 'screen_find',
      description:
        'Find something on the screen by sight, for apps whose windows app_read cannot read. Describe the target precisely (e.g. "the blue Play button in the Spotify window"). Reports what is actually at that spot; then screen_click clicks it.',
      parameters: { type: 'object', properties: { target: { type: 'string', description: 'What to find, described so it cannot be confused with anything else on screen' } }, required: ['target'] },
      slow: true,
      run: async (args) => {
        spot = undefined;
        spot = await find(text(args, 'target'));
        return `Found a spot for that. What is actually there is ${naming(spot)}. If that is the right thing, call screen_click; if it is not, call screen_find again with a more precise description.`;
      },
    },
    {
      name: 'screen_click',
      description: 'Click the spot that screen_find just found: a left click by default, or a right click or double click. The user is asked first, and told what is at the spot.',
      parameters: {
        type: 'object',
        properties: { button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean', description: 'Double-click, e.g. to open a file' } },
      },
      // Confirmed: the spot was chosen by sight, which is sometimes wrong.
      approval: () => (spot && !PAYMENT.test(spot.label) ? `click ${naming(spot)}, which I found by sight` : undefined),
      run: async (args) => {
        if (!spot) throw new Error('Nothing has been found to click. Call screen_find first.');
        const target = spot;
        spot = undefined; // one find, one click: the screen may change
        if (PAYMENT.test(target.label)) throw new Error('That would spend money, which I never do. He must click it himself.');
        const how = args.button === 'right' ? ['right'] : args.double === true ? ['double'] : [];
        await options.helper(['click', String(target.x), String(target.y), ...how]);
        return `Clicked ${naming(target)}. Look at the screen or read the window again to see what happened.`;
      },
    },
    {
      name: 'screen_type',
      description: 'Type text at the keyboard into whatever has focus now, e.g. a field just clicked with screen_click. Use app_type instead when the field is in an app_read list. Never use it for passwords or card numbers.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async (args) => {
        await options.helper(['type', text(args, 'text')]);
        return 'Typed it. Look at the screen to check it landed in the right place.';
      },
    },
    {
      name: 'screen_scroll',
      description: 'Scroll with the mouse wheel over something on the screen (or the middle of the screen if no target is given).',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', description: 'Lines to scroll, 1 to 50 (default 10)' },
          target: { type: 'string', description: 'What to scroll over, e.g. "the message list in Mail"' },
        },
        required: ['direction'],
      },
      run: async (args) => {
        const amount = integer(args, 'amount', { min: 1, max: 50, fallback: 10 });
        const sign = args.direction === 'up' || args.direction === 'left' ? -1 : 1;
        const vertical = args.direction === 'up' || args.direction === 'down';
        const at = typeof args.target === 'string' && args.target.trim()
          ? await find(args.target)
          : await options.helper(['screen']).then((raw) => {
              const screen = JSON.parse(raw) as { width: number; height: number };
              return { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
            });
        await options.helper(['scroll', String(at.x), String(at.y), String(vertical ? sign * amount : 0), String(vertical ? 0 : sign * amount)]);
        return `Scrolled ${String(args.direction)}. Look at the screen to see what is shown now.`;
      },
    },
    {
      name: 'screen_drag',
      description: 'Drag one thing on the screen onto another, found by sight, e.g. a file onto a folder or a slider handle to a new position. The user is asked first.',
      parameters: { type: 'object', properties: { from: { type: 'string', description: 'What to pick up' }, to: { type: 'string', description: 'Where to drop it' } }, required: ['from', 'to'] },
      approval: (args) => `drag ${String(args.from)} onto ${String(args.to)}`,
      run: async (args) => {
        const from = await find(text(args, 'from'));
        const to = await find(text(args, 'to'));
        await options.helper(['drag', String(from.x), String(from.y), String(to.x), String(to.y)]);
        return `Dragged ${naming(from)} onto ${naming(to)}. Look at the screen to check.`;
      },
    },
  ];
}
