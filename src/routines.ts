import { DatabaseSync } from 'node:sqlite';
import { text, type Tool } from './tools/types.ts';

type Routine = { name: string; steps: string };
const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Routines he teaches by voice: a name ("work mode") and what to do when he says it, in his own words.
 * The steps are instructions for Jarvis, carried out with the ordinary tools, so a routine can do
 * anything Jarvis can, and the usual questions are still asked where an action needs his yes.
 */
export class Routines {
  readonly #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('CREATE TABLE IF NOT EXISTS routines (name TEXT PRIMARY KEY, steps TEXT NOT NULL)');
  }

  #all(): Routine[] {
    return this.#db.prepare('SELECT name, steps FROM routines ORDER BY name').all() as Routine[];
  }

  /** For the model's instructions every turn, so it knows a routine's name when it hears one. */
  prompt(): string {
    const names = this.#all().map((one) => `"${one.name}"`);
    return names.length ? `Routines he has taught you: ${names.join(', ')}. When he says one of these names, call run_routine with it and carry out the steps it returns.` : '';
  }

  tools(): Tool[] {
    return [
      {
        name: 'save_routine',
        description:
          'Teach or change a routine: a name he will say (e.g. "work mode") and the steps to carry out when he says it, written out in full as instructions to yourself (e.g. "Open Cursor and Slack, set the volume to 20, run the shortcut Focus on"). Use it when he says "when I say X, do Y".',
        parameters: { type: 'object', properties: { name: { type: 'string' }, steps: { type: 'string' } }, required: ['name', 'steps'] },
        run: async (args) => {
          this.#db.prepare('INSERT OR REPLACE INTO routines (name, steps) VALUES (?, ?)').run(key(text(args, 'name')), text(args, 'steps').trim());
          return `Saved the routine "${key(text(args, 'name'))}".`;
        },
      },
      {
        name: 'run_routine',
        description: 'Get the steps of a routine he taught, by its name, then carry them out at once with your tools, in order.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        run: async (args) => {
          const found = this.#db.prepare('SELECT name, steps FROM routines WHERE name = ?').get(key(text(args, 'name'))) as Routine | undefined;
          if (!found) throw new Error(`There is no routine called "${String(args.name)}". The routines are: ${this.#all().map((one) => one.name).join(', ') || 'none yet'}.`);
          return `Carry out these steps now, in order, then tell him briefly that it is done:\n${found.steps}`;
        },
      },
      {
        name: 'routines',
        description: 'List the routines he has taught, with their steps.',
        parameters: { type: 'object', properties: {} },
        run: async () => {
          const all = this.#all();
          return all.length ? all.map((one) => `"${one.name}": ${one.steps}`).join('\n') : 'He has taught no routines yet.';
        },
      },
      {
        name: 'delete_routine',
        description: 'Remove a routine, by its name. The user is asked first.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        approval: (args) => `delete the routine ${text(args, 'name')}`,
        run: async (args) => {
          if (this.#db.prepare('DELETE FROM routines WHERE name = ?').run(key(text(args, 'name'))).changes === 0) throw new Error(`There is no routine called "${String(args.name)}".`);
          return 'Removed.';
        },
      },
    ];
  }

  close(): void {
    this.#db.close();
  }
}
