import type { PersonaName } from './persona.ts';

// Wake and sleep phrases are spotted in whisper's transcript, which never leaves this Mac.
// shortcut: this transcribes every utterance while asleep, and wakes only when the name starts the
// utterance; move to openWakeWord (see the spec) if that costs too much power or misses too often.

// "Javis" and "Jervis" are how whisper sometimes spells the name.
const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?(j[ae]r?vis|friday)\b[\s,.!?]*/i;
const SLEEP = /\b(?:go to sleep|go back to sleep|sleep mode|stop listening|go quiet|good ?night|goodbye|that(?:'s| is| will be) all)\b/i;
const LEARN_VOICE = /\b(?:learn|remember|recogni[sz]e|memori[sz]e)\b.*\bmy voice\b/i;
const FORGET_VOICE = /\bforget\b.*\bmy voice\b/i;

/** Was an assistant addressed by name at the start, which one, and what was said after the name? */
export function parseWake(text: string): { name?: PersonaName; rest: string } {
  const match = WAKE.exec(text);
  if (!match) return { rest: text };
  return { name: /^f/i.test(match[1]!) ? 'friday' : 'jarvis', rest: text.slice(match[0].length).trim() };
}

const short = (text: string) => text.trim().split(/\s+/).length <= 8;

/** A short dismissal such as "Go to sleep". Longer sentences that merely mention sleep do not count. */
export const isSleepCommand = (text: string) => text.trim().split(/\s+/).length <= 6 && SLEEP.test(text);
/** "Learn my voice": start answering only to the person speaking. */
export const isLearnVoiceCommand = (text: string) => short(text) && LEARN_VOICE.test(text);
/** "Forget my voice": answer to anyone again. */
export const isForgetVoiceCommand = (text: string) => short(text) && FORGET_VOICE.test(text);
