import type { ChatRequest } from './chat.ts';
import { cleanTranscript, sentences } from './sentences.ts';
import { isSleepCommand, parseWake } from './wake.ts';

export type Speech = { samples: Float32Array; sampleRate: number };

export type AssistantEvent =
  /** Jarvis woke up or went to sleep. Asleep, it ignores everything but its name. */
  | { type: 'awake'; awake: boolean }
  | { type: 'thinking'; turn: number }
  | { type: 'heard'; turn: number; text: string }
  | { type: 'speech'; turn: number; text: string; speech: Speech }
  | { type: 'error'; turn: number; message: string }
  /** Always the last event of a turn, including an interrupted or failed one. */
  | { type: 'done'; turn: number };

export type AssistantDeps = {
  /** Turns 16 kHz microphone audio into text. */
  transcribe(audio: Float32Array): Promise<string>;
  chat(request: ChatRequest): AsyncIterable<string>;
  speak(text: string): Promise<Speech>;
  emit(event: AssistantEvent): void;
  model: Pick<ChatRequest, 'model' | 'extraBody'>;
  persona: string;
  /** Skip the wake word at the start; Jarvis normally starts asleep. */
  startAwake?: boolean;
};

type Message = { role: 'user' | 'assistant'; content: string };
const MAX_HISTORY = 20;

const APOLOGY = 'Sorry, sir, I could not reach my brain just now. Please try again.';

/** Runs one spoken exchange at a time: hear, think, speak sentence by sentence. A new one cancels the old. */
export class Assistant {
  readonly #deps: AssistantDeps;
  #history: Message[] = [];
  #turn = 0;
  #abort = new AbortController();
  #awake: boolean;

  constructor(deps: AssistantDeps) {
    this.#deps = deps;
    this.#awake = deps.startAwake ?? false;
  }

  /** Stops the current exchange. What was already spoken stays in the conversation. */
  interrupt(): void {
    this.#abort.abort();
  }

  async hear(audio: Float32Array): Promise<void> {
    this.interrupt();
    const abort = (this.#abort = new AbortController());
    const turn = ++this.#turn;
    const { transcribe, chat, speak, emit, model, persona } = this.#deps;
    const live = () => !abort.signal.aborted;
    let spoken = '';
    let question: Message | undefined;

    // Speaks one sentence; false means the turn was interrupted meanwhile.
    const say = async (sentence: string) => {
      const speech = await speak(sentence);
      if (live()) emit({ type: 'speech', turn, text: sentence, speech });
      return live();
    };
    const setAwake = (awake: boolean) => {
      this.#awake = awake;
      emit({ type: 'awake', awake });
    };

    try {
      const text = cleanTranscript(await transcribe(audio));
      if (!live() || !text) return;
      const wake = this.#awake ? undefined : parseWake(text);
      if (wake && !wake.woke) return; // asleep and not addressed: none of our business
      emit({ type: 'thinking', turn });
      emit({ type: 'heard', turn, text });

      if (wake) {
        setAwake(true);
        if (!wake.rest) return void (await say('Yes, sir?'));
      } else if (isSleepCommand(text)) {
        setAwake(false);
        return void (await say('Going quiet, sir.'));
      }

      question = { role: 'user', content: wake?.rest || text };
      const stream = chat({
        ...model,
        maxTokens: 300,
        signal: abort.signal,
        messages: [{ role: 'system', content: persona }, ...this.#history, question],
      });
      for await (const sentence of sentences(stream)) {
        if (!live() || !(await say(sentence))) break;
        spoken += (spoken ? ' ' : '') + sentence;
      }
    } catch (error) {
      // An interrupt surfaces as an abort error from the model call; that is not a failure.
      if (live()) {
        emit({ type: 'error', turn, message: error instanceof Error ? error.message : String(error) });
        await say(APOLOGY).catch(() => {}); // a voice assistant must not fail silently
      }
    } finally {
      // Record an exchange only once something was said, and only what was said. Writing both halves
      // together here keeps turns alternating even when a newer turn is already running.
      if (question && spoken) {
        this.#history = [...this.#history, question, { role: 'assistant' as const, content: spoken }].slice(-MAX_HISTORY);
      }
      emit({ type: 'done', turn });
    }
  }
}
