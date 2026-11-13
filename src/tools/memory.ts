import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { text, type Tool } from './types.ts';

export type Line = { id: number; at: number; who: string; text: string };

const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
/** Words of three letters or more, for search. */
const words = (value: string) => [...new Set(value.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [])];
const fts = (terms: string[], join: 'OR' | 'AND') => terms.map((term) => `"${term.replaceAll('"', '')}"`).join(` ${join} `);

/** Turns text into a unit-length vector; texts with similar meaning get vectors pointing the same way. */
export type Embed = (text: string) => Promise<Float32Array>;
/** How alike in meaning a line must be to a question to count as a match (tested: 0.4 to 0.55 for real matches, under 0.2 for others). */
const MEANING = 0.25;
const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

/**
 * What Jarvis remembers between sessions, in one SQLite file on this Mac: facts about the user
 * (preferences, people, projects) and every line of every conversation, searchable by word and by meaning.
 * shortcut: meaning search compares every line in JavaScript (fine for years of talk); move to sqlite-vec past ~100k lines.
 */
export class Memory {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #embed: Embed | undefined;
  /** The conversation line being written, so the sentences of one reply become one line. */
  #open: { id: number; who: string; turn: number } | undefined;
  /** The lines of the turn being written, and a turn whose lines are not kept because it forgot something. */
  #turn: { id: number; rows: number[] } | undefined;
  #muted: number | undefined;
  /** Lines are turned into vectors one at a time, in the order they were written. */
  #indexing: Promise<void> = Promise.resolve();

