import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, systemPreferences, Tray, utilityProcess } from 'electron';
import { LOGIN_AGENT, setStartAtLogin } from './login.ts';
import type { ToEngine, ToMain, ToRenderer } from './messages.ts';

const root = app.getAppPath();
const dist = join(root, 'dist');
const selftest = process.env.JARVIS_SELFTEST === '1';
// shortcut: keys come from .env; move them to the macOS Keychain when the app is packaged.
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No .env: the engine reports the missing keys in the window.
}

// One Jarvis at a time: a second launch (say, at login while one is running) just quits.
if (!selftest && !app.requestSingleInstanceLock()) app.quit();

const describe = (message: ToRenderer) =>
  message.type === 'timing'
    ? `timing: transcript ${Math.round(message.transcriptMs)} ms, model's first words ${Math.round(message.firstWordsMs)} ms, first sound ${Math.round(message.firstAudioMs)} ms`
    : message.type === 'awake'
      ? (message.awake ? `awake (${message.persona})` : 'asleep')
      : message.type === 'voice'
        ? `voice: ${message.result}${'score' in message ? ` (match ${message.score.toFixed(2)})` : ''}`
        : message.type === 'tool'
          ? `tool ${message.status}: ${message.detail}`
      : message.type === 'heard' || message.type === 'speech' ? `${message.type}: ${message.text}` : 'message' in message ? `${message.type}: ${message.message}` : message.type;

