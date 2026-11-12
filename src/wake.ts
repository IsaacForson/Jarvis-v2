// Wake and sleep phrases are spotted in whisper's transcript, which never leaves this Mac.
// shortcut: this transcribes every utterance while asleep, and wakes only when "Jarvis" starts the
// utterance; move to openWakeWord (see the spec) if that costs too much power or misses too often.

// "Javis" and "Jervis" are how whisper sometimes spells the name.
const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|yo)[\s,]+)?j[ae]r?vis\b[\s,.!?]*/i;
const SLEEP = /\b(?:go to sleep|go back to sleep|sleep mode|stop listening|go quiet|good ?night|goodbye|that(?:'s| is| will be) all)\b/i;

/** Was Jarvis addressed by name at the start, and what was said after the name? */
export function parseWake(text: string): { woke: boolean; rest: string } {
  const match = WAKE.exec(text);
  return match ? { woke: true, rest: text.slice(match[0].length).trim() } : { woke: false, rest: '' };
}

/** A short dismissal such as "Go to sleep, Jarvis". Longer sentences that merely mention sleep do not count. */
export function isSleepCommand(text: string): boolean {
  return text.trim().split(/\s+/).length <= 6 && SLEEP.test(text);
}
