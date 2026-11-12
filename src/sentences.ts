// Sentence end = closing punctuation followed by a space, so "3.5" mid-stream is not split.
// shortcut: abbreviations such as "Mr. Smith" are split in two; add an abbreviation list if the voice pauses oddly.
const SENTENCE = /^(.*?[.!?]+["')\]]*)\s+/s;

/** Regroups streamed text pieces into whole sentences, so each can be spoken as soon as it is complete. */
export async function* sentences(pieces: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const piece of pieces) {
    buffer += piece;
    for (let match = SENTENCE.exec(buffer); match; match = SENTENCE.exec(buffer)) {
      buffer = buffer.slice(match[0].length);
      if (match[1]!.trim()) yield match[1]!.trim();
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

/** Whisper marks non-speech as "[BLANK_AUDIO]", "(music)" and the like; what is left is what was said. */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}
