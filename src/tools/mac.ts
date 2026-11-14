import { exec, osascript } from './exec.ts';
import { clip, integer, text, type Tool } from './types.ts';

export const macTools: Tool[] = [
  {
    name: 'open_app',
    description: 'Open (or bring to the front) an application on the Mac by its name, such as "Safari" or "Notes".',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'The application name' } }, required: ['name'] },
    run: async (args) => {
      await exec('open', ['-a', text(args, 'name')]);
      return 'Opened.';
    },
  },
  {
    name: 'open_url',
    description:
      "Show a web page to the user in his own everyday browser, for him to look at. You cannot read or control that page. To read a page or do something on it yourself, use web_open instead.",
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'A full http or https address' } }, required: ['url'] },
    run: async (args) => {
      const address = text(args, 'url').trim();
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`); // throws on a malformed address
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses can be opened');
      await exec('open', [url.href]);
      return 'Opened.';
    },
  },
  {
    name: 'set_volume',
    description: "Set the Mac's sound volume.",
    parameters: { type: 'object', properties: { percent: { type: 'integer', description: '0 (silent) to 100 (loudest)' } }, required: ['percent'] },
    run: async (args) => {
      const percent = integer(args, 'percent', { min: 0, max: 100, fallback: -1 });
      await osascript(`set volume output volume ${percent}`);
      return `Volume set to ${percent}%.`;
    },
  },
  {
    name: 'run_applescript',
    description:
      'Control Mac applications with AppleScript when no other tool fits, for example to pause music, create a note or a reminder. The user is asked to approve every script.',
    parameters: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What the script does, in a few plain words, as you would say it aloud' },
        script: { type: 'string', description: 'The AppleScript source' },
      },
      required: ['purpose', 'script'],
    },
    // A script can do anything an app can, so it is always confirmed. The script itself is written to the activity log.
    approval: (args) => `run a script on your Mac to ${text(args, 'purpose')}`,
    run: async (args) => clip((await osascript(text(args, 'script'))) || 'Done.'),
  },
];
