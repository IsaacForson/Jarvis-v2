import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SECRET } from './files.ts';
import type { Embed } from './memory.ts';
import { text, type Tool } from './types.ts';

export type LibraryDeps = {
  dbPath: string;
  /** Folders whose documents are searchable. */
  roots: string[];
  embed: Embed;
  /** The whole text of one document. */
  readText(path: string): Promise<string>;
  now?: () => number;
};

const DOCUMENTS = new Set(['.pdf', '.docx', '.doc', '.rtf', '.odt', '.txt', '.md', '.csv']);
// Code and its dependencies are not his documents.
const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', 'target', 'Pods', 'venv', '__pycache__']);
const MAX_BYTES = 10_000_000;
const MAX_DOCUMENTS = 5000;
const MAX_PASSAGES = 60;
const PASSAGE = 700;
const LOOK_EVERY = 10 * 60_000;
/** How alike in meaning a passage must be to the question (the same measure memory uses). */
const MEANING = 0.25;
const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

/** Cuts a document into passages of a few sentences, breaking at paragraphs where it can. */
export function passages(content: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const paragraph of content.split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    for (let start = 0; start < paragraph.length; start += PASSAGE) {
      const piece = paragraph.slice(start, start + PASSAGE);
      if (current && current.length + piece.length > PASSAGE) {
        out.push(current);
        current = '';
      }
      current += (current ? ' ' : '') + piece;
    }
  }
  if (current) out.push(current);
  return out.slice(0, MAX_PASSAGES);
}

/**
 * His documents, searchable by meaning: each is cut into passages and every passage turned into a
 * vector, on this Mac; nothing is sent anywhere until a search result is read out. `sync` does a little
 * of the indexing each time it is called, so a large folder is taken in over a while, in the background.
 * shortcut: every search compares the question with every passage in JavaScript (fine for thousands of
 * documents); move to sqlite-vec if searches become slow.
 */
export class Library {
  readonly #deps: LibraryDeps;
  readonly #db: DatabaseSync;
  #waiting: { path: string; mtime: number }[] = [];
  #lookedAt = Number.NEGATIVE_INFINITY;

  constructor(deps: LibraryDeps) {
    this.#deps = deps;
    this.#db = new DatabaseSync(deps.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, mtime INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passages (id INTEGER PRIMARY KEY, path TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS passages_path ON passages (path);`);
  }

  async #walk(dir: string, found: { path: string; mtime: number }[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (found.length >= MAX_DOCUMENTS) return;
      const path = join(dir, entry.name);
      if (entry.name.startsWith('.') || SECRET.test(path)) continue;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) await this.#walk(path, found);
      } else if (entry.isFile() && DOCUMENTS.has(extname(entry.name).toLowerCase())) {
        const info = await stat(path).catch(() => undefined);
        if (info && info.size <= MAX_BYTES) found.push({ path, mtime: Math.round(info.mtimeMs) });
      }
    }
  }

  /** Takes in up to `limit` new or changed documents and forgets deleted ones. Returns how many are still waiting. */
  async sync(limit = 25): Promise<number> {
    const now = (this.#deps.now ?? Date.now)();
    if (this.#waiting.length === 0 && now - this.#lookedAt >= LOOK_EVERY) {
      this.#lookedAt = now;
      const found: { path: string; mtime: number }[] = [];
      for (const root of this.#deps.roots) await this.#walk(root, found);
      const known = new Map((this.#db.prepare('SELECT path, mtime FROM documents').all() as { path: string; mtime: number }[]).map((row) => [row.path, row.mtime]));
      const present = new Set(found.map((one) => one.path));
      for (const path of known.keys()) if (!present.has(path)) this.#forget(path);
      this.#waiting = found.filter((one) => known.get(one.path) !== one.mtime);
    }
    for (const document of this.#waiting.splice(0, limit)) {
      this.#forget(document.path);
      // A document that cannot be read is recorded too, so it is not tried again until it changes.
      const parts = passages(await this.#deps.readText(document.path).catch(() => ''));
      const insert = this.#db.prepare('INSERT INTO passages (path, text, vec) VALUES (?, ?, ?)');
      for (const part of parts) {
        const vec = await this.#deps.embed(`${basename(document.path)}: ${part}`);
        insert.run(document.path, part, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      }
      this.#db.prepare('INSERT OR REPLACE INTO documents (path, mtime) VALUES (?, ?)').run(document.path, document.mtime);
    }
    return this.#waiting.length;
  }

  #forget(path: string): void {
    this.#db.prepare('DELETE FROM passages WHERE path = ?').run(path);
    this.#db.prepare('DELETE FROM documents WHERE path = ?').run(path);
  }

  /** The passages closest in meaning to the question, best first, at most two from one document. */
  async search(query: string, limit = 5): Promise<{ path: string; text: string }[]> {
    const wanted = await this.#deps.embed(query);
    const rows = this.#db.prepare('SELECT path, text, vec FROM passages').all() as { path: string; text: string; vec: Uint8Array }[];
    const perDocument = new Map<string, number>();
    return rows
      .map((row) => ({ path: row.path, text: row.text, score: dot(wanted, new Float32Array(row.vec.slice().buffer)) }))
      .filter((row) => row.score >= MEANING)
      .sort((a, b) => b.score - a.score)
      .filter((row) => (perDocument.set(row.path, (perDocument.get(row.path) ?? 0) + 1), perDocument.get(row.path)! <= 2))
      .slice(0, limit);
  }

  tool(): Tool {
    return {
      name: 'search_documents',
      description:
        'Search inside his documents (PDFs, Word files, notes and text in Documents and on the Desktop) by meaning, not file name: "the contract where we agreed 650", "which document mentions the Kumasi supplier". Returns the closest passages with their files; open one with read_file for the rest. Use find_files when he knows the file name.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'What the document says or is about' } }, required: ['query'] },
      slow: true,
      run: async (args) => {
        const found = await this.search(text(args, 'query'));
        const { count } = this.#db.prepare('SELECT count(*) AS count FROM documents').get() as { count: number };
        const waiting = this.#waiting.length ? ` ${this.#waiting.length} documents are still being read in, so the search is not complete yet.` : '';
        if (!found.length) return `Nothing in his ${count} indexed documents matches that.${waiting}`;
        const home = homedir();
        return `${found.map((one) => `${one.path.startsWith(home) ? `~${one.path.slice(home.length)}` : one.path}\n"${one.text}"`).join('\n\n')}${waiting ? `\n\n${waiting.trim()}` : ''}`;
      },
    };
  }

  close(): void {
    this.#db.close();
  }
}
