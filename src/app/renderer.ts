// The window: listens to the microphone, plays Jarvis's voice, and draws the orb.
import { MicVAD } from '@ricky0123/vad-web';
import type { Bridge, ToRenderer } from './messages.ts';
import { handControl } from './hands.ts';
import { type OrbState, startOrb } from './orb.ts';

const jarvis = (window as unknown as { jarvis: Bridge }).jarvis;
const caption = document.getElementById('caption')!;

let ready = false;
let fatal = '';
let muted = false;
let awake = false;
let friday = false;
let userSpeaking = false;
let micLevel = 0;
let pendingTurn = false; // a turn is in flight and has not finished
let latestTurn = 0;
let droppedThrough = 0; // audio from turns up to this one was stopped by the stop key and must not play

// --- Playback: sentences arrive one at a time and are queued back to back. ---
const audio = new AudioContext();
const analyser = audio.createAnalyser();
analyser.fftSize = 512;
analyser.connect(audio.destination);
const playing = new Set<AudioBufferSourceNode>();
let nextStart = 0;

const play = (samples: Float32Array, sampleRate: number) => {
  const buffer = audio.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(analyser);
  source.onended = () => playing.delete(source);
  nextStart = Math.max(audio.currentTime, nextStart);
  source.start(nextStart);
  nextStart += buffer.duration;
  playing.add(source);
};

const stopPlayback = () => {
  for (const source of playing) source.stop();
  playing.clear();
  nextStart = 0;
};

const interrupt = () => {
  if (playing.size === 0 && !pendingTurn) return;
  stopPlayback();
  jarvis.send({ type: 'interrupt', byVoice: true });
};

const voiceLevel = () => {
  const wave = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(wave);
  const rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
  return Math.min(1, rms * 5);
};

// --- Orb ---
// Speaking outranks listening: the microphone often hears Jarvis's own voice, and real speech from
// the user stops playback anyway.
const state = (): OrbState =>
  fatal ? 'error' : !ready ? 'loading' : playing.size > 0 ? 'speaking' : muted ? 'muted' : !pendingTurn && !awake ? 'asleep' : userSpeaking ? 'listening' : pendingTurn ? 'thinking' : 'idle';
const orb = startOrb(document.getElementById('orb') as HTMLCanvasElement, () => {
  const now = state();
  return { state: now, level: now === 'speaking' ? voiceLevel() : now === 'listening' ? micLevel : 0, friday };
});
const say = (text: string) => (caption.textContent = text);
const RESTING = () => (muted ? 'Microphone off (Ctrl+Option+J)' : awake ? `${friday ? 'Friday' : 'Jarvis'} is listening` : 'Say “Jarvis” or “Friday”');

// --- Frame rate: averaged over each spoken reply and reported, so a slow orb shows up in the log. ---
let spokenFrames: number[] = [];
setInterval(() => {
  if (playing.size > 0) spokenFrames.push(orb.framesPerSecond());
  else if (spokenFrames.length > 0) {
    jarvis.send({ type: 'frame-rate', framesPerSecond: spokenFrames.reduce((sum, value) => sum + value, 0) / spokenFrames.length });
    spokenFrames = [];
  }
}, 250);

// --- Messages from the engine and the shortcut keys ---
jarvis.onMessage((message: ToRenderer) => {
  if (message.type === 'awake') friday = message.persona === 'friday';
  switch (message.type) {
    case 'ready':
      ready = true;
      say(RESTING());
      break;
    case 'voice':
      if (message.result === 'stranger') say('Voice not recognised');
      break;
    case 'awake':
      awake = message.awake;
      document.body.classList.toggle('friday', friday);
      say(RESTING());
      break;
    case 'fatal':
      fatal = message.message;
      say(message.message);
      break;
    case 'thinking':
      latestTurn = message.turn;
      pendingTurn = true;
      break;
    case 'heard':
      say(`“${message.text}”`);
      break;
    case 'speech':
      if (message.turn > droppedThrough) play(message.speech.samples, message.speech.sampleRate);
      break;
    case 'error':
      say(message.message);
      break;
    case 'done':
      if (message.turn === latestTurn) pendingTurn = false;
      break;
    case 'tool':
      if (message.status === 'asking') say('Waiting for your yes or no');
      break;
    case 'stop':
      droppedThrough = latestTurn; // the stop key silences the rest of this turn, even sentences already on their way
      stopPlayback();
      pendingTurn = false;
      break;
    case 'toggle-mic':
      void setMuted(!muted);
      break;
    case 'hand-control':
      if (message.on) void hands.start();
      else hands.stop();
      break;
  }
});

// --- Hand control: gestures go to the main process, which moves the window. ---
let handStatus = '';
const hands = handControl(
  (gesture) => jarvis.send({ type: 'gesture', gesture }),
  (status, detail) => {
    if (status === handStatus && !detail) return;
    handStatus = status;
    jarvis.send({ type: 'hand-status', status, ...(detail ? { detail } : {}) });
    document.body.classList.toggle('holding', status === 'holding');
    if (status === 'holding') say('Holding: move your hand, open it to let go');
    else if (status === 'error') say(`Hand control failed: ${detail}`);
    else if (status === 'starting') say('Hand control starting…');
    else if (ready && !fatal) say(status === 'watching' || status === 'seen' ? `${RESTING()} · hand control on` : RESTING());
  },
);

// --- Microphone: Silero VAD decides when a spoken turn starts and ends. ---
let vad: MicVAD | undefined;
const setMuted = async (value: boolean) => {
  muted = value;
  userSpeaking = false;
  say(RESTING());
  await (muted ? vad?.pause() : vad?.start());
};

const startMicrophone = async () => {
  try {
  vad = await MicVAD.new({
    model: 'v5',
    startOnLoad: false, // started below, unless the microphone was switched off meanwhile
    // shortcut: assets load straight from node_modules; copy them into the app when it is packaged.
    baseAssetPath: '../node_modules/@ricky0123/vad-web/dist/',
    onnxWASMBasePath: '../node_modules/onnxruntime-web/dist/',
    // Echo cancellation keeps Jarvis's own voice out of the microphone, which interrupting depends on.
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
    onFrameProcessed: (_probabilities, frame) => {
      micLevel = Math.min(1, Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) * 8);
    },
    // A pause this long ends a turn. Short, so replies start sooner; a sentence split by a longer
    // pause is joined back together by the engine.
    redemptionMs: 500,
    onSpeechStart: () => {
      userSpeaking = true;
      jarvis.send({ type: 'user-speech', active: true });
    },
    // Confirmed speech, not a cough or a click: this is what cuts Jarvis off mid-sentence.
    onSpeechRealStart: () => {
      if (!muted) interrupt();
    },
    onVADMisfire: () => {
      userSpeaking = false;
      jarvis.send({ type: 'user-speech', active: false });
    },
    onSpeechEnd: (utterance) => {
      userSpeaking = false;
      // A VAD that was mid-start when the microphone was switched off can still finish a segment.
      if (ready && !fatal && !muted) jarvis.send({ type: 'utterance', audio: utterance });
    },
  });
  if (!muted) await vad.start(); // the microphone may have been switched off while this was loading
} catch (error) {
  fatal = `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`;
  say(fatal);
}
};
void startMicrophone();
