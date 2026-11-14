import type { PersonaName } from './persona.ts';

// Wake and sleep phrases are spotted in whisper's transcript, which never leaves this Mac.
// shortcut: this transcribes every utterance while asleep, and wakes only when the name starts the
// utterance; move to openWakeWord (see the spec) if that costs too much power or misses too often.

// "Javis" and "Jervis" are how whisper sometimes spells the name.
// A few filler words may come first ("um, okay, Jarvis"); people rarely start dead on the name.
const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|yo|um+|uh+|erm|so|and|well|oh|right|please)[\s,.!]+){0,3}(j[ae]r?vis|friday)\b[\s,.!?]*/i;
// Or the name last, set off by a comma: "What time is it, Jarvis?"
const WAKE_LAST = /,\s*(j[ae]r?vis|friday)\W*$/i;
// Or the name starting a sentence later on, after other talk in the room was heard with it:
// "...his melodies are phenomenal. Um, okay. Jarvis, what time is it?" The name must begin the
// sentence and be followed by a pause, so "I told him about Jarvis yesterday" does not count.
const WAKE_LATER = /[.!?]\s+(?:(?:hey|hi|hello|ok|okay|yo|um+|uh+|erm|so|and|well|oh|right|please)[\s,.!]+){0,3}(j[ae]r?vis|friday)\s*[,.!?]\s*/gi;
const SLEEP = /\b(?:go to sleep|go back to sleep|sleep mode|stop listening|go quiet|good ?night|goodbye|that(?:'s| is| will be) all)\b/i;
// "I want to talk to Friday", "switch to Jarvis", "get Friday", "Friday, take over".
const NAME = '(j[ae]r?vis|friday)';
const HANDOVER = new RegExp(
  `\\b(?:talk|speak|switch|change|over|back)\\s+(?:to|with)\\s+${NAME}\\b|\\b(?:get|call|bring|give|put)\\s+(?:me\\s+)?(?:back\\s+)?${NAME}\\b|\\b${NAME}\\b[,.]?\\s+(?:please\\s+)?(?:take over|come (?:back|in|on))`,
  'i',
);
const LEARN_VOICE = /\b(?:learn|remember|recogni[sz]e|memori[sz]e)\b.*\bmy voice\b/i;
const FORGET_VOICE = /\bforget\b.*\bmy voice\b/i;

/** Was an assistant addressed by name at the start, which one, and what was said after the name? */
export function parseWake(text: string): { name?: PersonaName; rest: string } {
  const match = WAKE.exec(text);
  if (match) return { name: /^f/i.test(match[1]!) ? 'friday' : 'jarvis', rest: text.slice(match[0].length).trim() };
  const later = [...text.matchAll(WAKE_LATER)].at(-1);
  if (later) return { name: /^f/i.test(later[1]!) ? 'friday' : 'jarvis', rest: text.slice(later.index + later[0].length).trim() };
  const last = WAKE_LAST.exec(text);
  // The sentence keeps its own ending ("?" for a question), so it still reads as finished.
  if (last) return { name: /^f/i.test(last[1]!) ? 'friday' : 'jarvis', rest: `${text.slice(0, last.index).trim()}${/[?!]/.exec(text.slice(last.index))?.[0] ?? '.'}` };
  return { rest: text };
}

const short = (text: string) => text.trim().split(/\s+/).length <= 8;

/** A short request to be passed to the other assistant, and which one. */
export function parseHandover(text: string): PersonaName | undefined {
  const match = short(text) ? HANDOVER.exec(text) : null;
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  return name ? (/^f/i.test(name) ? 'friday' : 'jarvis') : undefined;
}

/** A short dismissal such as "Go to sleep". Longer sentences that merely mention sleep do not count. */
export const isSleepCommand = (text: string) => text.trim().split(/\s+/).length <= 6 && SLEEP.test(text);
/** "Learn my voice": start answering only to the person speaking. */
export const isLearnVoiceCommand = (text: string) => short(text) && LEARN_VOICE.test(text);
/** "Forget my voice": answer to anyone again. */
export const isForgetVoiceCommand = (text: string) => short(text) && FORGET_VOICE.test(text);

/** "Start dictation", "type what I say": what he says next is typed, not answered. */
export const isStartDictation = (text: string) => short(text) && /^\W*(?:please\s+)?(?:(?:start|begin|take)\s+(?:a\s+)?dictation\b|dictation(?:\s+(?:mode|on))?\W*$|type\s+(?:this|what i say|for me|as i (?:speak|talk))\b)/i.test(text);
export const isStopDictation = (text: string) => short(text) && /\b(?:(?:stop|end|finish)\s+(?:the\s+)?(?:dictation|typing)|dictation\s+off)\b/i.test(text);
/** "Take notes of this meeting": what is said next, by anyone, is written down, not answered. */
export const isStartMeeting = (text: string) => short(text) && /\b(?:take|start taking|make|keep)\s+(?:the\s+)?(?:meeting\s+)?(?:notes|minutes)\b|\b(?:start|begin)\s+(?:the|a|my)\s+meeting\b/i.test(text);
export const isEndMeeting = (text: string) => short(text) && /\b(?:end|stop|finish|close)\s+(?:the\s+|this\s+)?(?:meeting|call|notes|minutes|note[- ]taking)\b|\bstop taking (?:notes|minutes)\b|\bmeeting(?:'s| is) over\b/i.test(text);

const NO = /\b(?:no|nope|don't|do not|cancel|stop|never ?mind|negative|leave it|not now)\b/i;
const YES = /\b(?:yes|yeah|yep|yup|sure|go ahead|do it|please do|go on|confirm(?:ed)?|okay|ok|proceed|approved?|absolutely|of course)\b/i;

/** The answer to a yes-or-no question: true, false, or undefined when it is neither. "No" wins if both are heard. */
export function parseYesNo(text: string): boolean | undefined {
  return NO.test(text) ? false : YES.test(text) ? true : undefined;
}
