export type TurnTiming = {
  /** Until the first piece of reply text arrived. */
  firstTextMs: number;
  /** Until a whole sentence was available, which is what the voice needs to start speaking. */
  firstSentenceMs: number;
  totalMs: number;
  text: string;
};

// Needs the space after the full stop: mid-stream, "3." may be the start of "3.5".
const SENTENCE_END = /[.!?]\s/;

/** Times one streamed reply. Throws if the model sent no text at all. */
export async function measureTurn(
  stream: AsyncIterable<string>,
  now: () => number = performance.now.bind(performance),
): Promise<TurnTiming> {
  const start = now();
  let text = '';
  let firstTextMs: number | undefined;
  let firstSentenceMs: number | undefined;

  for await (const piece of stream) {
    text += piece;
    firstTextMs ??= now() - start;
    if (firstSentenceMs === undefined && SENTENCE_END.test(text)) firstSentenceMs = now() - start;
  }

  const totalMs = now() - start;
  if (firstTextMs === undefined) throw new Error('The model returned no text');
  // A reply with no sentence ending is only speakable once it is complete.
  return { firstTextMs, firstSentenceMs: firstSentenceMs ?? totalMs, totalMs, text };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median of no values');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
