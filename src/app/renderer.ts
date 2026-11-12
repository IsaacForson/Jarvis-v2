// The window: listens to the microphone, plays Jarvis's voice, and draws the orb.
import { MicVAD } from '@ricky0123/vad-web';
import type { Bridge, ToRenderer } from './messages.ts';
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
let droppedThrough = 0; // audio from turns up to this one was interrupted and must not play

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
  droppedThrough = latestTurn;
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
const state = (): OrbState =>
  fatal ? 'error' : !ready ? 'loading' : muted ? 'muted' : playing.size === 0 && !pendingTurn && !awake ? 'asleep' : userSpeaking ? 'listening' : playing.size > 0 ? 'speaking' : pendingTurn ? 'thinking' : 'idle';
startOrb(document.getElementById('orb') as HTMLCanvasElement, () => {
  const now = state();
  return { state: now, level: now === 'speaking' ? voiceLevel() : now === 'listening' ? micLevel : 0, friday };
});
const say = (text: string) => (caption.textContent = text);
const RESTING = () => (awake ? `${friday ? 'Friday' : 'Jarvis'} is listening` : 'Say “Jarvis” or “Friday”');

// --- Messages from the engine and the shortcut keys ---
jarvis.onMessage((message: ToRenderer) => {
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
      friday = message.persona === 'friday';
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
    case 'stop':
      stopPlayback();
      pendingTurn = false;
      break;
    case 'toggle-mic':
      void setMuted(!muted);
      break;
  }
});

// --- Microphone: Silero VAD decides when a spoken turn starts and ends. ---
let vad: MicVAD | undefined;
const setMuted = async (value: boolean) => {
  muted = value;
  userSpeaking = false;
  say(muted ? 'Microphone off (Ctrl+Option+J)' : RESTING());
  await (muted ? vad?.pause() : vad?.start());
};

const startMicrophone = async () => {
  try {
  vad = await MicVAD.new({
    model: 'v5',
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
    onSpeechRealStart: interrupt,
    onVADMisfire: () => {
      userSpeaking = false;
      jarvis.send({ type: 'user-speech', active: false });
    },
    onSpeechEnd: (utterance) => {
      userSpeaking = false;
      if (ready && !fatal) jarvis.send({ type: 'utterance', audio: utterance });
    },
  });
  await vad.start();
} catch (error) {
  fatal = `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`;
  say(fatal);
}
};
void startMicrophone();
