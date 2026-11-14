import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

export type Whisper = {
  /**
   * Transcribes one WAV clip. `context` (what was said just before) helps it hear the next words right;
   * `language` is the two-letter code of the language spoken, English unless given.
   */
  transcribe(wav: Blob, context?: string, language?: string): Promise<string>;
  stop(): void;
  /** The server's process id, so an owner further up can make sure it dies. */
  pid: number | undefined;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/**
 * Starts whisper.cpp's server with the model kept loaded, and resolves once it answers.
 * `convert` makes it accept audio that is not 16 kHz WAV, at the cost of an ffmpeg run per clip.
 * `vocabulary` lists names it should spell correctly, such as "Jarvis".
 */
export async function startWhisper(options: { model: string; convert?: boolean; vocabulary?: string; /** A Silero voice-detection model: clips with no speech come back empty at once. */ vad?: string; /** The server program; default whisper-server on the PATH. */ binary?: string }): Promise<Whisper> {
  if (!existsSync(options.model)) throw new Error(`Missing speech model ${options.model}; see the README for the download command`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Without voice detection, room noise came back as invented sentences ("Sous-titrage Société Radio-Canada",
  // "Thank you.") after up to 5 s of retries, holding up what was said next. With it, noise returns nothing in
  // about 30 ms. No temperature fallback: retrying a hard clip costs seconds and rarely helps a short command.
  const args = ['-m', options.model, '--port', String(port), '-nf', ...(options.vad && existsSync(options.vad) ? ['--vad', '-vm', options.vad] : []), ...(options.convert ? ['--convert'] : [])];
  const server = spawn(options.binary ?? 'whisper-server', args, { stdio: 'ignore' });

  // Rejects if the server dies, so no caller waits forever on a dead process.
  const died = new Promise<never>((_, reject) => {
    server.once('error', (error) => reject(new Error(`whisper-server could not start (is whisper-cpp installed?): ${error.message}`)));
    server.once('exit', (code) => reject(new Error(`whisper-server stopped (exit ${code})`)));
  });
  died.catch(() => {});
  const stop = () => {
    server.removeAllListeners('exit');
    server.kill();
  };

  const ready = async () => {
    const deadline = Date.now() + 120_000;
    while (!(await fetch(url).then((response) => response.ok, () => false))) {
      if (Date.now() > deadline) throw new Error('whisper-server was not ready after 2 minutes');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  try {
    await Promise.race([ready(), died]);
  } catch (error) {
    stop();
    throw error;
  }

  const transcribe = async (wav: Blob, context?: string, language?: string): Promise<string> => {
    const form = new FormData();
    form.set('file', wav, 'clip.wav');
    form.set('response_format', 'json');
    // Always sent, so a clip is never guessed to be another language.
    form.set('language', language ?? 'en');
    const prompt = [options.vocabulary, context].filter(Boolean).join(' ');
    if (prompt) form.set('prompt', prompt);
    // A stuck server must not leave Jarvis deaf without a word: give up and say so.
    const response = await fetch(`${url}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) }).catch((error: unknown) => {
      throw new Error(`whisper-server did not answer: ${error instanceof Error ? error.message : error}`);
    });
    if (!response.ok) throw new Error(`whisper-server answered HTTP ${response.status}`);
    const body = (await response.json()) as { text?: string; error?: string };
    if (typeof body.text !== 'string') throw new Error(`whisper-server returned no text: ${body.error ?? 'unknown error'}`);
    return body.text.trim();
  };

  return { transcribe: (wav, context, language) => Promise.race([transcribe(wav, context, language), died]), stop, pid: server.pid };
}
