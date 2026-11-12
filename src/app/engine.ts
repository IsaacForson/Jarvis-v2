// The speech-and-thinking process. It runs apart from the window so heavy work never stalls the orb.
import { join } from 'node:path';
import { KokoroTTS } from 'kokoro-js';
import { Assistant } from '../assistant.ts';
import { createChat } from '../chat.ts';
import { KeyPool, parseKeys } from '../key-pool.ts';
import { TIERS } from '../models.ts';
import { PERSONA } from '../persona.ts';
import { encodeWav, resample } from '../wav.ts';
import { startWhisper } from '../whisper.ts';
import type { ToEngine, ToRenderer } from './messages.ts';

const VOICE = 'bm_george';
const SPEED = 1.1; // the stock pace sounded slightly slow
const MIC_RATE = 16_000;
const send = (message: ToRenderer) => process.parentPort.postMessage(message);

try {
  const root = process.env.JARVIS_ROOT;
  if (!root) throw new Error('JARVIS_ROOT is not set');
  const pool = new KeyPool(parseKeys(process.env.NVIDIA_API_KEYS));
  const [tts, whisper] = await Promise.all([
    // fp32 measured 2.5x faster than the smaller q8 build on this Mac (M2 Pro).
    KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' }),
    startWhisper({ model: join(root, 'models/ggml-small.en.bin'), vocabulary: 'Jarvis, Forson.' }),
  ]);
  process.on('exit', whisper.stop);
  if (whisper.pid) send({ type: 'helper', pid: whisper.pid });

  const speak = async (text: string) => {
    const audio = await tts.generate(text, { voice: VOICE, speed: SPEED });
    return { samples: audio.audio as Float32Array, sampleRate: audio.sampling_rate };
  };
  await speak('Ready.'); // the first run pays one-off setup costs

  const assistant = new Assistant({
    transcribe: (audio) => whisper.transcribe(new Blob([encodeWav(audio, MIC_RATE)])),
    chat: createChat(pool),
    speak,
    emit: send,
    model: { model: TIERS.easy.model, extraBody: TIERS.easy.extraBody },
    persona: PERSONA,
  });

  process.parentPort.on('message', async ({ data }: { data: ToEngine }) => {
    if (data.type === 'utterance') void assistant.hear(data.audio);
    else if (data.type === 'interrupt') assistant.interrupt();
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
