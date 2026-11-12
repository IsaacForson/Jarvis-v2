import { homedir } from 'node:os';
import { exec } from './exec.ts';
import { clip, text, type Tool } from './types.ts';

// Commands that only look, never change anything. Anything else, or anything using shell syntax
// (pipes, redirects, chaining, substitution), is confirmed with the user first.
const READ_ONLY = new Set(['ls', 'pwd', 'date', 'whoami', 'uptime', 'df', 'sw_vers', 'which', 'hostname', 'cal']);
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n]/;

/** Returns what to ask the user before running the command, or undefined if it only looks. */
export function commandApproval(command: string): string | undefined {
  const words = command.trim().split(/\s+/);
  if (READ_ONLY.has(words[0] ?? '') && !SHELL_SYNTAX.test(command)) return undefined;
  return `run the command: ${command.length > 120 ? `${command.slice(0, 120)}, and more` : command}`;
}

export const terminalTools: Tool[] = [
  {
    name: 'run_command',
    description:
      'Run a shell command on the Mac and return its output. Commands that only look (ls, pwd, date, df, which) run at once; anything else is confirmed with the user first. Administrator commands (sudo) are not available.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    approval: (args) => commandApproval(text(args, 'command')),
    slow: true,
    run: async (args) => {
      const command = text(args, 'command');
      // Never administrator rights: there is nobody at a keyboard to type the password, and nothing Jarvis does needs them.
      if (/(^|[\s;&|(])sudo(\s|$)/.test(command)) throw new Error('Administrator (sudo) commands are not allowed');
      return clip((await exec('/bin/zsh', ['-c', command], { cwd: homedir(), timeoutMs: 60_000 })) || 'Done, with no output.', 4000);
    },
  },
];
