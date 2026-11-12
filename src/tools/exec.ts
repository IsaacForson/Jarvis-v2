import { execFile } from 'node:child_process';

/** Runs a program without a shell, so arguments can never be read as shell syntax. Rejects on failure or timeout. */
export function exec(file: string, args: string[], options: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: options.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, cwd: options.cwd }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      const reason = error.killed ? `timed out after ${(options.timeoutMs ?? 30_000) / 1000} s` : stderr.trim() || error.message;
      reject(new Error(reason, { cause: error }));
    });
  });
}

/** Runs AppleScript, or JavaScript for Automation when `javascript` is set. */
export const osascript = (script: string, options: { javascript?: boolean; timeoutMs?: number } = {}) =>
  exec('osascript', [...(options.javascript ? ['-l', 'JavaScript'] : []), '-e', script], { timeoutMs: options.timeoutMs ?? 60_000 });