  constructor(path: string, options: { now?: () => number; embed?: Embed } = {}) {
    this.#db = new DatabaseSync(path);
    this.#now = options.now ?? (() => Date.now());
    this.#embed = options.embed;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE, at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS lines USING fts5(who UNINDEXED, text, at UNINDEXED);
      CREATE TABLE IF NOT EXISTS vectors (id INTEGER PRIMARY KEY, vec BLOB NOT NULL);`);
  }

  /** Queues a line to be turned into a vector, or every line that has none yet. Resolves when done. */
  index(id?: number): Promise<void> {
    const embed = this.#embed;
    if (!embed) return Promise.resolve();
    this.#indexing = this.#indexing.then(async () => {
      const rows = (id === undefined
        ? this.#db.prepare('SELECT rowid AS id, text FROM lines WHERE rowid NOT IN (SELECT id FROM vectors)').all()
        : this.#db.prepare('SELECT rowid AS id, text FROM lines WHERE rowid = ?').all(id)) as { id: number; text: string }[];
      for (const row of rows) {
        const vec = await embed(row.text);
        // The line may have been forgotten while its vector was being made.
        if (this.#db.prepare('SELECT 1 FROM lines WHERE rowid = ?').get(row.id)) {
          this.#db.prepare('INSERT OR REPLACE INTO vectors (id, vec) VALUES (?, ?)').run(row.id, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
        }
      }
    }).catch((error: unknown) => console.error('[jarvis] memory indexing failed:', error instanceof Error ? error.message : error));
    return this.#indexing;
  }

  facts(): { id: number; text: string }[] {
    return this.#db.prepare('SELECT id, text FROM facts ORDER BY id').all() as { id: number; text: string }[];
  }

  /** Saves a fact; false if it was already known. */
  remember(fact: string): boolean {
    return this.#db.prepare('INSERT OR IGNORE INTO facts (text, at) VALUES (?, ?)').run(fact.trim(), this.#now()).changes > 0;
  }

  /** Records a line of conversation. Lines from the same speaker in the same turn are joined. */
  log(who: string, said: string, turn: number): void {
    if (turn === this.#muted) return;
    if (this.#turn?.id !== turn) this.#turn = { id: turn, rows: [] };
    if (this.#open?.who === who && this.#open.turn === turn) {
      this.#db.prepare("UPDATE lines SET text = text || ' ' || ? WHERE rowid = ?").run(said, this.#open.id);
    } else {
      const { lastInsertRowid } = this.#db.prepare('INSERT INTO lines (who, text, at) VALUES (?, ?, ?)').run(who, said, this.#now());
      this.#open = { id: Number(lastInsertRowid), who, turn };
      this.#turn.rows.push(this.#open.id);
    }
    void this.index(this.#open.id);
  }

  /** Past lines that best match the question by meaning or by word, each with the line before and after it, oldest first. */
  async recall(query: string, limit = 6): Promise<Line[][]> {
    const terms = words(query);
    const byWord = terms.length ? (this.#db.prepare('SELECT rowid AS id FROM lines WHERE lines MATCH ? ORDER BY bm25(lines) LIMIT ?').all(fts(terms, 'OR'), limit) as { id: number }[]) : [];
    let byMeaning: number[] = [];
    if (this.#embed && query.trim()) {
      await this.#indexing; // lines from moments ago must be searchable too
      const wanted = await this.#embed(query);
      const rows = this.#db.prepare('SELECT id, vec FROM vectors').all() as { id: number; vec: Uint8Array }[];
      byMeaning = rows
        .map((row) => ({ id: row.id, score: dot(wanted, new Float32Array(row.vec.slice().buffer)) }))
        .filter((row) => row.score >= MEANING)
        .sort((a, b) => b.score - a.score)
        .map((row) => row.id);
    }
    const ids = [...new Set([...byMeaning.slice(0, limit), ...byWord.map((hit) => hit.id)])].slice(0, limit);
    const around = this.#db.prepare('SELECT rowid AS id, at, who, text FROM lines WHERE rowid BETWEEN ? AND ? ORDER BY rowid');
    return ids.map((id) => around.all(id - 1, id + 1) as Line[]).sort((a, b) => a[0]!.id - b[0]!.id);
  }

  /** Every line said on one day (local time), oldest first. */
  day(date: Date, limit = 60): Line[] {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return this.#db.prepare('SELECT rowid AS id, at, who, text FROM lines WHERE at >= ? AND at < ? ORDER BY rowid LIMIT ?').all(start, start + 86_400_000, limit) as Line[];
  }

  /** The facts and the number of conversation lines that mention every word of the topic. */
  matching(topic: string): { facts: { id: number; text: string }[]; lines: number } {
    const terms = words(topic);
    if (terms.length === 0) return { facts: [], lines: 0 };
    const facts = this.facts().filter((fact) => terms.every((term) => fact.text.toLowerCase().includes(term)));
    const { count } = this.#db.prepare('SELECT count(*) AS count FROM lines WHERE lines MATCH ?').get(fts(terms, 'AND')) as { count: number };
    return { facts, lines: count };
  }

  /**
   * Deletes for good the facts and conversation lines that mention every word of the topic. The turn
   * that asked is dropped as well, request and reply, since it names the topic too.
   */
  forget(topic: string): { facts: number; lines: number } {
    const { facts } = this.matching(topic);
    const terms = words(topic);
    if (terms.length === 0) return { facts: 0, lines: 0 };
    const remove = this.#db.prepare('DELETE FROM facts WHERE id = ?');
    for (const fact of facts) remove.run(fact.id);
    const lines = this.#db.prepare('DELETE FROM lines WHERE lines MATCH ?').run(fts(terms, 'AND')).changes;
    const drop = this.#db.prepare('DELETE FROM lines WHERE rowid = ?');
    for (const row of this.#turn?.rows ?? []) drop.run(row);
    this.#db.exec('DELETE FROM vectors WHERE id NOT IN (SELECT rowid FROM lines)');
    this.#muted = this.#turn?.id;
    this.#open = undefined;
    return { facts: facts.length, lines: Number(lines) };
  }

  /**
   * Copies the whole file (memory, reminders, scheduled tasks) into `dir`, once a day, keeping the
   * latest `keep` copies. Returns the new copy's path, or undefined if today's already exists.
   * shortcut: the copies are on the same disk, so they guard against a damaged file or a wrong
   * "forget", not a lost Mac; Time Machine or another off-Mac backup covers that.
   */
  backup(dir: string, keep = 7): string | undefined {
    const now = new Date(this.#now());
    const two = (value: number) => String(value).padStart(2, '0');
    const file = join(dir, `memory-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.db`);
    if (existsSync(file)) return undefined;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`); // a consistent copy, even mid-write
    chmodSync(file, 0o600);
    const copies = readdirSync(dir).filter((name) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort();
    for (const old of copies.slice(0, -keep)) rmSync(join(dir, old));
    return file;
  }

  close(): void {
    this.#db.close();
  }
}

