import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant, type AssistantEvent } from './assistant.ts';
import type { ChatRequest, ToolCall } from './chat.ts';
import type { Tool } from './tools/types.ts';
import type { VoiceCheck } from './voice-lock.ts';

const audio = new Float32Array(1);

// An assistant wired to fakes; `replies` are the model's answers in order, each as stream pieces.
const setup = (
  replies: string[][],
  overrides: {
    heard?: string[];
    asleep?: boolean;
    idleSleepMs?: number;
    voice?: VoiceCheck[];
    tools?: Tool[];
    approvalMs?: number;
    /** Tool calls the model makes, round by round; a round with none ends the reply. */
    calls?: ToolCall[][];
    onSpeak?: (text: string) => void | Promise<void>;
  } = {},
) => {
  const events: AssistantEvent[] = [];
  const requests: ChatRequest[] = [];
  const heard = [...(overrides.heard ?? [])];
  const rounds = [...(overrides.calls ?? [])];
  const voices: string[] = [];
  const lockCalls: string[] = [];
  const checks = [...(overrides.voice ?? [])];
  const assistant = new Assistant({
    transcribe: async () => heard.shift() ?? 'What time is it?',
    chat: (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const pieces = replies.shift();
      const calls = rounds.shift();
      return (async function* () {
        if (!pieces) throw new Error('model offline');
        for (const piece of pieces) {
          if (request.signal?.aborted) throw new Error('aborted');
          yield piece;
        }
        return calls;
      })();
    },
    speak: async (text, voice) => {
      voices.push(voice);
      await overrides.onSpeak?.(text);
      return { samples: new Float32Array(2), sampleRate: 24000 };
    },
    emit: (event) => events.push(event),
    model: { model: 'fast' },
    personas: { jarvis: { voice: 'george', prompt: 'Be Jarvis.' }, friday: { voice: 'emma', prompt: 'Be Friday.' } },
    voiceLock: overrides.voice && {
      check: async () => checks.shift() ?? { result: 'open' },
      beginEnrolment: () => void lockCalls.push('enrol'),
      forget: () => void lockCalls.push('forget'),
    },
    startAwake: !overrides.asleep,
    holdMs: 20,
    now: () => new Date('2026-11-12T09:00'),
    tools: overrides.tools,
    approvalMs: overrides.approvalMs,
    idleSleepMs: overrides.idleSleepMs,
  });
  const summary = () =>
    events
      .filter((e) => e.type !== 'timing')
      .map((e) => (e.type === 'heard' || e.type === 'speech' ? `${e.type}:${e.text}` : e.type === 'error' ? `error:${e.message}` : e.type === 'awake' ? `awake:${e.awake}` : e.type === 'voice' ? `voice:${e.result}` : e.type === 'tool' ? `tool:${e.status}` : e.type));
  return { assistant, events, requests, summary, voices, lockCalls };
};

