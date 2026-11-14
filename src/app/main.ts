import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, systemPreferences, Tray, utilityProcess } from 'electron';
import { keychainKeys } from '../key-pool.ts';
import { LOGIN_AGENT, setStartAtLogin } from './login.ts';
import { needsSetup, runSetup } from './setup.ts';
import { dragTo, type Gesture } from './gestures.ts';
import type { ToEngine, ToMain, ToRenderer } from './messages.ts';

// Inside Jarvis.app (see scripts/make-app.mjs) the project folder is named by the app's shell.
const root = process.env.JARVIS_PROJECT ?? app.getAppPath();
const dist = join(root, 'dist');
const selftest = process.env.JARVIS_SELFTEST === '1';

// Everything Jarvis and its engine print also goes to ~/Library/Logs/Jarvis/jarvis.log, so a problem
// can be traced afterwards even when Jarvis was started from the Dock or at login, with no terminal.
const logDir = join(homedir(), 'Library/Logs/Jarvis');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'jarvis.log');
if (existsSync(logFile) && statSync(logFile).size > 5_000_000) renameSync(logFile, `${logFile}.old`);
const logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
const toLog = (text: string) => logStream.write(text.replace(/^(?=.)/gm, `${new Date().toISOString()} `));
for (const level of ['log', 'error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...parts: unknown[]) => {
    original(...parts);
    toLog(`${format(...parts)}\n`);
  };
}
// Settings: the project's .env while developing; for the installed app, settings.env in Jarvis's data
// folder (~/Library/Application Support/Jarvis), the same lines as .env.example.
for (const file of [join(root, '.env'), join(app.getPath('userData'), 'settings.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Not there: settings keep their defaults.
  }
}
// The keys are in .env, or in the Keychain once `npm run keys-to-keychain` has moved them. With neither, the engine says so in the window.
process.env.NVIDIA_API_KEYS ||= keychainKeys();
process.env.GROQ_API_KEYS ||= keychainKeys('groq'); // optional: without them NVIDIA answers everything
// Opened from Finder or at login, an app gets a bare PATH without Homebrew, where whisper-server, brew and gh live.
process.env.PATH = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')])].filter(Boolean).join(':');

// The self-test can stand in a video file for the webcam, to check hand control without a real hand.
const fakeCamera = selftest ? process.env.JARVIS_SELFTEST_CAMERA : undefined;
if (fakeCamera) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-video-capture', fakeCamera);
}

// One Jarvis at a time: a second launch (say, at login while one is running) just quits.
const only = selftest || app.requestSingleInstanceLock();
if (!only) app.quit();

const describe = (message: ToRenderer) =>
  message.type === 'timing'
    ? `timing: transcript ${Math.round(message.transcriptMs)} ms, model's first words ${Math.round(message.firstWordsMs)} ms, first sound ${Math.round(message.firstAudioMs)} ms`
    : message.type === 'awake'
      ? (message.awake ? `awake (${message.persona})` : 'asleep')
      : message.type === 'voice'
        ? `voice: ${message.result}${'score' in message ? ` (match ${message.score.toFixed(2)})` : 'threshold' in message ? ` (pass mark ${message.threshold})` : ''}`
        : message.type === 'tool'
          ? `tool ${message.status}: ${message.detail}`
      : message.type === 'ignored' ? `not addressed: ${JSON.stringify(message.text)}`
      : message.type === 'heard' || message.type === 'speech' ? `${message.type}: ${message.text}` : 'message' in message ? `${message.type}: ${message.message}` : message.type;

