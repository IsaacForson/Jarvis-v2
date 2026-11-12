import type { ChatRequest } from './chat.ts';
import { cleanTranscript, sentences } from './sentences.ts';
import type { Persona, PersonaName } from './persona.ts';
import type { VoiceCheck, VoiceLock } from './voice-lock.ts';
import { isForgetVoiceCommand, isLearnVoiceCommand, isSleepCommand, parseHandover, parseWake } from './wake.ts';

export type Speech = { samples: Float32Array; sampleRate: number };

export type AssistantEvent =
  /** Jarvis woke up or went to sleep. Asleep, it ignores everything but its name. */
  | { type: 'awake'; awake: boolean; persona: PersonaName }
  /** A voice-lock decision, for the log and the window. */
  | ({ type: 'voice' } & Exclude<VoiceCheck, { result: 'open' }>)
  | { type: 'thinking'; turn: number }
  /** Delays for one answered turn, each counted from the moment the utterance arrived. */
  | { type: 'timing'; turn: number; transcriptMs: number; firstWordsMs: number; firstAudioMs: number }
  | { type: 'heard'; turn: number; text: string }
  | { type: 'speech'; turn: number; text: string; speech: Speech }
  | { type: 'error'; turn: number; message: string }
  /** Always the last event of a turn, including an interrupted or failed one. */
  | { type: 'done'; turn: number };

export type AssistantDeps = {
  /** Turns 16 kHz microphone audio into text. */
  transcribe(audio: Float32Array): Promise<string>;
  chat(request: ChatRequest): AsyncIterable<string>;
  speak(text: string, voice: string): Promise<Speech>;
  emit(event: AssistantEvent): void;
  model: Pick<ChatRequest, 'model' | 'extraBody' | 'fallbacks' | 'timeoutMs'>;
  personas: Record<PersonaName, Persona>;
  /** When given and enrolled, only the owner's voice is answered. */
  voiceLock?: Pick<VoiceLock, 'check' | 'beginEnrolment' | 'forget'>;
  /** Skip the wake word at the start; Jarvis normally starts asleep. */
  startAwake?: boolean;
  /** How long to wait for the rest of a sentence that trailed off. */
  holdMs?: number;
  /** Silence after which Jarvis goes back to sleep on its own. */
  idleSleepMs?: number;
};

