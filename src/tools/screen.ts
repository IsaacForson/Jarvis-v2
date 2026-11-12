import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from './exec.ts';
import type { Tool } from './types.ts';

/** `describe` sends a JPEG to a model that can see, with a question, and returns its answer. */
export function screenTools(describe: (jpegBase64: string, question: string) => Promise<string>): Tool[] {
  return [
    {
      name: 'read_screen',
      description: "Look at what is on the user's screen right now and answer a question about it, e.g. what an error says or what a page shows.",
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'What to find out from the screen' } } },
      slow: true,
      run: async (args) => {
        const file = join(tmpdir(), `jarvis-screen-${process.pid}-${Date.now()}.jpg`);
        try {
          await exec('screencapture', ['-x', '-t', 'jpg', file]).catch(() => {
            throw new Error('I am not allowed to see the screen. Screen Recording must be switched on for this app in System Settings, under Privacy and Security.');
          });
          // Halve the size first: a full Retina capture is slow to send and no easier to read.
          await exec('sips', ['-Z', '1600', file]);
          const question = typeof args.question === 'string' && args.question.trim() ? args.question : 'Describe what is on this screen.';
          return await describe((await readFile(file)).toString('base64'), question);
        } finally {
          await rm(file, { force: true }); // a screenshot can show anything; never leave it on disk
        }
      },
    },
  ];
}
