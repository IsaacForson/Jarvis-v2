// The speech-and-thinking process. It runs apart from the window so heavy work never stalls the orb.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoModelForXVector, AutoProcessor } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { Assistant } from '../assistant.ts';
import { createChat } from '../chat.ts';
import { KeyPool, parseKeys } from '../key-pool.ts';
import { SPOKEN } from '../models.ts';
import { PERSONAS } from '../persona.ts';
import { VoiceLock } from '../voice-lock.ts';
import { encodeWav, resample } from '../wav.ts';
import { startWhisper } from '../whisper.ts';
import type { ToEngine, ToRenderer } from './messages.ts';

const SPEED = 1.1; // the stock pace sounded slightly slow
const MIC_RATE = 16_000;
const send = (message: ToRenderer) => process.parentPort.postMessage(message);

try {
  const root = process.env.JARVIS_ROOT;
  const dataDir = process.env.JARVIS_DATA;
  if (!root || !dataDir) throw new Error('JARVIS_ROOT and JARVIS_DATA must be set');
  const pool = new KeyPool(parseKeys(process.env.NVIDIA_API_KEYS));
  const SPEAKER_MODEL = 'Xenova/wavlm-base-plus-sv';
  const [tts, whisper, speakerProcessor, speakerModel] = await Promise.all([
    // fp32 measured 2.5x faster than the smaller q8 build on this Mac (M2 Pro).
    KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' }),
    startWhisper({ model: join(root, 'models/ggml-small.en.bin'), vocabulary: 'Jarvis, Friday, Forson.' }),
    AutoProcessor.from_pretrained(SPEAKER_MODEL),
    // The 8-bit build told voices apart as well as the full one in testing, at a quarter of the size.
    AutoModelForXVector.from_pretrained(SPEAKER_MODEL, { dtype: 'q8', device: 'cpu' }),
  ]);
  process.on('exit', whisper.stop);
  if (whisper.pid) send({ type: 'helper', pid: whisper.pid });

  const speak = async (text: string, voice: string = PERSONAS.jarvis.voice) => {
    const audio = await tts.generate(text, { voice: voice as keyof typeof tts.voices, speed: SPEED });
    return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
  };

  // The owner's voiceprint: numbers that describe a voice, not a recording. It stays in this file on this Mac.
  const printFile = join(dataDir, 'voiceprint.json');
  const voiceLock = new VoiceLock({
    embed: async (audio) => {
      const { embeddings } = await speakerModel(await speakerProcessor(audio));
      return Float32Array.from(embeddings.data as Float32Array);
    },
    load: () => {
      try {
        const saved: unknown = JSON.parse(readFileSync(printFile, 'utf8'));
        return Array.isArray(saved) && saved.every((value) => typeof value === 'number') ? saved : undefined;
      } catch {
        return undefined; // no voice enrolled yet
      }
    },
    save: (print) => {
      if (!print) return rmSync(printFile, { force: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(printFile, JSON.stringify(print), { mode: 0o600 });
    },
  });

  // The first run of each model pays one-off setup costs; pay them now, not on the first question.
  const silence = new Float32Array(MIC_RATE);
  await Promise.all([
    speak('Ready.'),
    speakerProcessor(silence).then(speakerModel),
    whisper.transcribe(new Blob([encodeWav(silence, MIC_RATE)])),
  ]);

  const assistant = new Assistant({
    transcribe: (audio) => whisper.transcribe(new Blob([encodeWav(audio, MIC_RATE)])),
    chat: createChat(pool),
    speak,
    emit: send,
    // A model that has not started answering within 4 s is given up on, and the next one is asked.
    model: { model: SPOKEN[0]!.model, extraBody: SPOKEN[0]!.extraBody, fallbacks: SPOKEN.slice(1), timeoutMs: 4000 },
    personas: PERSONAS,
    voiceLock,
  });

  process.parentPort.on('message', async ({ data }: { data: ToEngine }) => {
    if (data.type === 'utterance') void assistant.hear(data.audio);
    else if (data.type === 'interrupt') assistant.interrupt(data.byVoice);
    else if (data.type === 'user-speech') assistant.userSpeaking(data.active);
    else if (data.type === 'forget-voice') voiceLock.forget();
    else if (data.type === 'selftest') {
      const question = await speak('Jarvis, are you there?');
      void assistant.hear(resample(question.samples, question.sampleRate, MIC_RATE));
    } else if (data.type === 'shutdown') {
      whisper.stop();
      // A normal exit crashes inside onnxruntime's cleanup ("mutex lock failed"); nothing here needs flushing.
      process.kill(process.pid, 'SIGKILL');
    }
  });
  send({ type: 'ready' });
} catch (error) {
  send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
}
