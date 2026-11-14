import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workTools } from './work.ts';

const names = (tools: { name: string }[]) => tools.map((one) => one.name);
const answer = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

test('GitHub is always there; Slack and Jira appear only when their keys are set', () => {
  assert.deepEqual(names(workTools({})), ['github_inbox', 'github_create_issue']);
  assert.deepEqual(names(workTools({ slackToken: 'x', jiraSite: 'https://a.atlassian.net', jiraEmail: 'a@b.c' })), ['github_inbox', 'github_create_issue', 'slack_search', 'slack_send'], 'half-configured Jira stays out');
});

test('the GitHub inbox lists what is assigned, awaiting review and open; an issue is asked about first', async () => {
  const ran: string[][] = [];
  const tools = workTools({
    run: async (_file, args) => {
      ran.push(args);
      if (args[0] === 'issue') return 'https://github.com/me/app/issues/9';
      return JSON.stringify(args.includes('--assignee') ? [{ repository: { nameWithOwner: 'me/app' }, title: 'Fix login', number: 7 }] : []);
    },
  });
  assert.equal(await tools[0]!.run({}), 'Issues assigned to him: \nme/app #7: Fix login\n\nPull requests waiting for his review: none\n\nHis open pull requests: none');
  assert.equal(tools[1]!.approval?.({ repo: 'me/app', title: 'Crash on start' }), 'open an issue in me/app called Crash on start');
  assert.equal(await tools[1]!.run({ repo: 'me/app', title: 'Crash on start', body: 'Steps' }), 'Opened: https://github.com/me/app/issues/9');
  assert.deepEqual(ran.at(-1), ['issue', 'create', '-R', 'me/app', '-t', 'Crash on start', '-b', 'Steps']);
});

test('Slack searches and posts with the token; posting is always asked about, and a refusal is reported', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let ok = true;
  const tools = workTools({
    slackToken: 'xoxp-test',
    fetch: (async (url: string, init: RequestInit) => (calls.push({ url, init }), answer(ok ? { ok: true, messages: { matches: [{ username: 'dana', text: 'Can you\nreview?', channel: { name: 'web' } }] } } : { ok: false, error: 'not_in_channel' }))) as typeof fetch,
  });
  const tool = (name: string) => tools.find((one) => one.name === name)!;
  assert.equal(await tool('slack_search').run({ query: 'to:me after:yesterday' }), '#web dana: Can you review?');
  assert.match(calls[0]!.url, /search\.messages\?count=12&sort=timestamp&query=to%3Ame%20after%3Ayesterday$/);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer xoxp-test');
  assert.equal(tool('slack_send').alwaysAsk, true);
  assert.equal(await tool('slack_send').run({ channel: '#web', text: 'On it' }), 'Posted to #web.');
  assert.equal(calls[1]!.init.body, JSON.stringify({ channel: '#web', text: 'On it' }));
  ok = false;
  await assert.rejects(tool('slack_send').run({ channel: '#web', text: 'On it' }), /Slack refused: not_in_channel/);
});

test('Jira lists his open issues and creates a task, signed in with the email and token', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const tools = workTools({
    jiraSite: 'https://a.atlassian.net/',
    jiraEmail: 'me@a.com',
    jiraToken: 'secret',
    fetch: (async (url: string, init: RequestInit) => (calls.push({ url, init }), answer(init.method === 'POST' ? { key: 'WEB-12' } : { issues: [{ key: 'WEB-3', fields: { summary: 'Fix login', status: { name: 'In Progress' } } }] }))) as typeof fetch,
  });
  const tool = (name: string) => tools.find((one) => one.name === name)!;
  assert.equal(await tool('jira_my_issues').run({}), 'WEB-3 (In Progress): Fix login');
  assert.match(calls[0]!.url, /^https:\/\/a\.atlassian\.net\/rest\/api\/3\/search\/jql\?jql=assignee/);
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('me@a.com:secret').toString('base64')}`);
  assert.equal(await tool('jira_create_issue').run({ project: 'web', summary: 'Crash on start' }), 'Created WEB-12.');
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { fields: { project: { key: 'WEB' }, summary: 'Crash on start', issuetype: { name: 'Task' } } });
});
