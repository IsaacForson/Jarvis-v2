import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { exec } from './exec.ts';
import { clip, text, type Tool } from './types.ts';

// File contents are sent to the model in the cloud, so secrets must never be readable.
const SECRET = /(^|\/)(\.env(\..*)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.docker|Keychains|voiceprint\.json)(\/|$)|\.(pem|key|p12|pfx|keychain|keychain-db)$/i;

/**
 * Turns a path the model wrote into a real path Jarvis may touch: inside the home folder (links
 * followed, so a shortcut cannot lead out) and not a secret. Throws otherwise.
 */
export async function safePath(input: string, home: string = homedir()): Promise<string> {
  const root = await realpath(home);
  const wanted = resolve(root, input.replace(/^~(?=\/|$)/, root));
  // Resolve links in the part of the path that exists; a file about to be created has none yet.
  let existing = wanted;
  let tail = '';
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      if (existing === dirname(existing)) break;
      tail = join(basename(existing), tail);
      existing = dirname(existing);
    }
  }
  const real = tail ? join(existing, tail) : existing;
  if (real !== root && !real.startsWith(root + sep)) throw new Error('That is outside your home folder, which I may not touch');
  if (SECRET.test(real)) throw new Error('That file holds secrets (keys or passwords), so I may not open it');
  return real;
}

const friendly = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export function fileTools(home: string = homedir()): Tool[] {
  return [
    {
      name: 'find_files',
      description: 'Find files and folders on the Mac by name, using Spotlight. Returns up to 20 paths.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'All or part of the file name' } }, required: ['name'] },
      run: async (args) => {
        const found = (await exec('mdfind', ['-onlyin', home, '-name', text(args, 'name')])).split('\n').filter((path) => path && !SECRET.test(path));
        return found.length ? found.slice(0, 20).map((path) => friendly(path, home)).join('\n') : 'Nothing found.';
      },
    },
    {
      name: 'list_folder',
      description: 'List what is inside a folder. Paths may start with ~ for the home folder, e.g. "~/Desktop".',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async (args) => {
        const entries = await readdir(await safePath(text(args, 'path'), home), { withFileTypes: true });
        const names = entries.filter((entry) => !entry.name.startsWith('.')).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
        return names.length ? clip(names.sort().join('\n'), 3000) : 'The folder is empty.';
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file (notes, code, CSV, markdown). Not for images, PDFs or other binary files.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        if ((await stat(path)).size > 1_000_000) throw new Error('That file is larger than 1 MB, too big to read aloud or summarise');
        const content = await readFile(path, 'utf8');
        if (content.includes('\0')) throw new Error('That is not a text file');
        return clip(content);
      },
    },
    {
      name: 'write_file',
      description: 'Create a text file, or replace an existing one, with the given content. The user is asked to approve.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      approval: (args) => `save the file ${text(args, 'path')}`,
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        if (typeof args.content !== 'string') throw new Error('"content" must be text');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, args.content);
        return `Saved ${friendly(path, home)}.`;
      },
    },
    {
      name: 'move_to_trash',
      description: 'Move a file or folder to the Trash (it can be put back from there). The user is asked to approve.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      approval: (args) => `move ${text(args, 'path')} to the Trash`,
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        if (path === (await realpath(home))) throw new Error('I will not trash the home folder');
        await exec('/usr/bin/trash', [path]);
        return `Moved ${friendly(path, home)} to the Trash.`;
      },
    },
  ];
}
