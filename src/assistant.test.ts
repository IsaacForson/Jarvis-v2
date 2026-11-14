import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant, type AssistantEvent, MORE_TOOLS } from './assistant.ts';
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
    needsTool?: boolean;
    approvalMs?: number;
    autonomous?: boolean;
    context?: () => string;
    /** Tool calls the model makes, round by round; a round with none ends the reply. */
    calls?: ToolCall[][];
    onSpeak?: (text: string) => void | Promise<void>;
    /** Dictation and meeting notes: what was typed and noted is recorded in `typed` and `noted`. */
    modes?: boolean;
    /** A quick brain: its answers and tool calls in order (a missing answer means it is unreachable), and the tools it has. */
    quick?: { replies: (string[] | undefined)[]; calls?: ToolCall[][]; tools?: Tool[] };
  } = {},
) => {
  const events: AssistantEvent[] = [];
  const requests: ChatRequest[] = [];
  const quickRequests: ChatRequest[] = [];
  const typed: string[] = [];
  const noted: string[] = [];
  const quickRounds = [...(overrides.quick?.calls ?? [])];
  const checks_: string[] = [];
  const heard = [...(overrides.heard ?? [])];
  const rounds = [...(overrides.calls ?? [])];
  const voices: string[] = [];
  const lockCalls: string[] = [];
  const checks = [...(overrides.voice ?? [])];
  let enrolling = false;
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
    quick: overrides.quick && {
      chat: (request) => {
        quickRequests.push(structuredClone({ ...request, signal: undefined }));
        const pieces = overrides.quick!.replies.shift();
        const calls = quickRounds.shift();
        return (async function* () {
          if (!pieces) throw new Error('quick model offline');
          yield* pieces;
          return calls;
        })();
      },
      model: { model: 'quick', maxTokens: 500 },
      tools: overrides.quick.tools ?? [],
    },
    personas: { jarvis: { voice: 'george', prompt: 'Be Jarvis.', brief: 'Be Jarvis, briefly.' }, friday: { voice: 'emma', prompt: 'Be Friday.' } },
    voiceLock: overrides.voice && {
      check: async () => {
        const result = checks.shift() ?? { result: 'open' };
        if (result.result === 'enrolled') enrolling = false;
        return result;
      },
      beginEnrolment: () => void (lockCalls.push('enrol'), (enrolling = true)),
      forget: () => void lockCalls.push('forget'),
      get enrolling() {
        return enrolling;
      },
    },
    startAwake: !overrides.asleep,
    holdMs: 20,
    now: () => new Date('2026-11-12T09:00'),
    tools: overrides.tools,
    needsTool: overrides.needsTool === undefined ? undefined : async (request, previous) => (checks_.push(`${previous} / ${request}`), overrides.needsTool!),
    approvalMs: overrides.approvalMs,
    autonomous: overrides.autonomous,
    context: overrides.context,
    idleSleepMs: overrides.idleSleepMs,
    typeText: overrides.modes ? async (text) => void typed.push(text) : undefined,
    notes: overrides.modes ? { start: () => void (noted.length = 0), add: (text) => void noted.push(text), end: async () => `You agreed ${noted.length} things. The notes are saved.` } : undefined,
  });
  const summary = () =>
    events
      .filter((e) => e.type !== 'timing')
      .map((e) => (e.type === 'heard' || e.type === 'speech' ? `${e.type}:${e.text}` : e.type === 'error' ? `error:${e.message}` : e.type === 'awake' ? `awake:${e.awake}` : e.type === 'voice' ? `voice:${e.result}` : e.type === 'tool' ? `tool:${e.status}` : e.type));
  return { assistant, events, requests, quickRequests, typed, noted, summary, voices, lockCalls, toolChecks: checks_ };
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
  assert.deepEqual(summary(), [], 'no turn at all');
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
  assert.deepEqual(summary(), ['ignored'], 'logged only');
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
  assert.deepEqual(summary(), ['voice:stranger']);
  await assistant.hear(audio);
  assert.equal(requests.length, 1);
});

