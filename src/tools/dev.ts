import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { refuseCommand } from './terminal.ts';
import { text, type Tool } from './types.ts';

type Project = { name: string; path: string; branch: string; scripts: string[] };
const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', 'target', 'Pods', 'venv']);
const MAX_PROJECTS = 60;
const TAIL = 3000;

/** The git repositories under a folder, at most three levels down; a repository's own subfolders are not searched. */
export async function findProjects(root: string, depth = 3, found: Project[] = []): Promise<Project[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.name === '.git')) {
    const head = await readFile(join(root, '.git', 'HEAD'), 'utf8').catch(() => '');
    const scripts = await readFile(join(root, 'package.json'), 'utf8').then((raw) => Object.keys((JSON.parse(raw) as { scripts?: object }).scripts ?? {}), () => []);
    found.push({ name: basename(root), path: root, branch: /ref: refs\/heads\/(.+)/.exec(head)?.[1]?.trim() ?? 'detached', scripts });
    return found;
  }
  if (depth === 0) return found;
  for (const entry of entries) {
    if (found.length >= MAX_PROJECTS) break;
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) await findProjects(join(root, entry.name), depth - 1, found);
  }
  return found;
}

/** Runs a command in a folder and returns everything it printed, whether it passed or failed: a failing test run is an answer, not an error. */
const runIn = (cwd: string, command: string, timeoutMs: number) =>
  new Promise<string>((resolve) => {
    execFile('/bin/zsh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const printed = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
      const tail = printed.length > TAIL ? `[the first ${printed.length - TAIL} characters are cut]\n${printed.slice(-TAIL)}` : printed;
      const outcome = !error ? 'It finished without an error.' : error.killed ? `It was stopped after ${timeoutMs / 60_000} minutes.` : `It failed (exit ${String(error.code)}).`;
      resolve(`${outcome}\n${tail || '(it printed nothing)'}`);
    });
  });

/**
 * Developer mode: his code projects by name, and commands run inside one ("run the tests on Jarvis",
 * "what changed since yesterday", "deploy staging").
 */
export function devTools(root: string = join(homedir(), 'Desktop', 'PROJECTS'), timeoutMs = 10 * 60_000): Tool[] {
  const find = async (name: string): Promise<Project> => {
    const projects = await findProjects(root);
    const wanted = name.trim().toLowerCase();
    const match = projects.find((one) => one.name.toLowerCase() === wanted) ?? projects.find((one) => one.name.toLowerCase().includes(wanted) || one.path.toLowerCase().includes(wanted));
    if (!match) throw new Error(`There is no project called "${name}". The projects are: ${projects.map((one) => one.name).join(', ') || 'none found'}.`);
    return match;
  };
  return [
    {
      name: 'dev_projects',
      description: 'List his code projects (git repositories): each one\'s name, branch and the scripts it can run (test, build, deploy and so on).',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const projects = await findProjects(root);
        return projects.length ? projects.map((one) => `${one.name} (branch ${one.branch})${one.scripts.length ? `: scripts ${one.scripts.join(', ')}` : ''}`).join('\n') : 'No code projects were found.';
      },
    },
    {
      name: 'dev_run',
      description:
        'Run a command inside one of his code projects and return what it printed: "npm test", "npm run build", "git status", "git log --since=yesterday --oneline", a deploy script. It may take up to ten minutes; for longer work use background_task. Use dev_projects for the names and scripts.',
      parameters: { type: 'object', properties: { project: { type: 'string', description: 'The project name' }, command: { type: 'string' } }, required: ['project', 'command'] },
      // Looking at git is safe; anything else is named and confirmed.
      approval: (args) => (typeof args.command === 'string' && /^git (status|log|diff|branch|show)\b[^;&|<>`$]*$/.test(args.command.trim()) ? undefined : `run ${text(args, 'command')} in the ${text(args, 'project')} project`),
      slow: true,
      run: async (args) => {
        const command = text(args, 'command');
        refuseCommand(command);
        const project = await find(text(args, 'project'));
        return `In ${project.name}: ${await runIn(project.path, command, timeoutMs)}`;
      },
    },
  ];
}
