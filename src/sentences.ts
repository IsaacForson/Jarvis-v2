// Sentence end = closing punctuation followed by a space (so "3.5" mid-stream is not split), or a line
// break (so each list item is its own sentence). The full stop of a list number ("1. Eggs") does not count.
// shortcut: abbreviations such as "Mr. Smith" are split in two; add an abbreviation list if the voice pauses oddly.
const SENTENCE = /^(.*?(?:(?<!(?:^|\n)[ \t]*\d+)[.!?]+["')\]]*\s+|\n+))/s;

/** Removes what must not be read aloud: list markers, markdown symbols, link addresses. */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](address) -> label
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?=\S)/gm, '') // "- item", "1. item"
    .replace(/[*_`#~|<>]+/g, '')
    .replace(/\s+[-–—]+\s+/g, ', ') // a dash between words is a pause
    .replace(/\s+/g, ' ')
    .trim();
}

/** Regroups streamed text pieces into whole, speakable sentences, so each can be spoken as soon as it is complete. */
export async function* sentences(pieces: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const piece of pieces) {
    buffer += piece;
    for (let match = SENTENCE.exec(buffer); match; match = SENTENCE.exec(buffer)) {
      buffer = buffer.slice(match[0].length);
      const sentence = speakable(match[1]!);
      if (/[\p{L}\p{N}]/u.test(sentence)) yield sentence;
    }
  }
  const rest = speakable(buffer);
  if (/[\p{L}\p{N}]/u.test(rest)) yield rest;
}

/** Whisper marks non-speech as "[BLANK_AUDIO]", "(music)" and the like; what is left is what was said. */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}
