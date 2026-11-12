// The speech-and-thinking process. It runs apart from the window so heavy work never stalls the orb.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutoModelForXVector, AutoProcessor, pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { Assistant } from '../assistant.ts';
import { createChat } from '../chat.ts';
import { KeyPool, parseKeys } from '../key-pool.ts';
import { SPOKEN, TIERS } from '../models.ts';
import { PERSONAS } from '../persona.ts';
import { createTools } from '../tools/index.ts';
import { factsPrompt, Memory, memoryTools } from '../tools/memory.ts';
import { exec } from '../tools/exec.ts';
import { Initiative, type Mail } from '../initiative.ts';
import { runJob } from '../jobs.ts';
import { createWaker } from '../power.ts';
import { recentFailures } from '../tools/deploys.ts';
import { Tasks } from '../tasks.ts';
import { VoiceLock } from '../voice-lock.ts';
import { encodeWav, resample } from '../wav.ts';
import { startWhisper } from '../whisper.ts';
import type { ToEngine, ToRenderer } from './messages.ts';

const SPEED = 1.1; // the stock pace sounded slightly slow
const MIC_RATE = 16_000;
const ROUTER = `You route requests for a voice assistant that can use tools on the user's Mac: see the screen, open and control apps, read and write files, run commands, read the calendar and email, and browse the web. The assistant already knows the current date and time. Reply with one word. Reply TOOL if answering this request correctly requires seeing, reading, looking up or changing anything on the Mac or the internet, including when the request continues such a task ("yes, the second one"). Reply TOOL also when the user tells a lasting fact or preference about himself, the people in his life or his projects, or asks what was said in an earlier conversation, or asks to forget something, or wants a reminder, alarm or repeating task set, changed, snoozed, cancelled or marked done, or wants something done later or regularly, or asks how a job went, or asks about the weather, or replies to a reminder. Reply TALK if it is conversation, opinion, arithmetic, general knowledge or a question about the conversation itself.`;
const URGENCY = `You sort email for a busy person. Reply with one word. Reply URGENT only if this email needs his attention within hours: a real person waiting on him or asking for something, a deadline today, something broken, a security alert about his own accounts, or an interview or meeting invitation. Reply NOT for newsletters, promotions, marketing, social media, automatic confirmations and status updates (such as "your application was received" or "application update"), and other routine notifications.`;
// large-v3-turbo hears accents and names far better than small.en, for about 0.7 s more per sentence
// (measured 12 Nov 2026 on this Mac: 970 ms against 270 ms). JARVIS_WHISPER_MODEL picks another file.
const speechModel = (root: string) => {
  const chosen = process.env.JARVIS_WHISPER_MODEL;
  if (chosen) return join(root, chosen);
  const turbo = join(root, 'models/ggml-large-v3-turbo-q5_0.bin');
  return existsSync(turbo) ? turbo : join(root, 'models/ggml-small.en.bin');
};
const SUMMARY = `Rewrite this report as what a personal assistant would say aloud to his employer: two or three short plain sentences with the outcome and the key figures. No preamble, lists, headings, markdown or symbols; write "dollars", not "$".`;
const send = (message: ToRenderer) => process.parentPort.postMessage(message);

