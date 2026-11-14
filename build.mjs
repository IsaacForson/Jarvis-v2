// Bundles the app into dist/. Run by `npm start`.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const node = { bundle: true, platform: 'node', packages: 'external', target: 'node22', sourcemap: true };
await mkdir('dist', { recursive: true });
await mkdir('models', { recursive: true });

// The accessibility helper is Swift; recompile it only when its source is newer than the program (about 7 s).
const modified = async (path) => (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
if ((await modified('native/ax.swift')) > (await modified('dist/ax'))) execFileSync('swiftc', ['-O', 'native/ax.swift', '-o', 'dist/ax'], { stdio: 'inherit' });

// Small models fetched once: hand tracking for hand control (8 MB), and voice detection that keeps
// room noise from being transcribed as invented sentences (1 MB).
for (const [file, url, without] of [
  ['models/hand_landmarker.task', 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task', 'hand control will not start'],
  ['models/ggml-silero-v5.1.2.bin', 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin', 'room noise may be heard as words'],
]) {
  if (await modified(file)) continue;
  const response = await fetch(url).catch(() => undefined);
  if (response?.ok) await writeFile(file, Buffer.from(await response.arrayBuffer()));
  else console.warn(`Could not download ${file}; ${without}.`);
}

await Promise.all([
  build({ ...node, entryPoints: ['src/app/main.ts', 'src/app/engine.ts'], outdir: 'dist', format: 'esm' }),
  // A sandboxed preload script must be CommonJS.
  build({ ...node, entryPoints: ['src/app/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' }),
  build({ entryPoints: ['src/app/renderer.ts'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', sourcemap: true }),
  copyFile('src/app/index.html', 'dist/index.html'),
]);
