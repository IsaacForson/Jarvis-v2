import type { ToRenderer } from './messages.ts';

export type Speaker = 'you' | 'jarvis' | 'friday';
export type Line = { who: Speaker; text: string; turn?: number };
export type Entry = { at: number; text: string; alert: boolean };
export type Journal = { transcript: Line[]; activity: Entry[] };

const KEEP = 200;
const ms = (value: number) => `${(value / 1000).toFixed(1)} s`;

/** What an event means for the activity log, in plain words; undefined if it is not worth a line. */
function describe(message: ToRenderer): { text: string; alert?: boolean } | undefined {
  switch (message.type) {
    case 'ready':
      return { text: 'Ready' };
    case 'awake':
      return { text: message.awake ? `${message.persona === 'friday' ? 'Friday' : 'Jarvis'} woke up` : 'Went to sleep' };
    case 'voice':
      if (message.result === 'owner') return { text: `Voice recognised (match ${message.score.toFixed(2)})` };
      if (message.result === 'stranger') return { text: `Unrecognised voice ignored (match ${message.score.toFixed(2)})`, alert: true };
      return { text: message.result === 'enrolled' ? 'Voice learned; answering only to it now' : message.result === 'sample' ? 'Voice sample kept' : 'Voice sample too short' };
    case 'timing':
      return { text: `Replied in ${ms(message.firstAudioMs)} (heard ${ms(message.transcriptMs)}, model ${ms(message.firstWordsMs - message.transcriptMs)})` };
    case 'tool':
      return { text: message.detail, alert: message.status === 'failed' };
    case 'error':
    case 'fatal':
      return { text: message.message, alert: true };
    case 'stop':
      return { text: 'Stopped by the stop key' };
    default:
      return undefined;
  }
}

/** Adds one event to the transcript and the activity log. Sentences of one reply are joined into one line. */
export function record(journal: Journal, message: ToRenderer, context: { friday: boolean; now: number }): void {
  if (message.type === 'heard') journal.transcript.push({ who: 'you', text: message.text });
  if (message.type === 'speech') {
    const who = context.friday ? 'friday' : 'jarvis';
    const last = journal.transcript.at(-1);
    if (last && last.who === who && last.turn === message.turn) last.text += ` ${message.text}`;
    else journal.transcript.push({ who, text: message.text, turn: message.turn });
  }
  const activity = describe(message);
  if (activity) journal.activity.push({ at: context.now, text: activity.text, alert: activity.alert ?? false });
  journal.transcript.splice(0, journal.transcript.length - KEEP);
  journal.activity.splice(0, journal.activity.length - KEEP);
}
