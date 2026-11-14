import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './tools/exec.ts';
import { decodeWav } from './wav.ts';

/** A language Jarvis can hold a conversation in besides English: how whisper names it, and the Mac voice that speaks it. */
export type Language = { name: string; code: string; voice: string };

// The voices macOS ships with. Kokoro, Jarvis's own voice, speaks English only.
export const LANGUAGES: Language[] = [
  { name: 'French', code: 'fr', voice: 'Thomas' },
  { name: 'Spanish', code: 'es', voice: 'Mónica' },
  { name: 'German', code: 'de', voice: 'Anna' },
  { name: 'Italian', code: 'it', voice: 'Alice' },
  { name: 'Portuguese', code: 'pt', voice: 'Luciana' },
];

/** The language asked for by name, in English or in the language itself ("French", "français"); undefined for English or one not offered. */
export function findLanguage(name: string): Language | undefined {
  const wanted = name.trim().toLowerCase();
  const own: Record<string, string> = { français: 'fr', francais: 'fr', español: 'es', espanol: 'es', deutsch: 'de', italiano: 'it', português: 'pt', portugues: 'pt' };
  return LANGUAGES.find((one) => one.name.toLowerCase() === wanted || one.code === wanted || one.code === own[wanted]);
}

/** Speaks text with a macOS voice and returns the sound, as Kokoro does for English. */
export async function sayWith(voice: string, text: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const file = join(tmpdir(), `jarvis-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await exec('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@24000', '-o', file, text], { timeoutMs: 30_000 });
    return decodeWav(await readFile(file));
  } finally {
    await rm(file, { force: true });
  }
}
