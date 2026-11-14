import { spawn } from 'node:child_process';
import { exec, osascript } from './exec.ts';
import { clip, text, type Tool } from './types.ts';

// What is playing, asked of the two music apps without starting either.
const NOW_PLAYING = `
  const playing = [];
  for (const name of ['Music', 'Spotify']) {
    try {
      const app = Application(name);
      if (app.running() && app.playerState() === 'playing') playing.push(app.currentTrack.name() + ' by ' + app.currentTrack.artist() + ', in ' + name);
    } catch (error) {} // not installed
  }
  playing.join('; ');`;

export type EverydayDeps = {
  /** Runs the native helper (dist/ax): the media keys and Command-C. */
  helper(args: string[]): Promise<string>;
  run?: typeof exec;
  /** Reads and sets the clipboard's text. */
  paste?: () => Promise<string>;
  copy?: (value: string) => Promise<void>;
};

const pbcopy = (value: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('The clipboard could not be set'))));
    child.stdin.end(value);
  });

/** Small everyday actions: the music keys, Apple Shortcuts, and the clipboard and selection. */
export function everydayTools(deps: EverydayDeps): Tool[] {
  const run = deps.run ?? exec;
  const paste = deps.paste ?? (() => exec('pbpaste', []));
  const copy = deps.copy ?? pbcopy;
  return [
    {
      name: 'music',
      description:
        'Control whatever is playing on the Mac (Music, Spotify, a video in a browser), like the keyboard\'s media keys: play or pause, next track, previous track; or say what is playing now. To find and start a particular song, artist or video, use the browser or the app instead.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'now_playing'] } }, required: ['action'] },
      run: async (args) => {
        if (args.action === 'now_playing') return (await osascript(NOW_PLAYING, { javascript: true })) || 'Nothing is playing in Music or Spotify that I can see.';
        const key = { play_pause: 'play', next: 'next', previous: 'previous' }[String(args.action)];
        if (!key) throw new Error('"action" must be play_pause, next, previous or now_playing');
        await deps.helper(['media', key]);
        return `Pressed ${key === 'play' ? 'play/pause' : key}.`;
      },
    },
    {
      name: 'list_shortcuts',
      description: 'List the shortcuts he has made in the Shortcuts app, which run_shortcut can run: lights and other smart-home scenes, Focus modes, timers, anything he has built.',
      parameters: { type: 'object', properties: {} },
      run: async () => clip((await run('shortcuts', ['list'])) || 'He has no shortcuts yet.', 3000),
    },
    {
      name: 'run_shortcut',
      description: 'Run one of his shortcuts from the Shortcuts app, by its exact name (list_shortcuts gives the names).',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      // A shortcut can do anything he built it to do, so it is named and confirmed.
      approval: (args) => `run your shortcut ${text(args, 'name')}`,
      slow: true,
      run: async (args) => clip((await run('shortcuts', ['run', text(args, 'name')], { timeoutMs: 60_000 })) || 'Done.', 3000),
    },
    {
      name: 'read_clipboard',
      description: 'Read the text he last copied. Use it when he says "what I copied" or "my clipboard".',
      parameters: { type: 'object', properties: {} },
      run: async () => clip((await paste()) || 'The clipboard holds no text.', 3000),
    },
    {
      name: 'read_selection',
      description:
        'Read the text he has selected in the app in front. Use it when he says "this", "the selected text" or "what I have highlighted" and means something on screen: "explain this", "translate this", "summarise this", "fix the grammar in this".',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        // Copies the selection the way he would, then puts his clipboard back.
        // shortcut: a copied picture or file is not put back, only text; save and restore every clipboard type if that bites.
        const before = await paste();
        await copy('');
        try {
          await deps.helper(['key', 'cmd+c']);
          await new Promise((resolve) => setTimeout(resolve, 200));
          return clip((await paste()) || 'Nothing is selected, or the app in front does not let its text be copied.', 3000);
        } finally {
          await copy(before);
        }
      },
    },
    {
      name: 'write_clipboard',
      description: 'Put text on his clipboard, ready to paste: a translation, a rewrite, a reply you drafted.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async (args) => {
        await copy(text(args, 'text'));
        return 'It is on the clipboard.';
      },
    },
  ];
}
