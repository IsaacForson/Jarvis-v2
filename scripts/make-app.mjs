// Builds Jarvis.app: Electron under Jarvis's own name and identity, so macOS lists "Jarvis" under
// Microphone, Camera, Accessibility and Screen Recording, instead of whichever app ran `npm start`.
// Run with `npm run app`. The app is a thin shell that runs this project folder, so `npm run build`
// updates it without rebuilding it; rebuild only after upgrading Electron or moving the project.
// shortcut: it works on this Mac only (it points at this folder) and is signed ad hoc, so every
// rebuild makes macOS ask for the permissions again; use a Developer ID and a real bundle to share it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? join(homedir(), 'Applications/Jarvis.app'));
if (!target.endsWith('.app')) throw new Error('The target must end in .app');
const run = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'ignore', 'inherit'] });

rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, '..'), { recursive: true });
run('ditto', [join(project, 'node_modules/electron/dist/Electron.app'), target]);

const plist = join(target, 'Contents/Info.plist');
const set = (key, type, value) => {
  try {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
  }
};
set('CFBundleName', 'string', 'Jarvis');
set('CFBundleDisplayName', 'string', 'Jarvis');
set('CFBundleIdentifier', 'string', 'com.jarvis.assistant');
set('LSUIElement', 'bool', 'true'); // a menu-bar app: no Dock icon
set('NSMicrophoneUsageDescription', 'string', 'Jarvis listens for your voice.');
set('NSCameraUsageDescription', 'string', 'Jarvis watches your hand while hand control is on.');

// The orb icon (drawn by scripts/make-icon.sh), in place of Electron's.
copyFileSync(join(project, 'assets/Jarvis.icns'), join(target, 'Contents/Resources/electron.icns'));

// What the shell runs: this project, as `npm start` would. The name keeps the same data folder.
const app = join(target, 'Contents/Resources/app');
rmSync(join(target, 'Contents/Resources/default_app.asar'), { force: true });
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'jarvis', type: 'module', main: 'main.mjs' }));
writeFileSync(join(app, 'main.mjs'), `process.env.JARVIS_PROJECT = ${JSON.stringify(project)};\nawait import(${JSON.stringify(join(project, 'dist/main.js'))});\n`);

// Changing the bundle breaks Electron's own signature; an Apple-silicon Mac will not start it unsigned.
run('codesign', ['--force', '--deep', '--sign', '-', target]);
console.log(`Built ${target}\nOpen it once, then allow Jarvis under Privacy and Security: Microphone, Accessibility, Screen Recording (and Camera for hand control).`);