type Message = { role: 'user' | 'assistant'; content: string };
type Turn = { id: number; abort: AbortController; startedAt: number; transcriptMs: number };
const MAX_HISTORY = 20;
const APOLOGY = 'Sorry, sir, I could not reach my brain just now. Please try again.';
// Whisper ends a finished sentence with a full stop, question mark or exclamation mark, and a trailing-off one with "...".
const FINISHED = /[.!?]["')]*$/;
const TRAILING_OFF = /(\.\.\.|…)["')]*$/;

/** Runs one spoken exchange at a time: hear, think, speak sentence by sentence. A new one cancels the old. */
export class Assistant {
  readonly #deps: AssistantDeps;
  #history: Message[] = [];
  #turns = 0;
  #abort = new AbortController();
  #awake: boolean;
  #persona: PersonaName = 'jarvis';
  /** The question being answered now, and whether any of the answer has been spoken yet. */
  #answering: { question: string; spoken: boolean } | undefined;
  /** Words heard but not yet answered: a sentence that trailed off, or a question the user talked over. */
  #carry = '';
  #holdTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: AssistantDeps) {
    this.#deps = deps;
    this.#awake = deps.startAwake ?? false;
  }

  /**
   * Stops the current exchange. What was already spoken stays in the conversation.
   * `byVoice`: the user started talking over Jarvis. If no answer had been spoken yet they were
   * probably still finishing their sentence, so the question is kept and joined to what comes next.
   */
  interrupt(byVoice = false): void {
    clearTimeout(this.#holdTimer);
    this.#carry = byVoice && this.#answering && !this.#answering.spoken ? this.#answering.question : byVoice ? this.#carry : '';
    this.#cancel();
  }

  /** The microphone heard speech start (true) or decided it was only a noise (false). */
  userSpeaking(active: boolean): void {
    clearTimeout(this.#holdTimer);
    if (!active) this.#armHold();
  }

  async hear(audio: Float32Array): Promise<void> {
    clearTimeout(this.#holdTimer);
    this.#cancel();
    const turn = this.#begin();
    const { transcribe, emit, voiceLock } = this.#deps;
    await this.#run(turn, async () => {
      const [raw, voice] = await Promise.all([transcribe(audio), voiceLock?.check(audio)]);
      let text = cleanTranscript(raw);
      turn.transcriptMs = performance.now() - turn.startedAt;
      if (turn.abort.signal.aborted) return;
      if (voice && voice.result !== 'open') emit({ type: 'voice', ...voice });
      if (!text || voice?.result === 'stranger') return this.#armHold(); // noise, or not the owner's voice

      // Enrolment clips are voice samples, not questions.
      if (voice?.result === 'too-short') return void (await this.#say(turn, 'A little longer, please, sir. A full sentence.'));
      if (voice?.result === 'sample') return void (await this.#say(turn, 'Good. Another sentence, please.'));
      if (voice?.result === 'enrolled') return void (await this.#say(turn, 'Thank you, sir. From now on we answer only to your voice.'));

      const wake = parseWake(text);
      if (!this.#awake && !wake.name) return this.#armHold(); // asleep and not addressed
      emit({ type: 'heard', turn: turn.id, text });

      if (wake.name) {
        // Saying a name wakes that assistant, or hands the conversation over to it.
        if (!this.#awake || wake.name !== this.#persona) this.#setAwake(true, wake.name);
        text = wake.rest;
        if (!text) return void (await this.#say(turn, 'Yes, sir?'));
      }
      const handover = parseHandover(text);
      if (handover) {
        if (handover !== this.#persona) this.#setAwake(true, handover);
        return void (await this.#say(turn, handover === 'friday' ? 'Friday here, sir.' : 'Jarvis here, sir.'));
      }
      if (isSleepCommand(text)) {
        this.#carry = '';
        this.#setAwake(false);
        return void (await this.#say(turn, 'Going quiet, sir.'));
      }
      if (voiceLock && isForgetVoiceCommand(text)) {
        voiceLock.forget();
        return void (await this.#say(turn, 'Done, sir. We will answer to anyone again.'));
      }
      if (voiceLock && isLearnVoiceCommand(text)) {
        voiceLock.beginEnrolment();
        return void (await this.#say(turn, 'Of course, sir. Say three full sentences, one at a time, and I will learn your voice.'));
      }

      const full = [this.#carry, text].filter(Boolean).join(' ');
      this.#carry = '';
      if (TRAILING_OFF.test(full) || !FINISHED.test(full)) {
        // Probably a pause mid-sentence: wait for the rest instead of answering half a question.
        this.#carry = full;
        return this.#armHold();
      }
      await this.#answer(turn, full);
    });
  }

  #begin(): Turn {
    this.#abort = new AbortController();
    return { id: ++this.#turns, abort: this.#abort, startedAt: performance.now(), transcriptMs: 0 };
  }

  #cancel(): void {
    this.#answering = undefined;
    this.#abort.abort();
  }

  /** Runs a turn's work; reports failures out loud, and always ends the turn with `done`. */
  async #run(turn: Turn, work: () => Promise<void>): Promise<void> {
    const { emit } = this.#deps;
    try {
      await work();
    } catch (error) {
      // An interrupt surfaces as an abort error from the model call; that is not a failure.
      if (!turn.abort.signal.aborted) {
        emit({ type: 'error', turn: turn.id, message: error instanceof Error ? error.message : String(error) });
        await this.#say(turn, APOLOGY).catch(() => {}); // a voice assistant must not fail silently
      }
    } finally {
      emit({ type: 'done', turn: turn.id });
      this.#armIdle();
    }
  }

  /** Speaks one sentence; false means the turn was interrupted meanwhile. */
  async #say(turn: Turn, sentence: string): Promise<boolean> {
    const speech = await this.#deps.speak(sentence, this.#deps.personas[this.#persona].voice);
    const live = !turn.abort.signal.aborted;
    if (live) this.#deps.emit({ type: 'speech', turn: turn.id, text: sentence, speech });
    return live;
  }

  async #answer(turn: Turn, text: string): Promise<void> {
    const { chat, emit, model, personas } = this.#deps;
    const elapsed = () => performance.now() - turn.startedAt;
    const answering = { question: text, spoken: false };
    this.#answering = answering;
    const question: Message = { role: 'user', content: text };
    let spoken = '';
    let firstWordsMs = 0;
    emit({ type: 'thinking', turn: turn.id });

    const stream = chat({
      ...model,
      maxTokens: 300,
      signal: turn.abort.signal,
      messages: [{ role: 'system', content: personas[this.#persona].prompt }, ...this.#history, question],
    });
    const timed = (async function* () {
      for await (const piece of stream) {
        firstWordsMs ||= elapsed();
        yield piece;
      }
    })();

    try {
      for await (const sentence of sentences(timed)) {
        if (turn.abort.signal.aborted || !(await this.#say(turn, sentence))) break;
        if (!spoken) emit({ type: 'timing', turn: turn.id, transcriptMs: turn.transcriptMs, firstWordsMs, firstAudioMs: elapsed() });
        spoken += (spoken ? ' ' : '') + sentence;
        answering.spoken = true;
      }
    } finally {
      if (this.#answering === answering) this.#answering = undefined;
      // Record an exchange only once something was said, and only what was said. Writing both halves
      // together here keeps turns alternating even when a newer turn is already running.
      if (spoken) this.#history = [...this.#history, question, { role: 'assistant' as const, content: spoken }].slice(-MAX_HISTORY);
    }
  }

  #setAwake(awake: boolean, persona: PersonaName = this.#persona): void {
    this.#awake = awake;
    this.#persona = persona;
    this.#deps.emit({ type: 'awake', awake, persona });
  }

  /** If words are waiting, answer them once the user has stayed quiet for the hold time. */
  #armHold(): void {
    clearTimeout(this.#holdTimer);
    if (!this.#carry) return;
    this.#holdTimer = setTimeout(() => {
      const text = this.#carry;
      this.#carry = '';
      const turn = this.#begin();
      void this.#run(turn, () => this.#answer(turn, text));
    }, this.#deps.holdMs ?? 2000);
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer);
    if (!this.#awake) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#answering || this.#carry) return this.#armIdle();
      this.#setAwake(false);
    }, this.#deps.idleSleepMs ?? 120_000);
    this.#idleTimer.unref?.();
  }
}
