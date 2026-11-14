// First-run setup: a window that walks through everything Jarvis needs, one click per step. macOS lets
// no app grant itself these permissions, so each step brings up the system's own dialog, or opens the
// exact System Settings page with Jarvis already listed, and ticks itself off once it is allowed.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, ipcMain, shell, systemPreferences } from 'electron';
import { keychainKeys } from '../key-pool.ts';

export type SetupState = {
  keys: boolean;
  microphone: boolean;
  camera: boolean;
  accessibility: boolean;
  screen: boolean;
  /** Calendar, Mail and System Events have been asked for (macOS does not say whether they were allowed). */
  automation: boolean;
  chrome: boolean;
};
export type SetupAction = 'microphone' | 'camera' | 'accessibility' | 'screen' | 'automation' | 'chrome';

const PANES: Record<string, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
};
const marker = () => join(app.getPath('userData'), 'setup.json');
const saved = (): { done?: boolean; automation?: boolean } => {
  try {
    return JSON.parse(readFileSync(marker(), 'utf8')) as { done?: boolean; automation?: boolean };
  } catch {
    return {};
  }
};
const remember = (change: { done?: boolean; automation?: boolean }) => writeFileSync(marker(), JSON.stringify({ ...saved(), ...change }), { mode: 0o600 });

export function setupState(): SetupState {
  return {
    keys: Boolean(process.env.NVIDIA_API_KEYS || keychainKeys()),
    microphone: systemPreferences.getMediaAccessStatus('microphone') === 'granted',
    camera: systemPreferences.getMediaAccessStatus('camera') === 'granted',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    automation: saved().automation === true,
    chrome: ['/Applications/Google Chrome.app', join(homedir(), 'Applications/Google Chrome.app')].some((path) => existsSync(path)),
  };
}

/** Setup is shown the first time, and again whenever something Jarvis cannot work without is missing. */
export function needsSetup(): boolean {
  const state = setupState();
  return !saved().done || !state.keys || !state.microphone;
}

const osascript = (script: string) => new Promise<void>((resolve) => execFile('osascript', ['-e', script], { timeout: 120_000 }, () => resolve()));

async function act(action: SetupAction): Promise<void> {
  if (action === 'microphone' || action === 'camera') {
    // The system dialog appears only the first time; after a refusal, the setting has to be switched on by hand.
    if (!(await systemPreferences.askForMediaAccess(action))) await shell.openExternal(PANES[action]!);
  } else if (action === 'accessibility') {
    // Shows macOS's own prompt and puts Jarvis in the list, so only the switch needs flipping.
    if (!systemPreferences.isTrustedAccessibilityClient(true)) await shell.openExternal(PANES.accessibility!);
  } else if (action === 'screen') {
    // Asking for the screen once puts Jarvis in the Screen Recording list.
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []);
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') await shell.openExternal(PANES.screen!);
  } else if (action === 'automation') {
    // Each asks macOS's "Jarvis wants to control ..." question, once.
    for (const target of ['Calendar', 'Mail', 'System Events']) await osascript(`tell application "${target}" to get name`);
    remember({ automation: true });
  } else if (action === 'chrome') {
    await shell.openExternal('https://www.google.com/chrome/');
  }
}

/** Stores the API keys in the Keychain, where only this user's login can read them. */
function saveKeys(nvidia: string, groq: string): void {
  for (const [provider, value] of [['nvidia', nvidia], ['groq', groq]] as const) {
    const keys = value.split(/[\s,]+/).filter(Boolean).join(',');
    if (!keys) continue;
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', 'Jarvis', '-a', `${provider}-api-keys`, '-w', keys]);
    process.env[provider === 'nvidia' ? 'NVIDIA_API_KEYS' : 'GROQ_API_KEYS'] = keys;
  }
}

/** Opens the setup window and resolves when he presses Finish (or closes it). */
export function runSetup(dist: string, onFinish: (options: { startAtLogin: boolean }) => Promise<void> | void): Promise<void> {
  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 620,
      height: 790,
      title: 'Set up Jarvis',
      resizable: false,
      show: false,
      webPreferences: { preload: join(dist, 'setup-preload.cjs') },
    });
    const send = () => !window.isDestroyed() && window.webContents.send('setup-state', setupState());
    // Switches flipped in System Settings are noticed within a second.
    const poll = setInterval(send, 1000);
    const handlers: [string, (...args: never[]) => unknown][] = [
      ['setup-act', async (_event: unknown, action: SetupAction) => (await act(action), send())],
      ['setup-keys', (_event: unknown, nvidia: string, groq: string) => (saveKeys(String(nvidia ?? ''), String(groq ?? '')), send())],
      ['setup-finish', async (_event: unknown, startAtLogin: boolean) => {
        remember({ done: true });
        await onFinish({ startAtLogin: startAtLogin === true });
        window.close();
      }],
    ];
    for (const [channel, handler] of handlers) ipcMain.on(channel, handler as never);
    window.on('closed', () => {
      clearInterval(poll);
      for (const [channel, handler] of handlers) ipcMain.removeListener(channel, handler as never);
      resolve();
    });
    window.webContents.on('did-finish-load', send);
    window.once('ready-to-show', () => {
      window.show();
      app.focus({ steal: true });
    });
    void window.loadFile(join(dist, 'setup.html'));
  });
}
