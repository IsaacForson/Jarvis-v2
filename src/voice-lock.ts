/** A voiceprint: a list of numbers describing how a voice sounds, scaled to length 1. */
type Print = Float32Array;

export type VoiceCheck =
  /** No voice is enrolled, so anyone may speak. */
  | { result: 'open' }
  | { result: 'owner' | 'stranger'; score: number }
  /** Enrolment: this clip was kept and more are needed, or it was too short to use. */
  | { result: 'sample' | 'too-short' }
  /** Enrolment has just finished; `threshold` is the pass mark worked out from the owner's own clips. */
  | { result: 'enrolled'; threshold: number };

/** What is kept between runs: the voiceprint and the pass mark that goes with it. */
export type SavedVoice = { print: number[]; threshold?: number };

export type VoiceLockOptions = {
  /** Turns 16 kHz audio into a raw voiceprint (any length). */
  embed(audio: Float32Array): Promise<Float32Array>;
  /** Where the enrolled voiceprint is kept between runs. */
  load(): SavedVoice | undefined;
  save(voice: SavedVoice | undefined): void;
  /**
   * Similarity (0 to 1) at or above which a voice counts as the owner's, for a voiceprint saved without
   * its own pass mark. Enrolment works one out from the owner's clips (see `calibrate`).
   */
  threshold?: number;
  samplesNeeded?: number;
  minSampleSeconds?: number;
};

const unit = (vector: Float32Array): Print => {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
};

const dot = (a: Print, b: Print) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
const mean = (samples: Print[]): Print => unit(samples[0]!.map((_, index) => samples.reduce((sum, sample) => sum + sample[index]!, 0)));

/**
 * The pass mark for one owner: each enrolment clip is scored against a voiceprint made from the other
 * clips, as a later check would be, and the mark is set a little under the lowest score.
 * shortcut: fitted to the owner's voice only, kept between 0.70 and 0.88; nobody else's voice has been
 * measured against it, so lower the ceiling or raise the floor if the log shows strangers passing.
 */
export function calibrate(samples: Print[]): number {
  const scores = samples.map((sample, index) => dot(sample, mean(samples.filter((_, other) => other !== index))));
  return Math.round(Math.min(0.88, Math.max(0.7, Math.min(...scores) - 0.05)) * 100) / 100;
}

/** Decides whether a clip was spoken by the enrolled owner. With nobody enrolled it lets everyone through. */
export class VoiceLock {
  readonly #options: VoiceLockOptions;
  #print: Print | undefined;
  #threshold: number;
  #samples: Print[] | undefined;

  constructor(options: VoiceLockOptions) {
    this.#options = options;
    const saved = options.load();
    this.#print = saved?.print.length ? unit(Float32Array.from(saved.print)) : undefined;
    this.#threshold = saved?.threshold ?? options.threshold ?? 0.82;
  }

  get enrolled(): boolean {
    return this.#print !== undefined;
  }

  /** The next few clips become the owner's voiceprint. */
  /** Learning a voice: the next clips handed to `check` become the voiceprint. */
  get enrolling(): boolean {
    return this.#samples !== undefined;
  }

  beginEnrolment(): void {
    this.#samples = [];
  }

  forget(): void {
    this.#print = this.#samples = undefined;
    this.#options.save(undefined);
  }

  async check(audio: Float32Array): Promise<VoiceCheck> {
    const { embed, save, samplesNeeded = 3, minSampleSeconds = 2.5 } = this.#options;
    if (this.#samples) {
      if (audio.length < minSampleSeconds * 16_000) return { result: 'too-short' };
      this.#samples.push(unit(await embed(audio)));
      if (this.#samples.length < samplesNeeded) return { result: 'sample' };
      const samples = this.#samples;
      this.#samples = undefined;
      this.#print = mean(samples);
      this.#threshold = samples.length > 1 ? calibrate(samples) : this.#threshold;
      save({ print: [...this.#print], threshold: this.#threshold });
      return { result: 'enrolled', threshold: this.#threshold };
    }
    if (!this.#print) return { result: 'open' };
    const print = this.#print;
    const score = dot(unit(await embed(audio)), print);
    return { result: score >= this.#threshold ? 'owner' : 'stranger', score };
  }
}
