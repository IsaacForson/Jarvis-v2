import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
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

/** Word and other rich documents, which macOS's textutil reads and writes. */
const RICH = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm', '.webarchive', '.wordml']);
const isRich = (path: string) => RICH.has(extname(path).toLowerCase());
const format = (path: string) => extname(path).slice(1).toLowerCase().replace(/^htm$/, 'html');

/** Writes a rich document from HTML (or plain text), in the format its name asks for. */
async function writeRich(path: string, content: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-doc-'));
  try {
    const html = /^\s*</.test(content) ? content : `<html><body>${content.split(/\n{2,}/).map((part) => `<p>${part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`;
    const source = join(dir, 'source.html');
    await writeFile(source, html);
    await exec('textutil', ['-convert', format(path), '-format', 'html', source, '-output', path]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Puts a copy of a file about to be overwritten in the Trash, so the edit can be undone. */
async function keepOldVersion(path: string, trash: (path: string) => Promise<unknown>): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false; // a new file: nothing to keep
  }
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-old-'));
  const stamp = new Date().toTimeString().slice(0, 5).replace(':', '.');
  const copy = join(dir, `${basename(path, extname(path))} (before Jarvis edit ${stamp})${extname(path)}`);
  await copyFile(path, copy);
  await trash(copy);
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** `pdfText` turns a PDF into its text (the native helper does it). */
export function fileTools(
  home: string = homedir(),
  pdfText?: (path: string) => Promise<string>,
  trash: (path: string) => Promise<unknown> = (path) => exec('/usr/bin/trash', [path]),
): Tool[] {
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
      description:
        'Read a document or text file: Word (.docx, .doc), RTF, OpenDocument, web pages, PDF, and plain text such as notes, code, CSV or markdown. Set html to get a Word or RTF document with its formatting, for editing.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, html: { type: 'boolean', description: 'Word or RTF documents only: read as HTML, keeping bold, headings and lists' } }, required: ['path'] },
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        if (extname(path).toLowerCase() === '.pdf') {
          if (!pdfText) throw new Error('PDFs cannot be read here');
          return clip((await pdfText(path)).replace(/\n{3,}/g, '\n\n').trim() || 'The PDF has no text; it may be scanned images. Look at it with read_screen instead.', 12_000);
        }
        if (isRich(path)) return clip(await exec('textutil', ['-convert', args.html === true ? 'html' : 'txt', '-stdout', path]), 12_000);
        if ((await stat(path)).size > 1_000_000) throw new Error('That file is larger than 1 MB, too big to read aloud or summarise');
        const content = await readFile(path, 'utf8');
        if (content.includes('\0')) throw new Error('That is not a text file');
        return clip(content);
      },
    },
    {
      name: 'write_file',
      description:
        'Create a file, or replace an existing one, with the given content. For a Word (.docx), RTF or OpenDocument file, give the content as HTML (headings, paragraphs, bold, lists) or plain text. Replacing a file puts its old version in the Trash first. The user is asked to approve.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      approval: (args) => `save the file ${text(args, 'path')}`,
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        if (typeof args.content !== 'string') throw new Error('"content" must be text');
        if (extname(path).toLowerCase() === '.pdf') throw new Error('I cannot write PDFs; save it as a Word document instead');
        await mkdir(dirname(path), { recursive: true });
        const kept = await keepOldVersion(path, trash);
        if (isRich(path)) await writeRich(path, args.content);
        else await writeFile(path, args.content);
        return `Saved ${friendly(path, home)}.${kept ? ' The old version is in the Trash.' : ''}`;
      },
    },
    {
      name: 'edit_file',
      description:
        'Change part of a document or text file in place: replace exact words with new ones, keeping everything else (and a Word document\'s formatting). Read the file first and copy the words exactly. The old version is put in the Trash first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'The exact words to replace, as they appear in the file' },
          replace: { type: 'string', description: 'What to put in their place (empty to remove them)' },
          all: { type: 'boolean', description: 'Replace every occurrence, not just one' },
        },
        required: ['path', 'find', 'replace'],
      },
      approval: (args) => `edit the file ${text(args, 'path')}`,
      run: async (args) => {
        const path = await safePath(text(args, 'path'), home);
        const find = text(args, 'find');
        if (typeof args.replace !== 'string') throw new Error('"replace" must be text');
        const rich = isRich(path);
        if (!rich && extname(path).toLowerCase() === '.pdf') throw new Error('I cannot edit PDFs');
        const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const before = rich ? await exec('textutil', ['-convert', 'html', '-stdout', path]) : await readFile(path, 'utf8');
        // In a rich document the words are looked for as written, then as HTML would write them ("&" as "&amp;").
        const wanted = rich && !before.includes(find) ? escape(find) : find;
        const count = before.split(wanted).length - 1;
        if (count === 0) throw new Error(rich ? 'Those exact words are not in the document; they may be split by formatting. Read it with html set and copy the words exactly, or rewrite it with write_file.' : 'Those exact words are not in the file. Read it and copy them exactly.');
        if (count > 1 && args.all !== true) throw new Error(`Those words appear ${count} times. Give more of the surrounding words, or set all to replace every one.`);
        const replacement = rich && wanted !== find ? escape(args.replace) : args.replace;
        const after = args.all === true ? before.split(wanted).join(replacement) : before.replace(wanted, () => replacement);
        await keepOldVersion(path, trash);
        if (rich) await writeRich(path, after);
        else await writeFile(path, after);
        return `Changed ${count > 1 && args.all === true ? `${count} places` : 'it'} in ${friendly(path, home)}. The old version is in the Trash.`;
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
        await trash(path);
        return `Moved ${friendly(path, home)} to the Trash.`;
      },
    },
  ];
}
