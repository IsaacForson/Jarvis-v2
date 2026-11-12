/** A voiceprint: a list of numbers describing how a voice sounds, scaled to length 1. */
type Print = Float32Array;

export type VoiceCheck =
  /** No voice is enrolled, so anyone may speak. */
  | { result: 'open' }
  | { result: 'owner' | 'stranger'; score: number }
  /** Enrolment: this clip was kept and more are needed, or it was too short to use. */
  | { result: 'sample' | 'too-short' }
  /** Enrolment has just finished. */
  | { result: 'enrolled' };

export type VoiceLockOptions = {
  /** Turns 16 kHz audio into a raw voiceprint (any length). */
  embed(audio: Float32Array): Promise<Float32Array>;
  /** Where the enrolled voiceprint is kept between runs. */
  load(): number[] | undefined;
  save(print: number[] | undefined): void;
  /**
   * Similarity (0 to 1) at or above which a voice counts as the owner's.
   * shortcut: 0.82 is a starting guess, not tuned on real voices; every check logs its score so it can be.
   */
  threshold?: number;
  samplesNeeded?: number;
  minSampleSeconds?: number;
};

const unit = (vector: Float32Array): Print => {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
};

/** Decides whether a clip was spoken by the enrolled owner. With nobody enrolled it lets everyone through. */
export class VoiceLock {
  readonly #options: VoiceLockOptions;
  #print: Print | undefined;
  #samples: Print[] | undefined;

  constructor(options: VoiceLockOptions) {
    this.#options = options;
    const saved = options.load();
    this.#print = saved?.length ? unit(Float32Array.from(saved)) : undefined;
  }

  get enrolled(): boolean {
    return this.#print !== undefined;
  }

  /** The next few clips become the owner's voiceprint. */
  beginEnrolment(): void {
    this.#samples = [];
  }

  forget(): void {
    this.#print = this.#samples = undefined;
    this.#options.save(undefined);
  }

  async check(audio: Float32Array): Promise<VoiceCheck> {
    const { embed, save, threshold = 0.82, samplesNeeded = 3, minSampleSeconds = 2.5 } = this.#options;
    if (this.#samples) {
      if (audio.length < minSampleSeconds * 16_000) return { result: 'too-short' };
      this.#samples.push(unit(await embed(audio)));
      if (this.#samples.length < samplesNeeded) return { result: 'sample' };
      const samples = this.#samples;
      this.#samples = undefined;
      this.#print = unit(samples[0]!.map((_, index) => samples.reduce((sum, sample) => sum + sample[index]!, 0)));
      save([...this.#print]);
      return { result: 'enrolled' };
    }
    if (!this.#print) return { result: 'open' };
    const print = this.#print;
    const score = unit(await embed(audio)).reduce((sum, value, index) => sum + value * print[index]!, 0);
    return { result: score >= threshold ? 'owner' : 'stranger', score };
  }
}
