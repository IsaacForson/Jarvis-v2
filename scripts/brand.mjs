// Electron under Jarvis's own name and identity, so macOS lists "Jarvis" under Microphone, Camera,
// Accessibility and Screen Recording. Shared by `npm run app` and `npm run installer`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const run = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'ignore', 'inherit'] });

/** Copies Electron to `target` as Jarvis.app and returns the folder its code goes in (Contents/Resources/app). */
export function brandedShell(project, target, version = '1.0.0') {
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
  set('CFBundleShortVersionString', 'string', version);
  set('CFBundleVersion', 'string', version);
  set('LSUIElement', 'bool', 'true'); // a menu-bar app: no Dock icon
  set('NSMicrophoneUsageDescription', 'string', 'Jarvis listens for your voice.');
  set('NSCameraUsageDescription', 'string', 'Jarvis watches your hand while hand control is on.');
  set('NSAppleEventsUsageDescription', 'string', 'Jarvis reads your calendar and mail and works in other apps for you.');
  // The orb icon (drawn by scripts/make-icon.sh), in place of Electron's.
  copyFileSync(join(project, 'assets/Jarvis.icns'), join(target, 'Contents/Resources/electron.icns'));
  rmSync(join(target, 'Contents/Resources/default_app.asar'), { force: true });
  const app = join(target, 'Contents/Resources/app');
  mkdirSync(app, { recursive: true });
  return app;
}