try {
  const root = process.env.JARVIS_ROOT;
  const dataDir = process.env.JARVIS_DATA;
  if (!root || !dataDir) throw new Error('JARVIS_ROOT and JARVIS_DATA must be set');
  const pool = new KeyPool(parseKeys(process.env.NVIDIA_API_KEYS));
  const SPEAKER_MODEL = 'Xenova/wavlm-base-plus-sv';
  const [tts, whisper, speakerProcessor, speakerModel, embedder] = await Promise.all([
    // fp32 measured 2.5x faster than the smaller q8 build on this Mac (M2 Pro).
    KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' }),
    startWhisper({ model: speechModel(root), vocabulary: 'Jarvis, Friday, Forson.' }),
    AutoProcessor.from_pretrained(SPEAKER_MODEL),
    // The 8-bit build told voices apart as well as the full one in testing, at a quarter of the size.
    AutoModelForXVector.from_pretrained(SPEAKER_MODEL, { dtype: 'q8', device: 'cpu' }),
    // For memory search by meaning: small (23 MB) and quick (about 2 ms a line on this Mac).
    pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', device: 'cpu' }),
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

  mkdirSync(dataDir, { recursive: true });
  const memoryFile = join(dataDir, 'memory.db');
  const memory = new Memory(memoryFile, { embed: async (text) => (await embedder(text, { pooling: 'mean', normalize: true })).data as Float32Array });
  chmodSync(memoryFile, 0o600);
  void memory.index(); // lines saved before search by meaning existed, or before a crash
  let speaker = 'jarvis';
  let lastSaid = '';
  let lastTurn = 0;
  let selftestAnswer: string | undefined;
  let selftestAnswerTo = /^Shall I/;
  const autonomous = process.env.JARVIS_AUTONOMOUS === '1';
  // A one-word answer from the small fast model, for quick yes-or-no judgements.
  const verdict = async (system: string, question: string) => {
    let answer = '';
    const router = SPOKEN[1]!;
    for await (const piece of chat({ model: router.model, extraBody: router.extraBody, maxTokens: 4, timeoutMs: 2500, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] })) answer += piece;
    return answer;
  };

  // The self-test can stand in a pretend inbox, to check that urgent mail is spoken about unasked.
  const pretendMail = process.env.JARVIS_SELFTEST_MAIL;
  const initiative = new Initiative({
    dbPath: memoryFile,
    announce: (text, note) => assistant.announce(text, note),
    initiate: (instruction) => assistant.initiate(instruction),
    unreadMail: pretendMail ? async () => JSON.parse(pretendMail) as Mail[] : hands.unreadMail,
    // The start of the text too: a plain subject line can hide an urgent request.
    isUrgent: async (mail) => {
      const body = pretendMail ? '' : await hands.mailBody(mail.id).catch(() => '');
      return /urgent/i.test(await verdict(URGENCY, `From: ${mail.from}\nSubject: ${mail.subject}\n\n${body.slice(0, 600)}`));
    },
    failures: () => recentFailures(),
    upcoming: hands.upcoming,
    idleSeconds: async () => Number(/"HIDIdleTime" = (\d+)/.exec(await exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))?.[1] ?? 0) / 1e9,
    briefingAt: process.env.JARVIS_BRIEFING_TIME,
  });
  const tasks = new Tasks({
    dbPath: memoryFile,
    runJob: (task) =>
      runJob(task, {
        chat,
        // Long jobs can wait for the deep model's thinking; the everyday model stands in if it is down.
        model: { model: TIERS.hard.model, extraBody: TIERS.hard.extraBody, fallbacks: [TIERS.medium], timeoutMs: 60_000 },
        // A job does not start or schedule further jobs.
        tools: () => tools.filter((tool) => !['background_task', 'schedule_task', 'cancel_scheduled_task'].includes(tool.name)),
        autonomous,
        summarize: async (answer) => {
          let spoken = '';
          const model = SPOKEN[0]!;
          for await (const piece of chat({ model: model.model, extraBody: model.extraBody, maxTokens: 200, timeoutMs: 8000, messages: [{ role: 'system', content: SUMMARY }, { role: 'user', content: answer }] })) spoken += piece;
          return spoken.trim() || answer;
        },
      }),
    report: (text, note) => initiative.say({ key: `job ${note}`, kind: 'report', text, note }),
  });
  const tools = [...hands.tools, ...memoryTools(memory, { onForget: () => assistant.forgetConversation() }), ...initiative.tools(), ...tasks.tools()];

  const assistant = new Assistant({
    // What Jarvis said last helps whisper hear the answer to it ("yes, the second one", names it mentioned).
    transcribe: (audio) => whisper.transcribe(new Blob([encodeWav(audio, MIC_RATE)]), lastSaid.slice(-200)),
    chat,
    tools,
    context: () => factsPrompt(memory),
    // The small fast model gives a one-word second opinion on whether a request needs a tool. Tested
    // 12 Nov 2026: 17 of 18 sample requests right in about 0.4 s; the larger models were worse at it.
    needsTool: async (request, previous) => /tool/i.test(await verdict(ROUTER, `${previous ? `The assistant just said: "${previous.slice(-300)}"\n` : ''}Request: "${request}"`)),
    speak,
    emit: (event) => {
      if (event.type === 'awake') speaker = event.persona;
      if (event.type === 'heard') {
        memory.log('you', event.text, event.turn);
        initiative.heard();
      }
      if (event.type === 'speech') {
        memory.log(speaker, event.text, event.turn);
        lastSaid = event.turn === lastTurn ? `${lastSaid} ${event.text}` : event.text;
        lastTurn = event.turn;
      }
      if (event.type === 'speech' && selftestAnswer && selftestAnswerTo.test(event.text)) {
        const answer = selftestAnswer;
        selftestAnswer = undefined; // answered once
        setTimeout(async () => {
          const reply = await speak(answer);
          void assistant.hear(resample(reply.samples, reply.sampleRate, MIC_RATE));
        }, 500);
      }
      send(event);
    },
    // A model that has not started answering within 4 s is given up on, and the next one is asked.
    model: { model: SPOKEN[0]!.model, extraBody: SPOKEN[0]!.extraBody, fallbacks: SPOKEN.slice(1), timeoutMs: 4000 },
    personas: PERSONAS,
    voiceLock,
    autonomous,
  });

  process.parentPort.on('message', async ({ data }: { data: ToEngine }) => {
    if (data.type === 'utterance') void assistant.hear(data.audio);
    else if (data.type === 'interrupt') assistant.interrupt(data.byVoice);
    else if (data.type === 'user-speech') assistant.userSpeaking(data.active);
    else if (data.type === 'forget-voice') voiceLock.forget();
    else if (data.type === 'resume') tick(); // back from sleep: catch up on anything that fell due
    else if (data.type === 'selftest') {
      selftestAnswer = data.answer;
      selftestAnswerTo = new RegExp(data.answerTo ?? '^Shall I');
      if (data.question === 'none') return; // only Jarvis's own initiative is being tested
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
  tasks.resume(); // jobs a restart cut short
  const wake = createWaker();
  const tick = () =>
    void Promise.resolve(tasks.tick())
      .then(() => initiative.tick())
      .then(() => wake([...initiative.nextTimes(), ...tasks.nextRuns()]))
      .catch((error: unknown) => console.error('[jarvis] initiative failed:', error instanceof Error ? error.message : error));
  tick();
  setInterval(tick, 30_000);
} catch (error) {
  send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
}
