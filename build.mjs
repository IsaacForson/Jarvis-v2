// Bundles the app into dist/. Run by `npm start`.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const node = { bundle: true, platform: 'node', packages: 'external', target: 'node22', sourcemap: true };
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ ...node, entryPoints: ['src/app/main.ts', 'src/app/engine.ts'], outdir: 'dist', format: 'esm' }),
  // A sandboxed preload script must be CommonJS.
  build({ ...node, entryPoints: ['src/app/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' }),
  build({ entryPoints: ['src/app/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: true }),
  copyFile('src/app/index.html', 'dist/index.html'),
]);
