import type { AssistantEvent } from '../assistant.ts';

/** Renderer to engine (relayed by the main process). */
export type ToEngine =
  | { type: 'utterance'; audio: Float32Array }
  | { type: 'interrupt' }
  /** Development check: the engine speaks a question to itself and answers it. */
  | { type: 'selftest' }
  | { type: 'shutdown' };

/** Engine or main process to renderer. */
export type ToRenderer =
  | AssistantEvent
  /** For the main process only: a helper process it must kill on quit, since the engine may be too busy to. */
  | { type: 'helper'; pid: number }
  | { type: 'ready' }
  | { type: 'fatal'; message: string }
  | { type: 'toggle-mic' }
  | { type: 'stop' };

export type Bridge = {
  send(message: Extract<ToEngine, { type: 'utterance' | 'interrupt' }>): void;
  onMessage(handler: (message: ToRenderer) => void): void;
};
