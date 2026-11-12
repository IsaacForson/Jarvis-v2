import type { AssistantEvent } from '../assistant.ts';

/** Renderer to engine (relayed by the main process). */
export type ToEngine =
  | { type: 'utterance'; audio: Float32Array }
  /** `byVoice`: the user started talking over Jarvis, as opposed to pressing the stop key. */
  | { type: 'interrupt'; byVoice?: boolean }
  /** The microphone heard speech start (true) or decided it was only a noise (false). */
  | { type: 'user-speech'; active: boolean }
  /** Development check: the engine speaks a question to itself and answers it. */
  | { type: 'selftest'; question?: string; /** Spoken back when Jarvis asks a yes-or-no question. */ answer?: string }
  /** From the right-click menu: the way back in if the voice lock stops recognising its owner. */
  | { type: 'forget-voice' }
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
  | { type: 'stop' };

/** Renderer to main process only. */
export type ToMain =
  | { type: 'toggle-panels' }
  /** The orb's average frame rate while one reply was spoken. */
  | { type: 'frame-rate'; framesPerSecond: number };

export type Bridge = {
  send(message: Extract<ToEngine, { type: 'utterance' | 'interrupt' | 'user-speech' }> | ToMain): void;
  onMessage(handler: (message: ToRenderer) => void): void;
};