const describeLines = (lines: Line[]) => lines.map((line) => `${time.format(line.at)} ${line.who}: ${line.text}`).join('\n');
const dated = (lines: Line[]) => `${day.format(lines[0]!.at)}\n${describeLines(lines)}`;

/** The facts, for the model's instructions on every turn. */
export function factsPrompt(memory: Memory): string {
  const facts = memory.facts();
  return facts.length ? `What you remember about him from earlier sessions, written about him; when you mention it, speak to him as "you":\n${facts.map((fact) => `- ${fact.text}`).join('\n')}` : '';
}

/** `onForget` runs after something is forgotten, so the conversation held in the session can be dropped too. */
export function memoryTools(memory: Memory, options: { onForget?: () => void; now?: () => Date } = {}): Tool[] {
  const now = options.now ?? (() => new Date());
  return [
    {
      name: 'remember',
      description:
        'Save facts about the user for future sessions: preferences, people in his life, projects, habits, or anything he asks you to remember. Write each as one short sentence about him, e.g. ["Prefers tea to coffee", "Dana is his manager", "Dana wants status reports every Monday"], one item per fact so none is lost. Call this whenever he tells you something like that, without being asked.',
      parameters: { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } }, required: ['facts'] },
      run: async (args) => {
        const facts = Array.isArray(args.facts) ? args.facts : [args.fact];
        if (facts.length === 0 || facts.length > 20 || !facts.every((fact) => typeof fact === 'string' && fact.trim())) throw new Error('"facts" must be a list of 1 to 20 short sentences');
        const saved = facts.filter((fact) => memory.remember(fact as string)).length;
        return saved === facts.length ? 'Saved.' : saved ? `Saved ${saved}; the rest were already remembered.` : 'Already remembered.';
      },
    },
    {
      name: 'memories',
      description: 'List every fact you remember about the user. Use it when he asks what you know or remember about him.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const facts = memory.facts();
        return facts.length ? `Facts remembered, written about him (say them to him as "you"):\n${facts.map((fact) => `- ${fact.text}`).join('\n')}` : 'Nothing is remembered yet.';
      },
    },
    {
      name: 'recall',
      description:
        'Search past conversations with the user, from earlier sessions too, by meaning: "teeth" finds a talk about the dentist. Give what to look for (e.g. "dentist appointment"), or a date ("2026-11-11") to hear everything said that day, or both.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What was talked about' }, date: { type: 'string', description: 'A day, as YYYY-MM-DD' } },
      },
      run: async (args) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? new Date(`${args.date}T12:00:00`) : undefined;
        if (!query && !date) throw new Error('Give words to look for, or a date as YYYY-MM-DD');
        if (date) {
          const lines = memory.day(date).filter((line) => !query || words(query).some((term) => line.text.toLowerCase().includes(term)));
          return lines.length ? dated(lines) : `Nothing was said${query ? ` about "${query}"` : ''} on ${day.format(date)}.`;
        }
        const found = await memory.recall(query);
        return found.length ? `Past conversation about "${query}" (today is ${day.format(now())}):\n\n${found.map(dated).join('\n\n')}` : `No past conversation mentions "${query}".`;
      },
    },
    {
      name: 'forget',
      description:
        'Delete for good every remembered fact and every line of past conversation that mentions all the words of a topic. Call it straight away whenever he asks you to forget something: the Mac asks him to confirm, so never ask him yourself and never search first.',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Words naming what to forget, e.g. "Dana" or "job interview"' } }, required: ['topic'] },
      approval: (args) => {
        if (typeof args.topic !== 'string') return undefined;
        const { facts, lines } = memory.matching(args.topic);
        if (!facts.length && !lines) return undefined; // nothing to delete: run() says so
        const what = [facts.length && `${facts.length} saved fact${facts.length === 1 ? '' : 's'}`, lines && `${lines} line${lines === 1 ? '' : 's'} of past conversation`].filter(Boolean).join(' and ');
        return `forget everything about ${args.topic}: ${what}`;
      },
      run: async (args) => {
        const { facts, lines } = memory.forget(text(args, 'topic'));
        if (facts || lines) options.onForget?.();
        return facts || lines ? `Forgotten: ${facts} facts and ${lines} conversation lines.` : `Nothing remembered mentions "${String(args.topic)}".`;
      },
    },
  ];
}