app.whenReady().then(async () => {
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');

  // Orb only, or orb with the panels to its left. The window is see-through but still catches clicks,
  // so it is kept as small as what it shows.
  const COMPACT = { width: 240, height: 310 };
  const EXPANDED = { width: 700, height: 470 };
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...COMPACT,
    x: area.x + area.width - COMPACT.width - 24,
    y: area.y + area.height - COMPACT.height - 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    // Hidden, the window must keep listening at full speed.
    webPreferences: { preload: join(dist, 'preload.cjs'), backgroundThrottling: false },
  });
  // A menu-bar app: no Dock icon, and the orb can be hidden while Jarvis keeps listening.
  app.dock?.hide();
  // Keeps the Mac from going to sleep on its own, on battery too (-i), so Jarvis keeps listening with the
  // screen off. Closing the lid or choosing Sleep still sleeps it; a scheduled wake brings it back.
  const awake = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
  powerMonitor.on('resume', () => engine.postMessage({ type: 'resume' } satisfies ToEngine));
  const toggleOrb = () => (window.isVisible() ? window.hide() : window.showInactive());
  const tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('◉');
  tray.setToolTip('Jarvis');
  const trayMenu = () =>
    Menu.buildFromTemplate([
      { label: window.isVisible() ? 'Hide the orb' : 'Show the orb', click: toggleOrb },
      { label: 'Microphone on or off', accelerator: 'Control+Alt+J', click: () => toRenderer({ type: 'toggle-mic' }) },
      { label: 'Start at login', type: 'checkbox', checked: existsSync(LOGIN_AGENT), click: (item) => void setStartAtLogin(item.checked, process.execPath, root) },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Jarvis' },
    ]);
  tray.on('click', () => tray.popUpContextMenu(trayMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') console.log(`[window ${event.level}] ${event.message}`);
  });
  let panelsOpen = false;
  const togglePanels = () => {
    panelsOpen = !panelsOpen;
    // Grow and shrink from the bottom-right corner, so the orb stays where it is.
    const { x, y, width, height } = window.getBounds();
    const size = panelsOpen ? EXPANDED : COMPACT;
    window.setBounds({ ...size, x: x + width - size.width, y: y + height - size.height });
    toRenderer({ type: 'panels', open: panelsOpen });
  };

  window.webContents.on('context-menu', () =>
    Menu.buildFromTemplate([
      { label: panelsOpen ? 'Hide panels' : 'Show panels', click: togglePanels },
      { label: 'Hide the orb (Jarvis keeps listening; show it from the menu bar)', click: toggleOrb },
      { label: 'Forget my voice (answer to anyone)', click: () => engine.postMessage({ type: 'forget-voice' } satisfies ToEngine) },
      { role: 'quit', label: 'Quit Jarvis' },
    ]).popup(),
  );

  const engine = utilityProcess.fork(join(dist, 'engine.js'), [], { env: { ...process.env, JARVIS_ROOT: root, JARVIS_DATA: app.getPath('userData') }, stdio: 'inherit' });
  let quitting = false;
  let status: ToRenderer | undefined; // ready or fatal, replayed if the window loads after the engine
  const toRenderer = (message: ToRenderer) => {
    if (message.type === 'ready' || message.type === 'fatal') status = message;
    if (!window.isDestroyed()) window.webContents.send('jarvis', message);
  };

  let helperPid: number | undefined;
  let turnsLeft = Number(process.env.JARVIS_SELFTEST_TURNS ?? 1);
  engine.on('message', (message: ToRenderer) => {
    if (message.type === 'helper') return void (helperPid = message.pid);
    console.log(`[jarvis] ${describe(message)}`);
    toRenderer(message);
    // The self-test speaks to itself, so the real microphone is switched off: room noise must not interrupt it.
    if (selftest && message.type === 'ready') toRenderer({ type: 'toggle-mic' });
    if (selftest && message.type === 'ready') engine.postMessage({ type: 'selftest', question: process.env.JARVIS_SELFTEST_ASK, answer: process.env.JARVIS_SELFTEST_ANSWER, answerTo: process.env.JARVIS_SELFTEST_ANSWER_TO } satisfies ToEngine);
    // Self-test captures: the orb mid-sentence, then the open panels. A dark backdrop stands in for the desktop.
    const shot = selftest ? process.env.JARVIS_SELFTEST_SHOT : undefined;
    const capture = async (name: string) => writeFile(`${shot}-${name}.png`, (await window.webContents.capturePage()).toPNG());
    if (shot && message.type === 'ready') void window.webContents.insertCSS('html { background: #0b1218 !important; }');
    if (shot && message.type === 'speech') setTimeout(() => void capture('speaking'), 400);
    if (shot && message.type === 'done') {
      setTimeout(togglePanels, 2500);
      setTimeout(() => void capture('panels'), 4000);
    }
    // JARVIS_SELFTEST_TURNS: how many turns to wait for, to test something Jarvis says later on its own.
    if (selftest && message.type === 'done') turnsLeft--;
    if (selftest && ((message.type === 'done' && turnsLeft <= 0) || message.type === 'fatal')) setTimeout(() => app.quit(), 6000);
  });
  engine.on('exit', (code) => {
    if (!quitting) toRenderer({ type: 'fatal', message: `The speech engine stopped (exit ${code})` });
  });
  window.webContents.on('did-finish-load', () => status && toRenderer(status));

  // The window may only send the messages it has a reason to send, rebuilt here field by field.
  ipcMain.on('jarvis', (_event, message: ToEngine | ToMain) => {
    if (message?.type === 'toggle-panels') togglePanels();
    else if (message?.type === 'frame-rate') {
      const rate = Number(message.framesPerSecond);
      if (selftest || rate < 50) console.log(`[jarvis] orb frame rate while speaking: ${rate.toFixed(0)} frames per second`);
    } else if (selftest && ['interrupt', 'user-speech', 'utterance'].includes(message?.type)) {
      // The self-test talks to itself; nothing from the real microphone may reach it.
    } else if (message?.type === 'interrupt') engine.postMessage({ type: 'interrupt', byVoice: message.byVoice === true } satisfies ToEngine);
    else if (message?.type === 'user-speech') engine.postMessage({ type: 'user-speech', active: message.active === true } satisfies ToEngine);
    else if (message?.type === 'utterance' && message.audio instanceof Float32Array) engine.postMessage(message);
  });

  globalShortcut.register('Control+Alt+J', () => toRenderer({ type: 'toggle-mic' }));
  globalShortcut.register('Control+Alt+P', togglePanels);
  globalShortcut.register('Control+Alt+S', () => {
    engine.postMessage({ type: 'interrupt' } satisfies ToEngine);
    toRenderer({ type: 'stop' });
  });

  app.on('will-quit', () => {
    quitting = true;
    awake.kill();
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
