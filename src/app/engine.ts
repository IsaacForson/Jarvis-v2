// The speech-and-thinking process. It runs apart from the window so heavy work never stalls the orb.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoModelForXVector, AutoProcessor } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { Assistant } from '../assistant.ts';
import { createChat } from '../chat.ts';
import { KeyPool, parseKeys } from '../key-pool.ts';
import { SPOKEN, TIERS } from '../models.ts';
import { PERSONAS } from '../persona.ts';
import { createTools } from '../tools/index.ts';
import { VoiceLock } from '../voice-lock.ts';
import { encodeWav, resample } from '../wav.ts';
import { startWhisper } from '../whisper.ts';
import type { ToEngine, ToRenderer } from './messages.ts';

const SPEED = 1.1; // the stock pace sounded slightly slow
const MIC_RATE = 16_000;
const ROUTER = `You route requests for a voice assistant that can use tools on the user's Mac: see the screen, open and control apps, read and write files, run commands, read the calendar and email, and browse the web. The assistant already knows the current date and time. Reply with one word. Reply TOOL if answering this request correctly requires seeing, reading, looking up or changing anything on the Mac or the internet, including when the request continues such a task ("yes, the second one"). Reply TALK if it is conversation, opinion, arithmetic, general knowledge or a question about the conversation itself.`;
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

  const chat = createChat(pool);
  // One question to the model that reads images (the medium model), with a picture attached.
  const see = async (jpegBase64: string, prompt: string, maxTokens: number, system?: string) => {
    let answer = '';
    const content = [{ type: 'text' as const, text: prompt }, { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }];
    const messages = [...(system ? [{ role: 'system' as const, content: system }] : []), { role: 'user' as const, content }];
    for await (const piece of chat({ model: TIERS.medium.model, extraBody: TIERS.medium.extraBody, maxTokens, timeoutMs: 30_000, messages })) answer += piece;
    return answer;
  };
  const hands = createTools({
    browserProfileDir: join(dataDir, 'browser'),
    accessibilityHelper: join(root, 'dist/ax'),
    describeImage: async (jpegBase64, question) => (await see(jpegBase64, `${question} Answer in plain sentences.`, 500)) || 'I could not make out the screen.',
    locateOnScreen: async (jpegBase64, target) => {
      const reply = await see(jpegBase64, `Locate ${target}. Output only {"x":N,"y":N}: its centre, with x and y from 0 to 1000 across the image width and height.`, 40, 'You locate things in screenshots. Output only JSON, no words.');
      const match = /x"?\s*:\s*([\d.]+)[^\d]+y"?\s*:\s*([\d.]+)/.exec(reply);
      return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
    },
  });

  const assistant = new Assistant({
    transcribe: (audio) => whisper.transcribe(new Blob([encodeWav(audio, MIC_RATE)])),
    chat,
    tools: hands.tools,
    // The small fast model gives a one-word second opinion on whether a request needs a tool. Tested
    // 12 Nov 2026: 17 of 18 sample requests right in about 0.4 s; the larger models were worse at it.
    needsTool: async (request, previous) => {
      let verdict = '';
      const router = SPOKEN[1]!;
      for await (const piece of chat({ model: router.model, extraBody: router.extraBody, maxTokens: 4, timeoutMs: 2500, messages: [{ role: 'system', content: ROUTER }, { role: 'user', content: `${previous ? `The assistant just said: "${previous.slice(-300)}"\n` : ''}Request: "${request}"` }] })) verdict += piece;
      return /tool/i.test(verdict);
    },
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
      const question = await speak(data.question || 'Jarvis, are you there?');
      void assistant.hear(resample(question.samples, question.sampleRate, MIC_RATE));
    } else if (data.type === 'shutdown') {
      whisper.stop();
      // Give the browser two seconds to close cleanly; it also exits by itself when this process dies.
      await Promise.race([hands.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      // A normal exit crashes inside onnxruntime's cleanup ("mutex lock failed"); nothing here needs flushing.
      process.kill(process.pid, 'SIGKILL');
    }
  });
  send({ type: 'ready' });

  // Read slow sources ahead of time (the Calendar app takes up to a minute), now and every ten minutes.
  const readAhead = () => void hands.refresh().catch((error: unknown) => console.error('[jarvis] calendar read-ahead failed:', error instanceof Error ? error.message : error));
  readAhead();
  setInterval(readAhead, 10 * 60_000).unref();
} catch (error) {
  send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
}
