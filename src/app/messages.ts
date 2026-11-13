import type { AssistantEvent } from '../assistant.ts';
import type { Gesture } from './gestures.ts';
import type { HandStatus } from './hands.ts';

/** Renderer to engine (relayed by the main process). */
export type ToEngine =
  | { type: 'utterance'; audio: Float32Array }
  /** `byVoice`: the user started talking over Jarvis, as opposed to pressing the stop key. */
  | { type: 'interrupt'; byVoice?: boolean }
  /** The microphone heard speech start (true) or decided it was only a noise (false). */
  | { type: 'user-speech'; active: boolean }
  /** Development check: the engine speaks a question to itself and answers it. */
  | { type: 'selftest'; question?: string; /** Spoken back when Jarvis asks a yes-or-no question. */ answer?: string; /** What Jarvis says that the answer goes to; default a yes-or-no question. */ answerTo?: string }
  /** From the right-click menu: the way back in if the voice lock stops recognising its owner. */
  | { type: 'forget-voice' }
  /** The Mac woke from sleep. */
  | { type: 'resume' }
  | { type: 'shutdown' };

/** Engine or main process to renderer. */
export type ToRenderer =
  | AssistantEvent
  /** For the main process only: a helper process it must kill on quit, since the engine may be too busy to. */
  | { type: 'helper'; pid: number }
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'toggle-mic' }
  /** The panels were opened or closed (the main process has already resized the window). */
  | { type: 'panels'; open: boolean }
  /** Hand control (the webcam) switched on or off, by voice, the menu or the shortcut. */
  | { type: 'hand-control'; on: boolean }
  | { type: 'stop' };

/** Renderer to main process only. */
export type ToMain =
  | { type: 'toggle-panels' }
  /** The orb's average frame rate while one reply was spoken. */
  | { type: 'frame-rate'; framesPerSecond: number }
  /** A hand gesture seen by the webcam. */
  | { type: 'gesture'; gesture: Gesture }
  /** Hand control's state, for the menu and the log. */
  | { type: 'hand-status'; status: HandStatus; detail?: string };

export type Bridge = {
  send(message: Extract<ToEngine, { type: 'utterance' | 'interrupt' | 'user-speech' }> | ToMain): void;
  onMessage(handler: (message: ToRenderer) => void): void;
};