app.whenReady().then(async () => {
  if (!only) return;
  // The first time (or when the keys or the microphone are missing), the setup window comes first.
  if (!selftest && needsSetup()) await runSetup(dist, ({ startAtLogin }) => setStartAtLogin(startAtLogin, process.execPath, root));
  else if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');

  // The window is see-through but still catches clicks, so it is kept as small as the orb and its caption.
  const SIZE = { width: 240, height: 280 };
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    ...SIZE,
    x: area.x + area.width - SIZE.width - 24,
    y: area.y + area.height - SIZE.height - 24,
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
      { label: 'Hand control (uses the camera)', type: 'checkbox', checked: handsOn, accelerator: 'Control+Alt+H', click: (item) => void setHands(item.checked) },
      { label: 'Set up permissions…', click: () => void runSetup(dist, ({ startAtLogin }) => setStartAtLogin(startAtLogin, process.execPath, root)) },
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
  // --- Hand control: a pinch grabs the hologram, moving the hand moves it. ---
  let handsOn = false;
  const setHands = async (on: boolean) => {
    if (on && process.platform === 'darwin' && !fakeCamera && !(await systemPreferences.askForMediaAccess('camera'))) {
      console.log('[jarvis] hand control needs the camera, which macOS has not allowed');
      return;
    }
    handsOn = on;
    toRenderer({ type: 'hand-control', on });
  };
  let held: { x: number; y: number } | undefined;
  const gesture = (move: Gesture) => {
    if (move.type === 'grab') {
      const [x, y] = window.getPosition() as [number, number];
      held = { x, y };
    } else if (move.type === 'drag' && held) {
      held = dragTo(held, move, screen.getDisplayMatching(window.getBounds()).workArea, window.getBounds());
      window.setPosition(Math.round(held.x), Math.round(held.y));
    } else if (move.type === 'release' && held) {
      console.log(`[jarvis] gesture: moved the window to ${window.getPosition().join(', ')}`);
      held = undefined;
    }
    if (move.type === 'grab') console.log('[jarvis] gesture: grab');
  };

  window.webContents.on('context-menu', () =>
    Menu.buildFromTemplate([
      { label: 'Hide the orb (Jarvis keeps listening; show it from the menu bar)', click: toggleOrb },
      { label: 'Forget my voice (answer to anyone)', click: () => engine.postMessage({ type: 'forget-voice' } satisfies ToEngine) },
      { role: 'quit', label: 'Quit Jarvis' },
    ]).popup(),
  );

  const engine = utilityProcess.fork(join(dist, 'engine.js'), [], { env: { ...process.env, JARVIS_ROOT: root, JARVIS_DATA: app.getPath('userData') }, stdio: 'pipe' });
  for (const [stream, out] of [[engine.stdout, process.stdout], [engine.stderr, process.stderr]] as const) {
    stream?.on('data', (chunk: Buffer) => {
      out.write(chunk);
      toLog(chunk.toString());
    });
  }
  let quitting = false;
  let status: ToRenderer | undefined; // ready or fatal, replayed if the window loads after the engine
  const toRenderer = (message: ToRenderer) => {
    if (message.type === 'ready' || message.type === 'fatal') status = message;
    if (!window.isDestroyed()) window.webContents.send('jarvis', message);
  };

  // What Jarvis did and what went wrong, kept on disk: opened from Finder there is no terminal to show it.
  const activityLog = join(app.getPath('userData'), 'activity.log');
  // shortcut: started afresh once it passes 2 MB (months of use); rotate properly if the history ever matters.
  if ((await stat(activityLog).catch(() => ({ size: 0 }))).size > 2_000_000) await writeFile(activityLog, '');
  const keep = (line: string) => void appendFile(activityLog, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }).catch(() => {});

  let helperPid: number | undefined;
  let turnsLeft = Number(process.env.JARVIS_SELFTEST_TURNS ?? 1);
  engine.on('message', (message: ToRenderer) => {
    if (message.type === 'helper') return void (helperPid = message.pid);
    if (message.type === 'hand-control') return void setHands(message.on); // asked for by voice
    if (message.type === 'camera-look') {
      // macOS must allow the camera first; the window then takes the one picture.
      const { id } = message;
      const allowed = process.platform !== 'darwin' || Boolean(fakeCamera) || systemPreferences.askForMediaAccess('camera');
      return void Promise.resolve(allowed).then((yes) => (yes ? toRenderer(message) : engine.postMessage({ type: 'camera-frame', id, error: 'macOS has not allowed Jarvis to use the camera' } satisfies ToEngine)));
    }
    console.log(`[jarvis] ${describe(message)}`);
    if (message.type === 'tool' || message.type === 'error' || message.type === 'fatal') keep(describe(message));
    toRenderer(message);
    // The self-test speaks to itself, so the real microphone is switched off: room noise must not interrupt it.
    if (selftest && message.type === 'ready') toRenderer({ type: 'toggle-mic' });
    if (fakeCamera && message.type === 'ready' && process.env.JARVIS_SELFTEST_ASK === 'none') void setHands(true);
    // JARVIS_SELFTEST_SECONDS: quit this long after starting, for tests where Jarvis says nothing.
    if (selftest && message.type === 'ready' && process.env.JARVIS_SELFTEST_SECONDS) setTimeout(() => app.quit(), Number(process.env.JARVIS_SELFTEST_SECONDS) * 1000);
    if (selftest && message.type === 'ready') engine.postMessage({ type: 'selftest', question: process.env.JARVIS_SELFTEST_ASK, answer: process.env.JARVIS_SELFTEST_ANSWER, answerTo: process.env.JARVIS_SELFTEST_ANSWER_TO } satisfies ToEngine);
    // Self-test capture: the orb mid-sentence. A dark backdrop stands in for the desktop.
    const shot = selftest ? process.env.JARVIS_SELFTEST_SHOT : undefined;
    const capture = async (name: string) => writeFile(`${shot}-${name}.png`, (await window.webContents.capturePage()).toPNG());
    if (shot && message.type === 'ready') void window.webContents.insertCSS('html { background: #0b1218 !important; }');
    if (shot && message.type === 'speech') setTimeout(() => void capture('speaking'), 400);
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
    if (message?.type === 'gesture' && message.gesture && typeof message.gesture === 'object') gesture(message.gesture);
    else if (message?.type === 'camera-frame' && typeof message.id === 'number') {
      const jpeg = typeof message.jpeg === 'string' && message.jpeg.length < 8_000_000 ? message.jpeg : undefined;
      engine.postMessage({ type: 'camera-frame', id: message.id, ...(jpeg ? { jpeg } : { error: typeof message.error === 'string' ? message.error.slice(0, 300) : 'the camera gave no picture' }) } satisfies ToEngine);
    } else if (message?.type === 'hand-status') {
      if (message.status === 'off' || message.status === 'error') handsOn = false;
      if (['starting', 'watching', 'off', 'error'].includes(message.status)) console.log(`[jarvis] hand control: ${message.status}${message.detail ? ` (${message.detail})` : ''}`);
    }
    else if (message?.type === 'frame-rate') {
      const rate = Number(message.framesPerSecond);
      if (selftest || rate < 50) console.log(`[jarvis] orb frame rate while speaking: ${rate.toFixed(0)} frames per second`);
    } else if (selftest && ['interrupt', 'user-speech', 'utterance'].includes(message?.type)) {
      // The self-test talks to itself; nothing from the real microphone may reach it.
    } else if (message?.type === 'interrupt') engine.postMessage({ type: 'interrupt', byVoice: message.byVoice === true } satisfies ToEngine);
    else if (message?.type === 'user-speech') engine.postMessage({ type: 'user-speech', active: message.active === true } satisfies ToEngine);
    else if (message?.type === 'utterance' && message.audio instanceof Float32Array) engine.postMessage({ type: 'utterance', audio: message.audio } satisfies ToEngine);
  });

  globalShortcut.register('Control+Alt+J', () => toRenderer({ type: 'toggle-mic' }));
  globalShortcut.register('Control+Alt+H', () => void setHands(!handsOn));
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
