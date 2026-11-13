import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './exec.ts';
import { text, type Tool } from './types.ts';

type Cask = { token: string; name: string[]; desc: string | null; installed: string | null; artifacts?: { app?: unknown[] }[] };
export type Brew = (args: string[], timeoutMs?: number) => Promise<string>;
const brewCommand: Brew = (args, timeoutMs = 60_000) => exec('brew', args, { timeoutMs });

/** The best Homebrew app for a name: an exact match first, then one whose app name matches, then the first found. */
export async function findCask(name: string, brew: Brew = brewCommand): Promise<Cask | undefined> {
  const wanted = name.trim().toLowerCase();
  const tokens = (await brew(['search', '--cask', wanted]).catch(() => '')).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('==>'));
  if (tokens.length === 0) return undefined;
  const candidates = tokens.slice(0, 8);
  const { casks } = JSON.parse(await brew(['info', '--cask', '--json=v2', ...candidates])) as { casks: Cask[] };
  const slug = wanted.replace(/\s+/g, '-');
  return casks.find((cask) => cask.token === slug) ?? casks.find((cask) => cask.name.some((one) => one.toLowerCase() === wanted)) ?? casks[0];
}

/**
 * Installing Mac apps with Homebrew, which downloads each app from its maker and checks it. Apps only
 * in the App Store are installed through the App Store app with the app tools.
 */
export function installTools(brew: Brew = brewCommand, applications = '/Applications'): Tool[] {
  return [
    {
      name: 'install_app',
      description:
        'Download and install a Mac app by name, e.g. "VLC", "Spotify", "Zoom", "Visual Studio Code", using Homebrew. Says what it found and installed. For apps only in the App Store, open the App Store with app_read and use Get instead.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The app name' } }, required: ['name'] },
      approval: (args) => `download and install ${text(args, 'name')}`,
      slow: true,
      run: async (args) => {
        const cask = await findCask(text(args, 'name'), brew);
        if (!cask) throw new Error(`Homebrew has no app called "${String(args.name)}". It may be in the App Store: open it with app_read("App Store"), search, and press Get.`);
        const title = `${cask.name[0] ?? cask.token}${cask.desc ? ` (${cask.desc})` : ''}`;
        // Installed by hand rather than by Homebrew still counts, and Homebrew would refuse to overwrite it.
        const app = cask.artifacts?.flatMap((artifact) => artifact.app ?? []).find((one): one is string => typeof one === 'string');
        if (cask.installed || (app && existsSync(join(applications, app)))) return `${title} is already installed.`;
        await brew(['install', '--cask', cask.token], 15 * 60_000).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          if (/password|sudo/i.test(reason)) throw new Error(`Installing ${title} needs his administrator password. He can run: brew install --cask ${cask.token}`);
          throw new Error(`Installing ${title} failed: ${reason.split('\n').slice(-3).join(' ')}`);
        });
        return `Installed ${title}. It is in the Applications folder; open it with open_app.`;
      },
    },
  ];
}
