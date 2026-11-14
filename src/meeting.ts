import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type NotesDeps = {
  /** Where the notes are saved, one file a meeting. */
  dir: string;
  /** Turns the transcript into a spoken summary, a line of ---, then the written notes. */
  write(transcript: string): Promise<string>;
  now?: () => Date;
};

const two = (value: number) => String(value).padStart(2, '0');
/** The model is given the end of a very long meeting rather than nothing. */
const MAX_TRANSCRIPT = 60_000;

/**
 * Meeting notes: everything the microphone hears is kept, and at the end it is written up and saved.
 * shortcut: it hears the room through the microphone only, so people on a call are heard through the
 * speakers, not through headphones, and speakers are not told apart; capture the Mac's own sound and
 * add speaker labels if that matters.
 */
export function createNotes(deps: NotesDeps) {
  const now = deps.now ?? (() => new Date());
  let lines: string[] = [];
  let startedAt = now();
  return {
    start(): void {
      lines = [];
      startedAt = now();
    },
    add(text: string): void {
      const at = now();
      lines.push(`${two(at.getHours())}:${two(at.getMinutes())} ${text}`);
    },
    /** Saves the notes and returns what to say about them. */
    async end(): Promise<string> {
      if (lines.length === 0) return 'Nothing was said, sir, so there are no notes.';
      const transcript = lines.join('\n');
      const day = `${startedAt.getFullYear()}-${two(startedAt.getMonth() + 1)}-${two(startedAt.getDate())}`;
      const title = `Meeting ${day} ${two(startedAt.getHours())}.${two(startedAt.getMinutes())}`;
      const file = join(deps.dir, `${title}.md`);
      const page = (notes: string) => `# ${title}\n\n${notes ? `${notes}\n\n` : ''}## Transcript\n\n${transcript}\n`;
      mkdirSync(deps.dir, { recursive: true });
      writeFileSync(file, page('')); // the words are saved first, so a failed summary loses nothing
      lines = [];
      try {
        const [spoken = '', ...written] = (await deps.write(transcript.slice(-MAX_TRANSCRIPT))).split(/\n\s*-{3,}\s*\n/);
        writeFileSync(file, page(written.join('\n\n').trim() || spoken.trim()));
        return `${spoken.trim()} The notes are in your Documents folder, under Meeting notes.`;
      } catch {
        return 'I could not write the summary, sir, but everything that was said is saved in your Documents folder, under Meeting notes.';
      }
    },
  };
}
