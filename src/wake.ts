import type { PersonaName } from './persona.ts';

// Wake and sleep phrases are spotted in whisper's transcript, which never leaves this Mac.
// shortcut: this transcribes every utterance while asleep, and wakes only when the name starts the
// utterance; move to openWakeWord (see the spec) if that costs too much power or misses too often.

// "Javis" and "Jervis" are how whisper sometimes spells the name.
const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?(j[ae]r?vis|friday)\b[\s,.!?]*/i;
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
  if (!match) return { rest: text };
  return { name: /^f/i.test(match[1]!) ? 'friday' : 'jarvis', rest: text.slice(match[0].length).trim() };
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
