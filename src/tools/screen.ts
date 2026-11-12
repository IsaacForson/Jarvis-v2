import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec.ts';
import { PAYMENT } from './rules.ts';
import { text, type Tool } from './types.ts';

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
};

/**
 * Seeing the screen, and clicking what is seen. Only the main display is captured.
 * shortcut: a second monitor is invisible to these tools; capture the display holding the front window when that matters.
 */
export function screenTools(options: ScreenOptions): Tool[] {
  const capture = options.capture ?? captureScreen;
  let spot: Spot | undefined;

  return [
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
        const found = await options.locate(await capture(), text(args, 'target'));
        if (!found || !(found.x >= 0 && found.x <= 1000 && found.y >= 0 && found.y <= 1000)) throw new Error('I could not find that on the screen. Describe it differently, or check it is visible.');
        const screen = JSON.parse(await options.helper(['screen'])) as { width: number; height: number };
        const x = Math.round((found.x / 1000) * screen.width);
        const y = Math.round((found.y / 1000) * screen.height);
        // Sight is fallible (tested: one toolbar button in four was misplaced), so ask the Mac what is really there.
        const under = JSON.parse(await options.helper(['at', String(x), String(y)])) as { app: string; role: string; label: string };
        spot = { x, y, ...under };
        return `Found a spot for that. What is actually there is ${naming(spot)}. If that is the right thing, call screen_click; if it is not, call screen_find again with a more precise description.`;
      },
    },
    {
      name: 'screen_click',
      description: 'Click the spot that screen_find just found. The user is always asked first, and told what is at the spot.',
      parameters: { type: 'object', properties: {} },
      // Always confirmed: the spot was chosen by sight, which is sometimes wrong.
      approval: () => (spot && !PAYMENT.test(spot.label) ? `click ${naming(spot)}, which I found by sight` : undefined),
      run: async () => {
        if (!spot) throw new Error('Nothing has been found to click. Call screen_find first.');
        const target = spot;
        spot = undefined; // one find, one click: the screen may change
        if (PAYMENT.test(target.label)) throw new Error('That would spend money, which I never do. He must click it himself.');
        await options.helper(['click', String(target.x), String(target.y)]);
        return `Clicked ${naming(target)}. Look at the screen or read the window again to see what happened.`;
      },
    },
  ];
}