test('"learn my voice" starts enrolment and the samples are not treated as questions', async () => {
  const { assistant, summary, requests, lockCalls } = setup([['unused']], {
    heard: ['Learn my voice.', 'Jarvis, the weather is lovely today.', 'See you next week, on the television.', 'Jarvis, I like long walks.', 'Jarvis, short.', 'Jarvis, and a third sentence here.'],
    voice: [{ result: 'open' }, { result: 'sample' }, { result: 'sample' }, { result: 'too-short' }, { result: 'enrolled', threshold: 0.8 }],
  });
  for (let i = 0; i < 6; i++) await assistant.hear(audio);
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

test('working on its own, Jarvis acts unasked but still asks before deleting', async () => {
  ran.length = 0;
  const sendTool: Tool = { ...riskyTool, name: 'send', approval: () => 'send the form on example.com', run: async () => (ran.push('sent'), 'Sent.') };
  const sent = setup([[], ['Sent.']], { heard: ['Send it.'], tools: [sendTool], calls: [[call('send', {})]], autonomous: true });
  await sent.assistant.hear(audio);
  assert.deepEqual(ran, ['sent']);
  assert.ok(!sent.summary().some((line) => line.startsWith('speech:Shall I')));

  const shell: Tool = { ...riskyTool, name: 'run_command', approval: (args) => `run the command: ${String(args.command)}` };
  for (const [tool, args] of [[riskyTool, { path: '~/a' }], [shell, { command: 'rm -rf ~/old' }]] as const) {
    const trash = setup([[], ['Left.']], { heard: ['Delete it.'], tools: [tool], calls: [[call(tool.name, args)]], autonomous: true, approvalMs: 20 });
    await trash.assistant.hear(audio);
    assert.ok(trash.summary().some((line) => line.startsWith('speech:Shall I')));
    assert.ok(trash.summary().includes('tool:declined'));
  }
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

test('a model that keeps calling tools is stopped after forty rounds', async () => {
  const { assistant, requests, summary } = setup(Array.from({ length: 42 }, () => []), {
    tools: [safeTool],
    calls: Array.from({ length: 42 }, (_, round) => [call('open_app', { name: 'X' }, `c${round}`)]),
  });
  await assistant.hear(audio);
  assert.equal(requests.length, 40);
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

test('talk instead of action is discarded and the model is made to call a tool', async () => {
  ran.length = 0;
  const { assistant, summary, requests, toolChecks } = setup([['Safari is in front, sir.'], [], ['Notes is in front.']], {
    heard: ['Which app is in front?'],
    tools: [safeTool],
    needsTool: true,
    calls: [[], [call('open_app', { name: 'look' })]],
  });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:Which app is in front?', 'thinking', 'tool:done', 'speech:Notes is in front.', 'done'], 'the invented answer is never spoken');
  assert.deepEqual(requests.map((request) => request.toolChoice), [undefined, 'required', undefined]);
  assert.equal(requests[1]?.messages.length, 2, 'the discarded talk is not shown to the model again');
  assert.deepEqual(toolChecks, [' / Which app is in front?']);
});

test('when a tool is needed and the model calls one, what it said first is still spoken', async () => {
  const { assistant, summary, requests } = setup([['Let me look.'], ['It is Notes.']], { tools: [safeTool], needsTool: true, calls: [[call('open_app', { name: 'look' })]] });
  await assistant.hear(audio);
  assert.deepEqual(summary().slice(2), ['speech:Let me look.', 'tool:done', 'speech:It is Notes.', 'done']);
  assert.ok(requests.every((request) => request.toolChoice === undefined));
});

test('conversation is not forced into a tool, and the check sees what Jarvis said last', async () => {
  const { assistant, summary, requests, toolChecks } = setup([['Very well, sir.'], ['Indeed.']], { heard: ['How are you?', 'Good to hear.'], tools: [safeTool], needsTool: false });
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(summary().filter((line) => line.startsWith('speech')), ['speech:Very well, sir.', 'speech:Indeed.']);
  assert.equal(requests.length, 2);
  assert.deepEqual(toolChecks, [' / How are you?', 'Very well, sir. / Good to hear.']);
});

test('what memory holds is added to the instructions every turn', async () => {
  let facts = 'Prefers tea.';
  const { assistant, requests } = setup([['Tea.'], ['Coffee.']], { heard: ['What do I drink?', 'And now?'], context: () => facts });
  await assistant.hear(audio);
  facts = 'Prefers coffee.';
  await assistant.hear(audio);
  assert.equal(requests[0]?.messages[0]?.content, 'Be Jarvis.\nIt is now Thursday, 12 November 2026 at 09:00.\nPrefers tea.');
  assert.equal(requests[1]?.messages[0]?.content, 'Be Jarvis.\nIt is now Thursday, 12 November 2026 at 09:00.\nPrefers coffee.');
});

test('forgetting drops the conversation held in the session, the turn that asked included', async () => {
  let assistantRef: { forgetConversation(): void } | undefined;
  const forgetTool: Tool = { name: 'forget', description: 'Forget', parameters: { type: 'object', properties: {} }, run: async () => (assistantRef?.forgetConversation(), 'Forgotten.') };
  const { assistant, requests } = setup([['Dana is your manager.'], [], ['Done.'], ['Nine.']], {
    heard: ['Who is Dana?', 'Forget Dana.', 'What time is it?'],
    tools: [forgetTool],
    calls: [[], [call('forget', {})], [], []],
  });
  assistantRef = assistant;
  await assistant.hear(audio);
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(requests.at(-1)?.messages.slice(1), [{ role: 'user', content: 'What time is it?' }]);
});

test('speaking up unasked wakes Jarvis, is kept for the reply, and waits while busy', async () => {
  const { assistant, summary, requests } = setup([['Done, I will mark it.']], { asleep: true, heard: ['Jarvis, it is done.'] });
  assert.equal(await assistant.announce('Sir, a reminder: call Dana.', 'This was reminder 3.'), true);
  assert.deepEqual(summary(), ['awake:true', 'speech:Sir, a reminder: call Dana.', 'done']);
  await assistant.hear(audio);
  assert.deepEqual(requests[0]?.messages.slice(1, 3), [
    { role: 'user', content: '(Nothing was said; you spoke up on your own. This was reminder 3.)' },
    { role: 'assistant', content: 'Sir, a reminder: call Dana.' },
  ]);

  assistant.userSpeaking(true);
  assert.equal(assistant.busy, true);
  assert.equal(await assistant.announce('Not now.'), false);
  assistant.userSpeaking(false);
  assert.equal(assistant.busy, false);
});

test('a scheduled turn runs from an instruction, like the morning briefing', async () => {
  const { assistant, summary, requests } = setup([['Good morning, sir.']], { asleep: true });
  assert.equal(await assistant.initiate('Give the briefing.'), true);
  assert.equal(requests[0]?.messages.at(-1)?.content, '(Nothing was said; this is scheduled.) Give the briefing.');
  assert.deepEqual(summary(), ['awake:true', 'thinking', 'speech:Good morning, sir.', 'done']);
});

const names = (request?: ChatRequest) => request?.tools?.map((tool) => (tool.type === 'function' ? tool.function.name : ''));

test('the quick brain answers conversation and simple actions by itself, with brief instructions and its few tools', async () => {
  ran.length = 0;
  const { assistant, summary, requests, quickRequests } = setup([], {
    heard: ['Good morning.', 'Open Safari.'],
    tools: [safeTool, riskyTool],
    quick: { replies: [['Good morning, sir.'], [], ['Safari is open.']], calls: [[], [call('open_app', { name: 'Safari' })]], tools: [safeTool] },
  });
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:Good morning.', 'thinking', 'speech:Good morning, sir.', 'done', 'heard:Open Safari.', 'thinking', 'tool:done', 'speech:Safari is open.', 'done']);
  assert.deepEqual(ran, ['open Safari']);
  assert.equal(requests.length, 0, 'the main brain was never asked');
  assert.match(String(quickRequests[0]?.messages[0]?.content), /^Be Jarvis, briefly\./);
  assert.deepEqual(names(quickRequests[0]), ['open_app', MORE_TOOLS.function.name]);
  assert.equal(quickRequests[0]?.maxTokens, 500);
});

test('when the quick brain asks for more, the main one takes the turn over and nothing the quick one said is spoken', async () => {
  ran.length = 0;
  const { assistant, summary, requests, quickRequests } = setup([[], ['It is in the Trash.']], {
    heard: ['Trash the report.'],
    tools: [safeTool, riskyTool],
    autonomous: false,
    calls: [[call('open_app', { name: 'Finder' })]],
    quick: { replies: [['Let me see.']], calls: [[call(MORE_TOOLS.function.name, {})]], tools: [safeTool] },
  });
  await assistant.hear(audio);
  assert.deepEqual(summary(), ['heard:Trash the report.', 'thinking', 'tool:done', 'speech:It is in the Trash.', 'done']);
  assert.equal(quickRequests.length, 1, 'the quick brain is not asked again this turn');
  assert.deepEqual(names(requests[0]), ['open_app', 'move_to_trash']);
  assert.match(String(requests[0]?.messages[0]?.content), /^Be Jarvis\./);
  assert.deepEqual(requests[0]?.messages.at(-1), { role: 'user', content: 'Trash the report.' }, 'the main brain starts from the question, not the hand-over');
});

test('the main brain also takes over when the quick one is unreachable, says nothing, or talks where a tool was needed', async () => {
  const offline = setup([['Paris, sir.']], { heard: ['Capital of France?'], quick: { replies: [undefined] } });
  await offline.assistant.hear(audio);
  assert.deepEqual(offline.summary(), ['heard:Capital of France?', 'thinking', 'tool:failed', 'speech:Paris, sir.', 'done']);

  const silent = setup([['Paris, sir.']], { heard: ['Capital of France?'], quick: { replies: [[]] } });
  await silent.assistant.hear(audio);
  assert.deepEqual(silent.summary(), ['heard:Capital of France?', 'thinking', 'speech:Paris, sir.', 'done']);

  ran.length = 0;
  const talker = setup([[], ['Safari is open.']], {
    heard: ['Open Safari.'],
    tools: [safeTool],
    needsTool: true,
    calls: [[call('open_app', { name: 'Safari' })]],
    quick: { replies: [['I have opened Safari.']], tools: [safeTool] },
  });
  await talker.assistant.hear(audio);
  assert.deepEqual(talker.summary(), ['heard:Open Safari.', 'thinking', 'tool:done', 'speech:Safari is open.', 'done']);
  assert.deepEqual(ran, ['open Safari']);
});

test('the quick brain is sent only the words of earlier exchanges, never their tool results', async () => {
  ran.length = 0;
  const { assistant, quickRequests } = setup([], {
    heard: ['Open Safari.', 'Thank you.'],
    tools: [safeTool],
    quick: { replies: [[], ['Safari is open.'], ['A pleasure, sir.']], calls: [[call('open_app', { name: 'Safari' })]], tools: [safeTool] },
  });
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.deepEqual(quickRequests[2]?.messages.slice(1), [
    { role: 'user', content: 'Open Safari.' },
    { role: 'assistant', content: 'Safari is open.' },
    { role: 'user', content: 'Thank you.' },
  ]);
});

test('in dictation, what he says is typed as heard and not answered, until he says stop', async () => {
  const { assistant, summary, requests, typed } = setup([], {
    heard: ['Start dictation.', 'Friday is the deadline.', 'Jarvis will send it, okay?', 'Jarvis, stop dictation.', 'What time is it?'],
    modes: true,
  });
  for (let i = 0; i < 4; i++) await assistant.hear(audio);
  assert.deepEqual(typed, ['Friday is the deadline. ', 'Jarvis will send it, okay? '], 'names are typed, not obeyed');
  assert.equal(requests.length, 0, 'the model is never asked');
  assert.deepEqual(summary(), [
    'heard:Start dictation.', 'speech:Dictation on, sir. Say stop dictation when you are done.', 'done',
    'heard:Friday is the deadline.', 'done', 'heard:Jarvis will send it, okay?', 'done',
    'heard:Jarvis, stop dictation.', 'speech:Dictation off, sir.', 'done',
  ]);
});

test('in a meeting everyone is written down, nothing is answered, and only the owner by name ends it', async () => {
  const { assistant, summary, requests, noted } = setup([], {
    heard: ['Take notes of this meeting.', 'Let us ship on Monday.', 'End the meeting.', 'Jarvis, end the meeting.', 'I agree, Monday.', 'Jarvis, end the meeting.'],
    voice: [{ result: 'owner', score: 0.9 }, { result: 'stranger', score: 0.2 }, { result: 'owner', score: 0.9 }, { result: 'stranger', score: 0.2 }, { result: 'stranger', score: 0.3 }, { result: 'owner', score: 0.9 }],
    modes: true,
  });
  for (let i = 0; i < 5; i++) await assistant.hear(audio);
  assert.equal(assistant.busy, true, 'reminders wait until the meeting is over');
  await assistant.hear(audio);
  assert.deepEqual(noted, ['Let us ship on Monday.', 'End the meeting.', 'Jarvis, end the meeting.', 'I agree, Monday.'], 'a stranger cannot end it, nor can the owner without the name');
  assert.equal(requests.length, 0);
  assert.deepEqual(summary().filter((line) => !line.startsWith('voice:')).slice(-4), ['speech:One moment, sir, while I write up the notes.', 'speech:You agreed 4 things.', 'speech:The notes are saved.', 'done']);
  assert.equal(assistant.busy, false);
});

test('sending a message is asked about even when Jarvis works on its own', async () => {
  ran.length = 0;
  const send: Tool = { name: 'send_message', description: '', parameters: { type: 'object', properties: {} }, alwaysAsk: true, approval: () => 'send a message to Dana, saying: Running late', run: async () => (ran.push('sent'), 'Sent.') };
  const { assistant, summary } = setup([[], ['Left unsent.']], { heard: ['Tell Dana I am running late.'], tools: [send], autonomous: true, approvalMs: 20, calls: [[call('send_message', {})]] });
  await assistant.hear(audio);
  assert.deepEqual(ran, []);
  assert.deepEqual(summary().slice(2, 5), ['tool:asking', 'speech:Shall I send a message to Dana, saying: Running late, sir?', 'tool:declined']);
});

test('room noise, other people talking and Jarvis\'s own echo do not cut off its reply', async () => {
  let assistantRef: Assistant | undefined;
  const background = ['What time is it?', 'and then the striker scores again', 'One. Two. Three.'];
  const { assistant, summary } = setup([['One. Two. Three. ']], {
    heard: background,
    onSpeak: async (text) => {
      // While Jarvis talks, the television talks too, and the microphone hears Jarvis itself.
      if (text === 'Two.') {
        await assistantRef!.hear(audio);
        await assistantRef!.hear(audio);
      }
    },
  });
  assistantRef = assistant;
  // Awake, so the television is heard; it must still not interrupt.
  await assistant.hear(audio);
  assert.ok(summary().includes('speech:Three.'), 'the reply was finished');
});

test('a call by name in the middle of other talk is still heard', async () => {
  const { assistant, summary } = setup([['Nine.']], { asleep: true, heard: ['I really love his music, his melodies are phenomenal. Um, okay. Jarvis, what time is it?'] });
  await assistant.hear(audio);
  assert.deepEqual(summary().slice(1, 3), ['awake:true', 'thinking']);
});

test('a clear barge-in still stops the reply', async () => {
  let assistantRef: Assistant | undefined;
  const { assistant, summary } = setup([['One. Two. Three. '], ['Stopped.']], {
    heard: ['What time is it?', 'Stop, that is enough.'],
    onSpeak: async (text) => {
      if (text === 'Two.') await assistantRef!.hear(audio);
    },
  });
  assistantRef = assistant;
  await assistant.hear(audio);
  assert.ok(!summary().includes('speech:Three.'), 'cut off');
  assert.ok(summary().includes('heard:Stop, that is enough.'));
});

test('talk in the room that the model judges not meant for Jarvis gets no reply at all', async () => {
  const { assistant, summary } = setup([['IGNORE']], { heard: ['and the striker scores again'] });
  await assistant.hear(audio);
  assert.ok(!summary().some((line) => line.startsWith('speech:')), 'silent');
});

test('Jarvis\'s own words coming back through the microphone are recognised as an echo', async () => {
  const { isEcho } = await import('./assistant.ts');
  assert.equal(isEcho('Yes, sir?', 'Yes, sir?'), true);
  assert.equal(isEcho('It is nine o\'clock now', 'It is nine o\'clock now, sir.'), true);
  assert.equal(isEcho('Yes.', 'Yes, sir?'), false, 'a one-word answer is his');
  assert.equal(isEcho('What is the weather?', 'Yes, sir?'), false);
});

test('asleep, calling the name wakes Jarvis even when it said its own name last', async () => {
  const { assistant, summary } = setup([['unused']], { asleep: true, heard: ['Friday, give me Jarvis.', 'Go to sleep.', 'Jarvis, Jarvis.'] });
  await assistant.hear(audio); // Friday hands over: "Jarvis here, sir."
  await assistant.hear(audio);
  await assistant.hear(audio);
  assert.equal(summary().filter((line) => line === 'awake:true').length >= 2, true);
  assert.equal(summary().at(-2), 'speech:Yes, sir?');
});
