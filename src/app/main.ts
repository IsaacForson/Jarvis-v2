import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, systemPreferences, utilityProcess } from 'electron';
import type { ToEngine, ToRenderer } from './messages.ts';

const root = app.getAppPath();
const dist = join(root, 'dist');
const selftest = process.env.JARVIS_SELFTEST === '1';
// shortcut: keys come from .env; move them to the macOS Keychain when the app is packaged.
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No .env: the engine reports the missing keys in the window.
}

const describe = (message: ToRenderer) =>
  message.type === 'heard' || message.type === 'speech' ? `${message.type}: ${message.text}` : 'message' in message ? `${message.type}: ${message.message}` : message.type;

app.whenReady().then(async () => {
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');

  const size = { width: 240, height: 280 };
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...size,
    x: area.x + area.width - size.width - 24,
    y: area.y + area.height - size.height - 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { preload: join(dist, 'preload.cjs') },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.log(`[window ${event.level}] ${event.message}`);
  });
  window.webContents.on('context-menu', () => Menu.buildFromTemplate([{ role: 'quit', label: 'Quit Jarvis' }]).popup());

  const engine = utilityProcess.fork(join(dist, 'engine.js'), [], { env: { ...process.env, JARVIS_ROOT: root }, stdio: 'inherit' });
  let quitting = false;
  let status: ToRenderer | undefined; // ready or fatal, replayed if the window loads after the engine
  const toRenderer = (message: ToRenderer) => {
    if (message.type === 'ready' || message.type === 'fatal') status = message;
    if (!window.isDestroyed()) window.webContents.send('jarvis', message);
  };

  let helperPid: number | undefined;
  engine.on('message', (message: ToRenderer) => {
    if (message.type === 'helper') return void (helperPid = message.pid);
    console.log(`[jarvis] ${describe(message)}`);
    toRenderer(message);
    if (selftest && message.type === 'ready') engine.postMessage({ type: 'selftest' } satisfies ToEngine);
    if (selftest && message.type === 'speech' && process.env.JARVIS_SELFTEST_SHOT) {
      const shot = process.env.JARVIS_SELFTEST_SHOT;
      setTimeout(async () => writeFile(shot, (await window.webContents.capturePage()).toPNG()), 400);
    }
    if (selftest && (message.type === 'done' || message.type === 'fatal')) setTimeout(() => app.quit(), 6000);
  });
  engine.on('exit', (code) => {
    if (!quitting) toRenderer({ type: 'fatal', message: `The speech engine stopped (exit ${code})` });
  });
  window.webContents.on('did-finish-load', () => status && toRenderer(status));

  // The window may only send the two messages it has a reason to send.
  ipcMain.on('jarvis', (_event, message: ToEngine) => {
    if (message?.type === 'interrupt') engine.postMessage({ type: 'interrupt' } satisfies ToEngine);
    else if (message?.type === 'utterance' && message.audio instanceof Float32Array) engine.postMessage(message);
  });

  globalShortcut.register('Control+Alt+J', () => toRenderer({ type: 'toggle-mic' }));
  globalShortcut.register('Control+Alt+S', () => {
    engine.postMessage({ type: 'interrupt' } satisfies ToEngine);
    toRenderer({ type: 'stop' });
  });

  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    engine.postMessage({ type: 'shutdown' } satisfies ToEngine);
    // The engine may be mid-sentence and never read that message, so stop whisper-server from here too.
    try {
      if (helperPid) process.kill(helperPid, 'SIGKILL');
    } catch {
      // already gone
    }
  });
  await window.loadFile(join(dist, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
