// Builds Jarvis.app for this Mac: Electron under Jarvis's own name (see brand.mjs). Run with
// `npm run app`. The app is a thin shell that runs this project folder, so `npm run build` updates it
// without rebuilding it; rebuild only after upgrading Electron or moving the project.
// shortcut: it works on this Mac only (it points at this folder); `npm run installer` builds a
// standalone app to install anywhere.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { brandedShell } from './brand.mjs';
import { sign } from './signing.mjs';

const project = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? join(homedir(), 'Applications/Jarvis.app'));
if (!target.endsWith('.app')) throw new Error('The target must end in .app');

// What the shell runs: this project, as `npm start` would. The name keeps the same data folder.
const app = brandedShell(project, target);
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'jarvis', type: 'module', main: 'main.mjs' }));
writeFileSync(join(app, 'main.mjs'), `process.env.JARVIS_PROJECT = ${JSON.stringify(project)};\nawait import(${JSON.stringify(join(project, 'dist/main.js'))});\n`);

// Changing the bundle breaks Electron's own signature; an Apple-silicon Mac will not start it unsigned.
// Always the same certificate, so macOS keeps Jarvis's permissions across rebuilds.
sign(target);
console.log(`Built ${target}\nOpen it once, then allow Jarvis under Privacy and Security: Microphone, Accessibility, Screen Recording (and Camera for hand control).`);