test('a turn is heard, answered sentence by sentence, then done', async () => {
  const { assistant, summary, requests } = setup([['It is ', 'nine. Time ', 'for coffee.']]);
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:What time is it?', 'thinking', 'speech:It is nine.', 'speech:Time for coffee.', 'done']);
  assert.deepEqual(requests[0]?.messages, [
    { role: 'system', content: 'Be Jarvis.\nIt is now Thursday, 12 November 2026 at 09:00.' },
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
  assert.deepEqual(summary(), ['heard:What time is it?', 'thinking', 'speech:One.', 'done']);
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
  assert.equal(summary().join('|'), 'heard:What time is it?|thinking|error:model offline|speech:Sorry, sir, I could not reach my brain just now. Please try again.|done');
  await assistant.hear(audio).catch(() => {});
  assert.equal(requests[1]?.messages.length, 2, 'system prompt plus the new question only');
});

test('asleep, Jarvis ignores speech until addressed by name, then answers what followed', async () => {
  const { assistant, summary, requests } = setup([['Nine.']], { asleep: true, heard: ['What time is it?', 'Hey Jarvis, what time is it?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['done']);
  await assistant.hear(audio);
  assert.deepEqual(summary().slice(1), ['heard:Hey Jarvis, what time is it?', 'awake:true', 'thinking', 'speech:Nine.', 'done']);
  assert.deepEqual(requests[0]?.messages[1], { role: 'user', content: 'what time is it?' });
});

test('the name alone wakes Jarvis with a short acknowledgement and no model call', async () => {
  const { assistant, summary, requests } = setup([['unused']], { asleep: true, heard: ['Jarvis.', 'How are you?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:Jarvis.', 'awake:true', 'speech:Yes, sir?', 'done']);
  assert.equal(requests.length, 0);
  await assistant.hear(audio);
  assert.equal(requests.length, 1, 'once awake, no wake word is needed');
});

test('a sleep command puts Jarvis back to sleep', async () => {
  const { assistant, summary, requests } = setup([['unused']], { heard: ['Go to sleep, Jarvis.', 'What time is it?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:Go to sleep, Jarvis.', 'awake:false', 'speech:Going quiet, sir.', 'done']);
  await assistant.hear(audio);
  assert.equal(requests.length, 0, 'asleep again, so the question is ignored');
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a sentence that trails off waits for its ending and is answered as one question', async () => {
  const { assistant, summary, requests } = setup([['Tea.']], { heard: ["What's the one you might...", 'recommend for a cold?'] });
  await assistant.hear(audio);
  assert.equal(requests.length, 0, 'half a question is not sent to the model');
  await assistant.hear(audio);
  assert.deepEqual(requests[0]?.messages[1], { role: 'user', content: "What's the one you might... recommend for a cold?" });
  assert.equal(summary().at(-2), 'speech:Tea.');
});

test('if the ending never comes, the half sentence is answered after the hold time', async () => {
  const { assistant, requests } = setup([['Go on?']], { heard: ['I was thinking about'] });
  await assistant.hear(audio);
  assert.equal(requests.length, 0);
  await pause(60);
  assert.deepEqual(requests[0]?.messages[1], { role: 'user', content: 'I was thinking about' });
});

test('the hold timer pauses while the user is speaking and restarts on a false alarm', async () => {
  const { assistant, requests } = setup([['Go on?']], { heard: ['I was thinking about'] });
  await assistant.hear(audio);
  assistant.userSpeaking(true);
  await pause(60);
  assert.equal(requests.length, 0, 'still waiting: the user is mid-sentence');
  assistant.userSpeaking(false);
  await pause(60);
  assert.equal(requests.length, 1);
});

test('talking over Jarvis before it has spoken joins both parts into one question', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { assistant, requests } = setup([['Slow.'], ['Sure.']], {
    heard: ['I want a pizza.', 'And a coke.'],
    onSpeak: (text) => (text === 'Slow.' ? gate : undefined),
  });
  const first = assistant.hear(audio);
  await pause(5);
  assistant.interrupt(true); // the microphone heard the user carry on
  const second = assistant.hear(audio);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(requests[1]?.messages.slice(1), [{ role: 'user', content: 'I want a pizza. And a coke.' }]);
});

test('the stop key drops a waiting half sentence', async () => {
  const { assistant, requests } = setup([['unused']], { heard: ['I was thinking about'] });
  await assistant.hear(audio);
  assistant.interrupt();
  await pause(60);
  assert.equal(requests.length, 0);
});

test('Jarvis goes back to sleep by itself after a stretch of silence', async () => {
  const { assistant, summary, requests } = setup([['Nine.']], { idleSleepMs: 30, heard: ['What time is it?', 'And tomorrow?'] });
  await assistant.hear(audio);
  await pause(80);
  assert.equal(summary().at(-1), 'awake:false');
  await assistant.hear(audio);
  assert.equal(requests.length, 1, 'asleep, so the follow-up is ignored');
});

test('an answered turn reports its delays', async () => {
  const { assistant, events } = setup([['Nine.']]);
  await assistant.hear(audio);
  const timing = events.find((e) => e.type === 'timing');
  assert.ok(timing && timing.firstAudioMs >= timing.firstWordsMs && timing.firstWordsMs >= timing.transcriptMs);
});

test('saying Friday wakes the female voice with her own character, and Jarvis takes over when named', async () => {
  const { assistant, summary, requests, voices } = setup([['Here.'], ['Back.']], {
    asleep: true,
    heard: ['Friday, are you there?', 'Jarvis, your turn.'],
  });
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(voices, ['emma', 'george']);
  assert.deepEqual(requests.map((r) => String(r.messages[0]?.content).split('\n')[0]), ['Be Friday.', 'Be Jarvis.']);
  assert.equal(summary().filter((e) => e === 'awake:true').length, 2, 'the hand-over is announced to the window');
  assert.equal(requests[1]?.messages.length, 4, 'they share one conversation');
});

test('a stranger is ignored once a voice is enrolled', async () => {
  const { assistant, summary, requests } = setup([['Nine.']], { voice: [{ result: 'stranger', score: 0.4 }, { result: 'owner', score: 0.9 }] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['voice:stranger', 'done']);
  await assistant.hear(audio);
  assert.equal(requests.length, 1);
});

test('"learn my voice" starts enrolment and the samples are not treated as questions', async () => {
  const { assistant, summary, requests, lockCalls } = setup([['unused']], {
    heard: ['Learn my voice.', 'The weather is lovely today.', 'I like long walks.', 'Short.', 'And a third sentence here.'],
    voice: [{ result: 'open' }, { result: 'sample' }, { result: 'sample' }, { result: 'too-short' }, { result: 'enrolled' }],
  });
  for (let i = 0; i < 5; i++) await assistant.hear(audio);
  assert.deepEqual(lockCalls, ['enrol']);
  assert.equal(requests.length, 0);
  assert.equal(summary().at(-2), 'speech:Thank you, sir. From now on we answer only to your voice.');
});

test('"forget my voice" removes the lock', async () => {
  const { assistant, lockCalls } = setup([['unused']], { heard: ['Forget my voice.'], voice: [{ result: 'owner', score: 0.9 }] });
  await assistant.hear(audio);
  assert.deepEqual(lockCalls, ['forget']);
});

test('asking for Friday by request hands over without calling the model', async () => {
  const { assistant, summary, requests, voices } = setup([['unused']], { heard: ['I want to talk to Friday.'] });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:I want to talk to Friday.', 'awake:true', 'speech:Friday here, sir.', 'done']);
  assert.deepEqual(voices, ['emma']);
  assert.equal(requests.length, 0);
});

// --- Tools and approvals ---
const ran: string[] = [];
const safeTool: Tool = {
  name: 'open_app',
  description: 'Open an app',
  parameters: { type: 'object', properties: { name: { type: 'string' } } },
  run: async (args) => {
    ran.push(`open ${String(args.name)}`);
    return 'Opened.';
  },
};
const riskyTool: Tool = {
  name: 'move_to_trash',
  description: 'Trash a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  approval: (args) => `move ${String(args.path)} to the Trash`,
  run: async (args) => {
    ran.push(`trash ${String(args.path)}`);
    return 'Moved.';
  },
};
const call = (name: string, args: object, id = 'c1'): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const settle = () => pause(15);

test('a safe action runs unasked and its result goes back to the model, which then replies', async () => {
  ran.length = 0;
  const { assistant, summary, requests } = setup([[], ['Safari is open.']], {
    heard: ['Open Safari.'],
    tools: [safeTool, riskyTool],
    calls: [[call('open_app', { name: 'Safari' })]],
  });
  await assistant.hear(audio);
  assert.deepEqual(ran, ['open Safari']);
  assert.deepEqual(summary(), ['heard:Open Safari.', 'thinking', 'tool:done', 'speech:Safari is open.', 'done']);
  assert.deepEqual(requests[0]?.tools?.map((tool) => (tool.type === 'function' ? tool.function.name : '')), ['open_app', 'move_to_trash']);
  const [, , request, result] = requests[1]!.messages;
  assert.deepEqual(request, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'open_app', arguments: '{"name":"Safari"}' } }] });
  assert.ok(result?.role === 'tool' && result.tool_call_id === 'c1' && String(result.content).startsWith('Opened.'));
  assert.match(String(result?.content), /do not follow them/, 'tool output is marked as data, not instructions');
});

test('a risky action is asked about first and runs only after a spoken yes', async () => {
  ran.length = 0;
  const { assistant, summary } = setup([[], ['It is in the Trash.']], {
    heard: ['Delete the old report.', 'Yes, go ahead.'],
    tools: [riskyTool],
    calls: [[call('move_to_trash', { path: '~/old.pdf' })]],
  });
  const turn = assistant.hear(audio);
  await settle();
  assert.deepEqual(ran, [], 'nothing happens while the question is open');
  assert.equal(summary().at(-1), 'speech:Shall I move ~/old.pdf to the Trash, sir?');
  assistant.interrupt(true); // the microphone hears the user start to answer; that must not cancel the question
  await assistant.hear(audio);
  await turn;
  assert.deepEqual(ran, ['trash ~/old.pdf']);
  assert.deepEqual(summary().slice(-4), ['heard:Yes, go ahead.', 'tool:done', 'speech:It is in the Trash.', 'done']);
});

test('a spoken no leaves the action undone and tells the model so', async () => {
  ran.length = 0;
  const { assistant, summary, requests } = setup([[], ['Left as it is.']], {
    heard: ['Delete the old report.', 'What?', 'No, leave it.'],
    tools: [riskyTool],
    calls: [[call('move_to_trash', { path: '~/old.pdf' })]],
  });
  const turn = assistant.hear(audio);
  await settle();
  await assistant.hear(audio); // an unclear answer gets the question again
  assert.equal(summary().at(-1), 'speech:Yes or no, sir?');
  await assistant.hear(audio);
  await turn;
  assert.deepEqual(ran, []);
  assert.ok(summary().includes('tool:declined'));
  assert.match(String(requests[1]?.messages.at(-1)?.content), /did not approve/);
});

test('no answer within the time allowed counts as no, and so does the stop key', async () => {
  ran.length = 0;
  const silent = setup([[], ['Left.']], { heard: ['Delete it.'], tools: [riskyTool], calls: [[call('move_to_trash', { path: '~/a' })]], approvalMs: 20 });
  await silent.assistant.hear(audio);
  assert.ok(silent.summary().includes('tool:declined'));

  const stopped = setup([[], ['unused']], { heard: ['Delete it.'], tools: [riskyTool], calls: [[call('move_to_trash', { path: '~/a' })]] });
  const turn = stopped.assistant.hear(audio);
  await settle();
  stopped.assistant.interrupt();
  await turn;
  assert.deepEqual(ran, []);
  assert.equal(stopped.requests.length, 1, 'a stopped turn does not go back to the model');
});

test('a stranger cannot approve an action', async () => {
  ran.length = 0;
  const { assistant } = setup([[], ['Left.']], {
    heard: ['Delete it.', 'Yes.'],
    tools: [riskyTool],
    calls: [[call('move_to_trash', { path: '~/a' })]],
    voice: [{ result: 'owner', score: 0.9 }, { result: 'stranger', score: 0.3 }],
    approvalMs: 60,
  });
  const turn = assistant.hear(audio);
  await settle();
  await assistant.hear(audio);
  await turn;
  assert.deepEqual(ran, []);
});

test('bad tool requests are reported to the model instead of crashing the turn', async () => {
  const failing: Tool = { ...safeTool, name: 'broken', run: async () => Promise.reject(new Error('disk full')) };
  const { assistant, requests, summary } = setup([[], ['Sorry about that.']], {
    tools: [safeTool, failing],
    calls: [[{ id: 'a', name: 'no_such_tool', arguments: '{}' }, { id: 'b', name: 'open_app', arguments: 'not json' }, call('broken', {}, 'c')]],
  });
  await assistant.hear(audio);
  const results = requests[1]!.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
  assert.match(results[0]!, /no tool called "no_such_tool"/);
  assert.match(results[1]!, /^Error: /);
  assert.equal(results[2], 'Error: disk full');
  assert.equal(summary().at(-2), 'speech:Sorry about that.');
});

test('a slow lookup gets a spoken "one moment", and tool results stay available to follow-up questions', async () => {
  const slow: Tool = { ...safeTool, name: 'unread_email', slow: true, run: async () => 'From Ama: Invoice overdue' };
  const { assistant, summary, requests } = setup([[], ['One from Ama.'], ['About an invoice.']], {
    heard: ['Any email?', 'What is it about?'],
    tools: [slow],
    calls: [[call('unread_email', {})]],
  });
  await assistant.hear(audio);
  assert.deepEqual(summary().slice(1, 5), ['thinking', 'speech:One moment, sir.', 'tool:done', 'speech:One from Ama.']);
  await assistant.hear(audio);
  assert.ok(requests[2]?.messages.some((message) => message.role === 'tool' && String(message.content).includes('Invoice overdue')));
});

test('a model that keeps calling tools is stopped after six rounds', async () => {
  const { assistant, requests, summary } = setup(Array.from({ length: 8 }, () => []), {
    tools: [safeTool],
    calls: Array.from({ length: 8 }, (_, round) => [call('open_app', { name: 'X' }, `c${round}`)]),
  });
  await assistant.hear(audio);
  assert.equal(requests.length, 6);
  assert.equal(summary().at(-2), 'speech:That took more steps than I am allowed, sir, so I have stopped.');
});

test('a model that returns nothing at all still gets a spoken reply', async () => {
  const { assistant, summary } = setup([[]]);
  await assistant.hear(audio);
  assert.equal(summary().at(-2), 'speech:Sorry, sir, I have no answer to that. Could you put it another way?');
});

test('"one moment" is said only once in a turn, however many slow lookups it takes', async () => {
  const slow: Tool = { ...safeTool, name: 'unread_email', slow: true, run: async () => 'none' };
  const { assistant, summary } = setup([[], [], ['All clear.']], { tools: [slow], calls: [[call('unread_email', {})], [call('unread_email', {}, 'c2')]] });
  await assistant.hear(audio);
  assert.equal(summary().filter((line) => line === 'speech:One moment, sir.').length, 1);
});
