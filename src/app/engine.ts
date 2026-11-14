// The speech-and-thinking process. It runs apart from the window so heavy work never stalls the orb.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AutoModelForXVector, AutoProcessor, pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { Assistant } from '../assistant.ts';
import { createChat } from '../chat.ts';
import { KeyPool, parseKeys } from '../key-pool.ts';
import { GROQ_BASE_URL, QUICK, QUICK_VERDICT, SPOKEN, TIERS } from '../models.ts';
import { PERSONAS } from '../persona.ts';
import { createTools } from '../tools/index.ts';
import type { Tool } from '../tools/types.ts';
import { documentText } from '../tools/files.ts';
import { Library } from '../tools/library.ts';
import { factsPrompt, Memory, memoryTools } from '../tools/memory.ts';
import { exec } from '../tools/exec.ts';
import { Initiative, type Mail, parseDated } from '../initiative.ts';
import { runJob } from '../jobs.ts';
import { findLanguage, type Language, LANGUAGES, sayWith } from '../language.ts';
import { createNotes } from '../meeting.ts';
import { createWaker } from '../power.ts';
import { Routines } from '../routines.ts';
import { recentFailures } from '../tools/deploys.ts';
import { Tasks } from '../tasks.ts';
import { devTools } from '../tools/dev.ts';
import { workTools } from '../tools/work.ts';
import { VoiceLock } from '../voice-lock.ts';
import { encodeWav, resample } from '../wav.ts';
import { startWhisper } from '../whisper.ts';
import type { ToEngine, ToRenderer } from './messages.ts';

const SPEED = 1.1; // the stock pace sounded slightly slow
const MIC_RATE = 16_000;
const ROUTER = `You route requests for a voice assistant that can use tools on the user's Mac: see the screen, open and control apps, read and write files, run commands, read the calendar and email, and browse the web. The assistant already knows the current date and time. Reply with one word. Reply TOOL if answering this request correctly requires seeing, reading, looking up or changing anything on the Mac or the internet, including when the request continues such a task ("yes, the second one"). Reply TOOL also when the user tells a lasting fact or preference about himself, the people in his life or his projects, or asks what was said in an earlier conversation, or asks to forget something, or wants a reminder, alarm or repeating task set, changed, snoozed, cancelled or marked done, or wants something done later or regularly, or asks how a job went, or asks about the weather, or replies to a reminder, or wants music played, paused or skipped, or a shortcut run, or refers to what he has copied or selected on screen ("explain this", "translate what I copied"), or wants an email or a message sent to someone, or wants to be told when something happens, or teaches or names a routine ("work mode"), or asks about his code projects, GitHub, Slack or Jira, or asks you to look at something through the camera, or to speak another language, or to find a document by what it says. Reply TALK if it is conversation, opinion, arithmetic, general knowledge or a question about the conversation itself.`;
const URGENCY = `You sort email for a busy person. Reply with one word. Reply URGENT only if this email needs his attention within hours: a real person waiting on him or asking for something, a deadline today, something broken, a security alert about his own accounts, or an interview or meeting invitation. Reply NOT for newsletters, promotions, marketing, social media, automatic confirmations and status updates (such as "your application was received" or "application update"), and other routine notifications.`;
// large-v3-turbo hears accents and names far better than small.en, for about 0.7 s more per sentence
// (measured 12 Nov 2026 on this Mac: 970 ms against 270 ms). JARVIS_WHISPER_MODEL picks another file.
const speechModel = (root: string) => {
  const chosen = process.env.JARVIS_WHISPER_MODEL;
  if (chosen) return join(root, chosen);
  const turbo = join(root, 'models/ggml-large-v3-turbo-q5_0.bin');
  return existsSync(turbo) ? turbo : join(root, 'models/ggml-small.en.bin');
};
const NOTES = `These are the words heard in a meeting through one microphone, in order. Speakers are not marked, and speech recognition may have misheard words: work out what was meant. Reply in two parts separated by a line holding only ---. First, what a personal assistant would say aloud to his employer about the meeting: two or three plain sentences, with no lists, markdown or symbols. Second, the written notes in markdown: a Summary paragraph, then Decisions, Action items (with who, when that was said) and Open questions as lists; leave out any section with nothing in it.`;
const DATED = (today: string) => `Today is ${today}. Does this email tell him about something with a date that he must act on or be ready for: a bill or payment due, a delivery arriving, a flight or trip, an appointment or booking? Newsletters, promotions, receipts for things already paid, and routine notices do not count. Reply NONE, or one line and nothing else: YYYY-MM-DDTHH:MM | what to remind him of, as a short phrase. The time is when to remind him: nine in the morning the day before a bill is due, nine in the morning on the day of a delivery, three hours before a flight or an appointment.`;
const SUMMARY = `Rewrite this report as what a personal assistant would say aloud to his employer: two or three short plain sentences with the outcome and the key figures. No preamble, lists, headings, markdown or symbols; write "dollars", not "$".`;
const send = (message: ToRenderer) => process.parentPort.postMessage(message);

