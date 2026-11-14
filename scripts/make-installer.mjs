// Builds dist/Jarvis-Installer.pkg: a normal macOS installer (Continue, Continue, Install) that puts a
// standalone Jarvis.app in Applications, with everything it needs inside: the code, its libraries, the
// speech models and whisper-server. Then Jarvis opens its setup window for the permissions.
// Run with `npm run installer` (it builds first). Apple-silicon Macs only, like the bundled libraries.
// shortcut: signed with this Mac's own certificate, not an Apple Developer ID, so on another Mac the
// installer opens with right-click, Open, the first time.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { brandedShell } from './brand.mjs';
import { ensureIdentity, sign } from './signing.mjs';

const project = resolve(import.meta.dirname, '..');
const version = process.env.JARVIS_VERSION ?? new Date().toISOString().slice(0, 10).replaceAll('-', '.');
const run = (file, args, options = {}) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], ...options }).toString();
const step = (text) => console.log(`• ${text}`);

const stage = mkdtempSync(join(tmpdir(), 'jarvis-installer-'));
const root = join(stage, 'root');
const target = join(root, 'Jarvis.app');
try {
  step('Making the app shell');
  const app = brandedShell(project, target, version);

  step('Copying the code and the speech models');
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'jarvis', version, type: 'module', main: 'dist/main.js', dependencies: pkg.dependencies }, null, 2));
  copyFileSync(join(project, 'package-lock.json'), join(app, 'package-lock.json'));
  cpSync(join(project, 'dist'), join(app, 'dist'), { recursive: true, filter: (path) => !/\.(dmg|pkg)$/.test(path) && !path.endsWith('.map') });
  mkdirSync(join(app, 'models'));
  for (const model of ['ggml-large-v3-turbo-q5_0.bin', 'ggml-silero-v5.1.2.bin', 'hand_landmarker.task']) {
    if (!existsSync(join(project, 'models', model))) throw new Error(`models/${model} is missing; see the README`);
    copyFileSync(join(project, 'models', model), join(app, 'models', model));
  }

  step('Copying the libraries (development tools left out)');
  // The downloaded voice and meaning models live in transformers' cache inside node_modules and come along.
  cpSync(join(project, 'node_modules'), join(app, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });
  rmSync(join(app, 'package-lock.json'));

  step('Bundling whisper-server and its libraries');
  const bin = join(app, 'bin');
  mkdirSync(bin);
  const server = realpathSync(run('/usr/bin/which', ['whisper-server']).trim());
  copyFileSync(server, join(bin, 'whisper-server'));
  // Every Homebrew library it loads, found by following the links, copied next to it and pointed at there.
  const pending = [join(bin, 'whisper-server')];
  const copied = new Set();
  const local = (path) => /^(\/opt\/homebrew|\/usr\/local|@rpath)/.test(path);
  const resolveLib = (path) => {
    if (!path.startsWith('@rpath/')) return realpathSync(path);
    const name = path.slice('@rpath/'.length);
    const found = [dirname(server), join(dirname(server), '../lib'), '/opt/homebrew/opt/ggml/lib', '/opt/homebrew/opt/whisper.cpp/lib'].map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`Cannot find ${path}`);
    return realpathSync(found);
  };
  while (pending.length) {
    const file = pending.pop();
    run('chmod', ['u+w', file]);
    for (const line of run('otool', ['-L', file]).split('\n').slice(1)) {
      const dependency = line.trim().split(' ')[0];
      if (!dependency || !local(dependency)) continue;
      const name = basename(dependency);
      if (!copied.has(name)) {
        copied.add(name);
        copyFileSync(resolveLib(dependency), join(bin, name));
        pending.push(join(bin, name));
      }
      run('install_name_tool', ['-change', dependency, `@loader_path/${name}`, file]);
    }
    if (file.endsWith('.dylib')) run('install_name_tool', ['-id', `@loader_path/${basename(file)}`, file]);
  }
  // ggml loads its processor and Metal back ends at run time, from the folder the program is in.
  const backends = '/opt/homebrew/opt/ggml/libexec';
  for (const name of readdirSync(backends).filter((one) => one.endsWith('.so'))) {
    copyFileSync(realpathSync(join(backends, name)), join(bin, name));
    run('chmod', ['u+w', join(bin, name)]);
    for (const line of run('otool', ['-L', join(bin, name)]).split('\n').slice(1)) {
      const dependency = line.trim().split(' ')[0];
      if (dependency && local(dependency)) run('install_name_tool', ['-change', dependency, `@loader_path/${basename(dependency)}`, join(bin, name)]);
    }
  }

  // ggml looks for its back ends first in the folder it was built for (Homebrew's), then next to the
  // program. On a Mac with Homebrew's ggml installed, that mixed two copies of the libraries and
  // crashed on the first sentence, so the built-in folder is blanked out (same length, so nothing moves).
  for (const name of readdirSync(bin)) {
    const file = join(bin, name);
    const bytes = readFileSync(file);
    const marker = Buffer.from('/opt/homebrew/Cellar/ggml');
    let changed = false;
    for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) {
      const end = bytes.indexOf(0, at);
      Buffer.from('/var/empty/'.padEnd(end - at, 'x')).copy(bytes, at);
      changed = true;
    }
    if (changed) writeFileSync(file, bytes);
  }

  step('Signing');
  const { identity, keychain } = ensureIdentity();
  // Loose programs are signed one by one; codesign's --deep does not reach into Resources.
  const loose = [...readdirSync(bin).map((name) => join(bin, name)), join(app, 'dist/ax')];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(node|dylib|so)$/.test(entry.name)) loose.push(path);
    }
  };
  walk(join(app, 'node_modules'));
  for (const file of loose) run('codesign', ['--force', '--sign', identity, '--keychain', keychain, file]);
  sign(target);
  run('codesign', ['--verify', '--deep', '--strict', target]);

  step('Making the installer');
  // Installed where the installer says, not moved onto another copy of Jarvis found elsewhere on the Mac.
  const components = join(stage, 'components.plist');
  run('pkgbuild', ['--analyze', '--root', root, components]);
  run('plutil', ['-replace', '0.BundleIsRelocatable', '-bool', 'NO', components]);
  const component = join(stage, 'Jarvis.pkg');
  run('pkgbuild', ['--root', root, '--component-plist', components, '--identifier', 'com.jarvis.assistant', '--version', version, '--install-location', '/Applications', '--scripts', join(project, 'scripts/installer/scripts'), component]);
  const distribution = join(stage, 'distribution.xml');
  writeFileSync(
    distribution,
    `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Jarvis</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_localSystem="true" enable_currentUserHome="true"/>
  <choices-outline><line choice="jarvis"/></choices-outline>
  <choice id="jarvis" title="Jarvis"><pkg-ref id="com.jarvis.assistant"/></choice>
  <pkg-ref id="com.jarvis.assistant" version="${version}">Jarvis.pkg</pkg-ref>
</installer-gui-script>
`,
  );
  mkdirSync(join(project, 'dist'), { recursive: true });
  const output = join(project, 'dist/Jarvis-Installer.pkg');
  run('productbuild', ['--distribution', distribution, '--resources', join(project, 'scripts/installer'), '--package-path', stage, output]);
  console.log(`Built ${output} (${(statSync(output).size / 1e9).toFixed(1)} GB), version ${version}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
