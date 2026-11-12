import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant, type AssistantEvent } from './assistant.ts';
import type { ChatRequest } from './chat.ts';

const audio = new Float32Array(1);

// An assistant wired to fakes; `replies` are the model's answers in order, each as stream pieces.
const setup = (replies: string[][], overrides: { heard?: string[]; asleep?: boolean; onSpeak?: (text: string) => void | Promise<void> } = {}) => {
  const events: AssistantEvent[] = [];
  const requests: ChatRequest[] = [];
  const heard = [...(overrides.heard ?? [])];
  const assistant = new Assistant({
    transcribe: async () => heard.shift() ?? 'What time is it?',
    chat: (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const pieces = replies.shift();
      return (async function* () {
        if (!pieces) throw new Error('model offline');
        for (const piece of pieces) {
          if (request.signal?.aborted) throw new Error('aborted');
          yield piece;
        }
      })();
    },
    speak: async (text) => {
      await overrides.onSpeak?.(text);
      return { samples: new Float32Array(2), sampleRate: 24000 };
    },
    emit: (event) => events.push(event),
    model: { model: 'fast' },
    persona: 'Be Jarvis.',
    startAwake: !overrides.asleep,
  });
  const summary = () =>
    events.map((e) => (e.type === 'heard' || e.type === 'speech' ? `${e.type}:${e.text}` : e.type === 'error' ? `error:${e.message}` : e.type === 'awake' ? `awake:${e.awake}` : e.type));
  return { assistant, events, requests, summary };
};

test('a turn is heard, answered sentence by sentence, then done', async () => {
  const { assistant, summary, requests } = setup([['It is ', 'nine. Time ', 'for coffee.']]);
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['thinking', 'heard:What time is it?', 'speech:It is nine.', 'speech:Time for coffee.', 'done']);
  assert.deepEqual(requests[0]?.messages, [
    { role: 'system', content: 'Be Jarvis.' },
    { role: 'user', content: 'What time is it?' },
  ]);
});

test('the next turn carries the conversation so far', async () => {
  const { assistant, requests } = setup([['Nine.'], ['Yes.']], { heard: ['What time is it?', 'Are you sure?'] });
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(requests[1]?.messages.slice(1), [
    { role: 'user', content: 'What time is it?' },
    { role: 'assistant', content: 'Nine.' },
    { role: 'user', content: 'Are you sure?' },
  ]);
});

test('silence or noise is ignored without calling the model', async () => {
  const { assistant, summary, requests } = setup([['unused']], { heard: [' [BLANK_AUDIO] '] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['done']);
  assert.equal(requests.length, 0);
});

test('an interrupt stops the reply and keeps only what was spoken', async () => {
  const { assistant, summary, requests } = setup([['One. Two. Three. '], ['Ok.']], {
    onSpeak: (text) => {
      if (text === 'Two.') assistant.interrupt();
    },
  });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['thinking', 'heard:What time is it?', 'speech:One.', 'done']);
  await assistant.hear(audio);
  assert.deepEqual(requests[1]?.messages[2], { role: 'assistant', content: 'One.' });
});

test('speaking again while a reply is in progress cancels it', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { assistant, events, requests } = setup([['Slow answer. More.'], ['Fast answer.']], {
    onSpeak: (text) => (text === 'Slow answer.' ? gate : undefined),
  });
  const first = assistant.hear(audio);
  await new Promise((resolve) => setImmediate(resolve));
  const second = assistant.hear(audio);
  release();
  await Promise.all([first, second]);
  const spoken = events.flatMap((e) => (e.type === 'speech' ? [`${e.turn}:${e.text}`] : []));
  assert.deepEqual(spoken, ['2:Fast answer.']);
  assert.deepEqual(events.filter((e) => e.type === 'done').map((e) => e.turn).sort(), [1, 2]);
  assert.deepEqual(requests[1]?.messages.map((m) => m.role), ['system', 'user'], 'the cancelled question is not sent twice');
});

test('a model failure is reported and the unanswered question is forgotten', async () => {
  const { assistant, summary, requests } = setup([]);
  await assistant.hear(audio);
  assert.equal(summary().join('|'), 'thinking|heard:What time is it?|error:model offline|speech:Sorry, sir, I could not reach my brain just now. Please try again.|done');
  await assistant.hear(audio).catch(() => {});
  assert.equal(requests[1]?.messages.length, 2, 'system prompt plus the new question only');
});

test('asleep, Jarvis ignores speech until addressed by name, then answers what followed', async () => {
  const { assistant, summary, requests } = setup([['Nine.']], { asleep: true, heard: ['What time is it?', 'Hey Jarvis, what time is it?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['done']);
  await assistant.hear(audio);
  assert.deepEqual(summary().slice(1), ['thinking', 'heard:Hey Jarvis, what time is it?', 'awake:true', 'speech:Nine.', 'done']);
  assert.deepEqual(requests[0]?.messages[1], { role: 'user', content: 'what time is it?' });
});

test('the name alone wakes Jarvis with a short acknowledgement and no model call', async () => {
  const { assistant, summary, requests } = setup([['unused']], { asleep: true, heard: ['Jarvis.', 'How are you?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['thinking', 'heard:Jarvis.', 'awake:true', 'speech:Yes, sir?', 'done']);
  assert.equal(requests.length, 0);
  await assistant.hear(audio);
  assert.equal(requests.length, 1, 'once awake, no wake word is needed');
});

test('a sleep command puts Jarvis back to sleep', async () => {
  const { assistant, summary, requests } = setup([['unused']], { heard: ['Go to sleep, Jarvis.', 'What time is it?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['thinking', 'heard:Go to sleep, Jarvis.', 'awake:false', 'speech:Going quiet, sir.', 'done']);
  await assistant.hear(audio);
  assert.equal(requests.length, 0, 'asleep again, so the question is ignored');
});
