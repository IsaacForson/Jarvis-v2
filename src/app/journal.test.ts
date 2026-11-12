import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Journal, record } from './journal.ts';
import type { ToRenderer } from './messages.ts';

const speech = { samples: new Float32Array(0), sampleRate: 24000 };
const run = (messages: ToRenderer[], friday = false) => {
  const journal: Journal = { transcript: [], activity: [] };
  messages.forEach((message, index) => record(journal, message, { friday, now: index }));
  return journal;
};

test('the transcript shows who said what, with a reply\'s sentences joined', () => {
  const { transcript } = run([
    { type: 'heard', turn: 1, text: 'What time is it?' },
    { type: 'speech', turn: 1, text: 'Nine.', speech },
    { type: 'speech', turn: 1, text: 'Time for coffee.', speech },
    { type: 'heard', turn: 2, text: 'Thanks.' },
    { type: 'speech', turn: 2, text: 'Any time.', speech },
  ]);
  assert.deepEqual(transcript.map((line) => `${line.who}: ${line.text}`), [
    'you: What time is it?',
    'jarvis: Nine. Time for coffee.',
    'you: Thanks.',
    'jarvis: Any time.',
  ]);
});

test('replies are labelled Friday while she is active', () => {
  assert.equal(run([{ type: 'speech', turn: 1, text: 'Here.', speech }], true).transcript[0]?.who, 'friday');
});

test('the activity log explains events in plain words and flags problems', () => {
  const { activity } = run([
    { type: 'ready' },
    { type: 'awake', awake: true, persona: 'friday' },
    { type: 'voice', result: 'stranger', score: 0.384 },
    { type: 'timing', turn: 1, transcriptMs: 250, firstWordsMs: 1150, firstAudioMs: 1800 },
    { type: 'error', turn: 1, message: 'Request timed out.' },
    { type: 'awake', awake: false, persona: 'friday' },
    { type: 'tool', turn: 2, status: 'asking', detail: 'Asking permission to move ~/a to the Trash ({"path":"~/a"})' },
    { type: 'tool', turn: 2, status: 'failed', detail: 'move to trash failed: no such file' },
    { type: 'thinking', turn: 2 },
  ]);
  assert.deepEqual(activity.map((entry) => `${entry.alert ? '!' : ' '} ${entry.text}`), [
    '  Ready',
    '  Friday woke up',
    '! Unrecognised voice ignored (match 0.38)',
    '  Replied in 1.8 s (heard 0.3 s, model 0.9 s)',
    '! Request timed out.',
    '  Went to sleep',
    '  Asking permission to move ~/a to the Trash ({"path":"~/a"})',
    '! move to trash failed: no such file',
  ]);
  assert.deepEqual(activity.map((entry) => entry.at), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('both lists keep only the most recent 200 lines', () => {
  const journal = run(Array.from({ length: 250 }, (_, turn): ToRenderer => ({ type: 'heard', turn, text: `line ${turn}` })));
  assert.equal(journal.transcript.length, 200);
  assert.equal(journal.transcript[0]?.text, 'line 50');
});
