// Phase 0: how fast are the voice (Kokoro) and the listening (whisper.cpp) on this Mac?
// Kokoro speaks a sentence, whisper transcribes that audio, and the transcript must match.
// Run with `npm run voice`. Needs `brew install whisper-cpp ffmpeg` and the model in models/ (see README).
import { KokoroTTS } from 'kokoro-js';
import { median } from './timing.ts';
import { startWhisper } from './whisper.ts';

// small.en measured 269 ms per transcript on this Mac; large-v3-turbo measured 867 ms. English only.
// Set WHISPER_MODEL to compare another model file.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'models/ggml-small.en.bin';
const VOICE = 'bm_george';
const SENTENCES = [
  'Good morning, sir. You have three meetings today.',
  'The deploy finished two minutes ago and all checks passed.',
  'I would not skip lunch if I were you.',
  'Your alarm is set for early tomorrow morning.', // no numbers: whisper writes "7" for "seven"
  'Shall I draft a reply to the last email?',
];
const FIRST_AUDIO_BUDGET_MS = 200;
const TRANSCRIPT_BUDGET_MS = 300;

const ms = (value: number) => `${Math.round(value)} ms`;
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean).join(' ');
const verdict = (value: number, budget: number) => (value <= budget ? `within the ${budget} ms budget` : `OVER the ${budget} ms budget`);

// --- Voice ---
let start = performance.now();
// fp32 measured 2.5x faster than the smaller q8 build on this Mac (M2 Pro).
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
console.log(`Kokoro loaded in ${ms(performance.now() - start)}`);
await tts.generate('Warm up.', { voice: VOICE }); // the first run pays one-off setup costs

const clips: Blob[] = [];
const speakMs: number[] = [];
const speedFactor: number[] = [];
for (const sentence of SENTENCES) {
  start = performance.now();
  const audio = await tts.generate(sentence, { voice: VOICE });
  const took = performance.now() - start;
  speakMs.push(took);
  speedFactor.push(audio.audio.length / audio.sampling_rate / (took / 1000));
  clips.push(audio.toBlob());
}
console.log(`voice      one sentence ready in median ${ms(median(speakMs))}, worst ${ms(Math.max(...speakMs))}  ${verdict(median(speakMs), FIRST_AUDIO_BUDGET_MS)}`);
console.log(`           generates ${median(speedFactor).toFixed(1)}x faster than it plays\n`);

// --- Listening ---
// convert lets the server accept Kokoro's 24 kHz audio (whisper wants 16 kHz); it uses ffmpeg.
start = performance.now();
const whisper = await startWhisper({ model: WHISPER_MODEL, convert: true });
console.log(`whisper loaded in ${ms(performance.now() - start)}`);

let mismatches = 0;
try {
  await whisper.transcribe(clips[0]!); // warm-up
  const listenMs: number[] = [];
  for (const [index, clip] of clips.entries()) {
    start = performance.now();
    const heard = await whisper.transcribe(clip);
    listenMs.push(performance.now() - start);
    if (words(heard) !== words(SENTENCES[index]!)) {
      mismatches++;
      console.log(`  misheard: said "${SENTENCES[index]}" / heard "${heard}"`);
    }
  }
  console.log(`listening  transcript in median ${ms(median(listenMs))}, worst ${ms(Math.max(...listenMs))}  ${verdict(median(listenMs), TRANSCRIPT_BUDGET_MS)}`);
  console.log(`           ${SENTENCES.length - mismatches}/${SENTENCES.length} sentences transcribed word for word`);
} finally {
  whisper.stop();
}

process.exitCode = mismatches > 0 ? 1 : 0;
