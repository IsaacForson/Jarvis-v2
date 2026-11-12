// Bundles the app into dist/. Run by `npm start`.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { build } from 'esbuild';

const node = { bundle: true, platform: 'node', packages: 'external', target: 'node22', sourcemap: true };
await mkdir('dist', { recursive: true });

// The accessibility helper is Swift; recompile it only when its source is newer than the program (about 7 s).
const modified = async (path) => (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
if ((await modified('native/ax.swift')) > (await modified('dist/ax'))) execFileSync('swiftc', ['-O', 'native/ax.swift', '-o', 'dist/ax'], { stdio: 'inherit' });

await Promise.all([
  build({ ...node, entryPoints: ['src/app/main.ts', 'src/app/engine.ts'], outdir: 'dist', format: 'esm' }),
  // A sandboxed preload script must be CommonJS.
  build({ ...node, entryPoints: ['src/app/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' }),
  build({ entryPoints: ['src/app/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: true }),
  copyFile('src/app/index.html', 'dist/index.html'),
]);