try {
  const root = process.env.JARVIS_ROOT;
  const dataDir = process.env.JARVIS_DATA;
  if (!root || !dataDir) throw new Error('JARVIS_ROOT and JARVIS_DATA must be set');
  const pool = new KeyPool(parseKeys(process.env.NVIDIA_API_KEYS));
  // Every program Jarvis starts (shell commands, scripts, Chrome) inherits this environment; the keys must not be in it.
  delete process.env.NVIDIA_API_KEYS;
  // Groq answers conversation and simple actions, much faster; NVIDIA does the rest, and everything when Groq has no keys or is out of allowance.
  const groqKeys = parseKeys(process.env.GROQ_API_KEYS);
  delete process.env.GROQ_API_KEYS;
  // His work tools' keys, read once and kept out of what child programs inherit, like the model keys.
  const work = { slackToken: process.env.SLACK_TOKEN, jiraSite: process.env.JIRA_SITE, jiraEmail: process.env.JIRA_EMAIL, jiraToken: process.env.JIRA_TOKEN };
  for (const name of ['SLACK_TOKEN', 'JIRA_SITE', 'JIRA_EMAIL', 'JIRA_TOKEN']) delete process.env[name];
  const quickChat = groqKeys.length ? createChat(new KeyPool(groqKeys), GROQ_BASE_URL) : undefined;
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

  // The language of the conversation: English unless he asks for another, and English again after a restart.
  let language: Language | undefined;
  const speak = async (text: string, voice: string = PERSONAS.jarvis.voice) => {
    if (language) return sayWith(language.voice, text); // Kokoro speaks English only
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
        // Older files hold the voiceprint alone; newer ones hold it with its own pass mark.
        const saved = JSON.parse(readFileSync(printFile, 'utf8')) as number[] | { print?: unknown; threshold?: unknown };
        const print = Array.isArray(saved) ? saved : saved.print;
        if (!Array.isArray(print) || !print.every((value) => typeof value === 'number')) return undefined;
        return { print, ...(!Array.isArray(saved) && typeof saved.threshold === 'number' ? { threshold: saved.threshold } : {}) };
      } catch {
        return undefined; // no voice enrolled yet
      }
    },
    save: (voice) => {
      if (!voice) return rmSync(printFile, { force: true });
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(printFile, JSON.stringify(voice), { mode: 0o600 });
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
  // A copy a day of everything remembered, the last week's kept. Forgetting stays forgotten after a week.
  const backUp = () => {
    try {
      const copy = memory.backup(join(dataDir, 'backups'));
      if (copy) console.log(`[jarvis] memory backed up to ${copy}`);
    } catch (error) {
      console.error('[jarvis] memory backup failed:', error instanceof Error ? error.message : error);
    }
  };
  backUp();
  void memory.index(); // lines saved before search by meaning existed, or before a crash
  let speaker = 'jarvis';
  let lastSaid = '';
  let lastTurn = 0;
  let selftestAnswer: string | undefined;
  let selftestAnswerTo = /^Shall I/;
  const autonomous = process.env.JARVIS_AUTONOMOUS === '1';
  // A one-word answer from the small fast model, for quick yes-or-no judgements.
  const verdict = async (system: string, question: string, maxTokens = 4) => {
    const ask = async (via: typeof chat, router: { model: string; extraBody: Record<string, unknown> }) => {
      let answer = '';
      for await (const piece of via({ model: router.model, extraBody: router.extraBody, maxTokens, timeoutMs: 2500, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] })) answer += piece;
      return answer;
    };
    return quickChat ? ask(quickChat, QUICK_VERDICT).catch(() => ask(chat, SPOKEN[1]!)) : ask(chat, SPOKEN[1]!);
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
    dated: async (mail) => {
      const body = pretendMail ? '' : await hands.mailBody(mail.id).catch(() => '');
      return parseDated(await verdict(DATED(new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })), `From: ${mail.from}\nSubject: ${mail.subject}\n\n${body.slice(0, 1500)}`, 40));
    },
    failures: () => recentFailures(),
    upcoming: hands.upcoming,
    idleSeconds: async () => Number(/"HIDIdleTime" = (\d+)/.exec(await exec('ioreg', ['-c', 'IOHIDSystem', '-d', '4']))?.[1] ?? 0) / 1e9,
    briefingAt: process.env.JARVIS_BRIEFING_TIME,
    recapAt: process.env.JARVIS_RECAP_TIME,
  });
  const tasks = new Tasks({
    dbPath: memoryFile,
    runJob: (task, done, onStep) =>
      runJob(task, {
        done,
        onStep,
        chat,
        // Long jobs can wait for the deep model's thinking; the everyday model stands in if it is down.
        model: { model: TIERS.hard.model, extraBody: TIERS.hard.extraBody, fallbacks: [TIERS.medium], timeoutMs: 60_000 },
        tools: jobTools,
        autonomous,
        summarize: async (answer) => {
          let spoken = '';
          const model = SPOKEN[0]!;
          for await (const piece of chat({ model: model.model, extraBody: model.extraBody, maxTokens: 200, timeoutMs: 8000, messages: [{ role: 'system', content: SUMMARY }, { role: 'user', content: answer }] })) spoken += piece;
          return spoken.trim() || answer;
        },
      }),
    // One look for something he asked to be told about, by the everyday model: quick, and it looks often.
    check: async (condition) => {
      const answer = await runJob(
        `Look, once, whether this has happened: "${condition}". Use your tools to look where it would show: the screen, a web page, his email, a command. Change nothing. If it has not happened yet, or you cannot tell, reply with exactly: NOT YET. If it has, reply with one short spoken sentence telling him, starting with "Sir,".`,
        { chat, model: { model: TIERS.medium.model, extraBody: TIERS.medium.extraBody, fallbacks: [SPOKEN[2]!], timeoutMs: 30_000 }, tools: jobTools, autonomous, maxRounds: 8 }, // a look is a few steps, not a project
      );
      console.log(`[jarvis] watch looked for "${condition}": ${answer.trim().slice(0, 160)}`);
      return /not yet|more steps than I am allowed/i.test(answer) || !answer.trim() ? undefined : answer.trim();
    },
    report: (text, note) => initiative.say({ key: `job ${note}`, kind: 'report', text, note }),
  });
  // A job does not start, schedule or watch for further jobs; it browses in a window of its own, so it does not steer the page he is using with Jarvis.
  const jobTools = () => tools.filter((tool) => !['background_task', 'schedule_task', 'cancel_scheduled_task', 'watch_for', 'stop_watching'].includes(tool.name)).map((tool) => hands.jobWebTools.find((own) => own.name === tool.name) ?? tool);
  const handTool: Tool = {
    name: 'hand_control',
    description:
      'Switch hand control on or off. When on, the webcam watches his hand: pinch thumb and finger to grab the hologram and move the hand to move it, and open the hand to let go.',
    parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
    run: async (args) => {
      send({ type: 'hand-control', on: args.on === true });
      return args.on === true ? 'Hand control is on; the camera is watching for his hand.' : 'Hand control is off; the camera is off.';
    },
  };
  // His documents, searchable by meaning. Its own file: it can be rebuilt, so it stays out of the memory backups.
  const library = new Library({
    dbPath: join(dataDir, 'library.db'),
    roots: [join(homedir(), 'Documents'), join(homedir(), 'Desktop')],
    embed: async (text) => (await embedder(text, { pooling: 'mean', normalize: true })).data as Float32Array,
    readText: (path) => documentText(path, (pdf) => exec(join(root, 'dist/ax'), ['pdftext', pdf], { timeoutMs: 60_000 })),
  });
  chmodSync(join(dataDir, 'library.db'), 0o600);
  // Eyes: the window takes one picture from the webcam and sends it back here.
  const looks = new Map<number, { resolve(jpeg: string): void; reject(error: Error): void }>();
  let lookId = 0;
  const cameraPicture = () =>
    new Promise<string>((resolve, reject) => {
      const id = ++lookId;
      looks.set(id, { resolve, reject });
      send({ type: 'camera-look', id });
      setTimeout(() => looks.delete(id) && reject(new Error('The camera did not answer in time.')), 20_000);
    });
  const languageTool: Tool = {
    name: 'set_language',
    description: `Change the language of the conversation: from then on he is heard, and answered aloud, in that language. Offered: English, ${LANGUAGES.map((one) => one.name).join(', ')}. Use it when he asks to speak another language, or to go back to English.`,
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    run: async (args) => {
      const wanted = String(args.language ?? '');
      if (/^\s*(english|anglais|inglés|ingles|englisch|inglese|inglês|en)\s*$/i.test(wanted)) {
        language = undefined;
        return 'The conversation is in English again.';
      }
      const found = findLanguage(wanted);
      if (!found) throw new Error(`I can speak English, ${LANGUAGES.map((one) => one.name).join(', ')}; not "${wanted}".`);
      if (/\.en\.bin$/.test(speechModel(root))) throw new Error('The speech model in use understands English only; the larger one (see the README) understands other languages.');
      language = found;
      return `The conversation is now in ${found.name}. Reply in ${found.name} from now on.`;
    },
  };
  const cameraTool: Tool = {
    name: 'look_through_camera',
    description:
      'Look through the Mac\'s webcam, once, and answer a question about what is in front of it: "what am I holding?", "read this letter", "how do I look?". The camera is on for about a second. Use it only when he asks you to look at something in the room.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'What to find out from the picture' } } },
    slow: true,
    run: async (args) => (await see(await cameraPicture(), `${typeof args.question === 'string' && args.question.trim() ? args.question : 'Describe what the camera shows.'} Answer in plain sentences.`, 500)) || 'I could not make out the picture.',
  };
  const routines = new Routines(memoryFile);
  const tools = [handTool, languageTool, cameraTool, ...routines.tools(), library.tool(), ...devTools(process.env.JARVIS_PROJECTS_DIR || undefined), ...workTools(work), ...hands.tools, ...memoryTools(memory, { onForget: () => assistant.forgetConversation() }), ...initiative.tools(), ...tasks.tools()];

  // What the quick brain may do itself; for anything else it hands over to the main one.
  const QUICK_TOOLS = ['open_app', 'open_url', 'set_volume', 'weather', 'calendar_events', 'unread_email', 'read_email', 'set_reminder', 'reminders', 'reminder_done', 'snooze_reminder', 'remember', 'memories', 'recall', 'take_screenshot', 'start_screen_recording', 'stop_screen_recording', 'hand_control', 'music', 'list_shortcuts', 'run_shortcut', 'read_clipboard', 'read_selection', 'write_clipboard', 'watch_for', 'watching', 'stop_watching', 'save_routine', 'run_routine', 'routines', 'look_through_camera', 'add_calendar_event', 'set_language'];
  const [quickModel, ...quickBackups] = QUICK;

  const assistant = new Assistant({
    // What Jarvis said last helps whisper hear the answer to it ("yes, the second one", names it mentioned).
    transcribe: (audio) => whisper.transcribe(new Blob([encodeWav(audio, MIC_RATE)]), lastSaid.slice(-200), language?.code),
    chat,
    tools,
    context: () => [factsPrompt(memory), routines.prompt(), language ? `He is speaking ${language.name} now: reply in ${language.name}, in the same character. He goes back to English by asking; then call set_language with English.` : ''].filter(Boolean).join('\n'),
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
    // A model that has not started answering within 2.5 s is joined by the next one (it normally starts in
    // 1 to 1.7 s, measured 12 Nov 2026); after 4 s it is given up on. Lightning backs it up first: unlike
    // Bolt it calls tools reliably when given the whole tool list (Bolt answered in words 8 times of 8).
    model: { model: SPOKEN[0]!.model, extraBody: SPOKEN[0]!.extraBody, fallbacks: [SPOKEN[2]!, SPOKEN[1]!], timeoutMs: 4000, hedgeMs: 2500 },
    // Groq normally starts in about half a second; a model silent for 1.2 s is joined by the next, and given up on after 3 s.
    quick: quickChat && { chat: quickChat, model: { ...quickModel!, fallbacks: quickBackups, timeoutMs: 3000, hedgeMs: 1200 }, tools: tools.filter((tool) => QUICK_TOOLS.includes(tool.name)) },
    personas: PERSONAS,
    voiceLock,
    autonomous,
    // Dictation: typed at the keyboard into whatever has focus.
    typeText: async (text) => void (await exec(join(root, 'dist/ax'), ['type', text], { timeoutMs: 20_000 })),
    // Meeting notes are written up by the deep model, which can take its time; the everyday one stands in if it is down.
    notes: createNotes({
      dir: join(homedir(), 'Documents', 'Meeting notes'),
      write: async (transcript) => {
        let reply = '';
        for await (const piece of chat({ model: TIERS.hard.model, extraBody: TIERS.hard.extraBody, fallbacks: [TIERS.medium], maxTokens: 3000, timeoutMs: 60_000, messages: [{ role: 'system', content: NOTES }, { role: 'user', content: transcript }] })) reply += piece;
        if (!reply.trim()) throw new Error('the model returned nothing');
        return reply;
      },
    }),
  });

  process.parentPort.on('message', async ({ data }: { data: ToEngine }) => {
    if (data.type === 'utterance') void assistant.hear(data.audio);
    else if (data.type === 'interrupt') assistant.interrupt(data.byVoice);
    else if (data.type === 'user-speech') assistant.userSpeaking(data.active);
    else if (data.type === 'forget-voice') voiceLock.forget();
    else if (data.type === 'camera-frame') {
      const waiting = looks.get(data.id);
      looks.delete(data.id);
      if (data.jpeg) waiting?.resolve(data.jpeg);
      else waiting?.reject(new Error(`I could not use the camera: ${data.error ?? 'no picture'}`));
    }
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
    void Promise.resolve(backUp())
      .then(() => tasks.tick())
      // A few documents are read into the search index each time, so a big folder never holds anything up.
      .then(() => void library.sync(15).catch((error: unknown) => console.error('[jarvis] document indexing failed:', error instanceof Error ? error.message : error)))
      .then(() => initiative.tick())
      .then(() => wake([...initiative.nextTimes(), ...tasks.nextRuns()]))
      .catch((error: unknown) => console.error('[jarvis] initiative failed:', error instanceof Error ? error.message : error));
  tick();
  setInterval(tick, 30_000);
} catch (error) {
  send({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
}
