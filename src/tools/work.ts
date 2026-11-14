import { exec } from './exec.ts';
import { clip, text, type Tool } from './types.ts';

export type WorkConfig = {
  /** A Slack user token (xoxp-...), with search:read and chat:write. */
  slackToken?: string;
  /** Jira: the site (https://name.atlassian.net), the account's email and an API token. */
  jiraSite?: string;
  jiraEmail?: string;
  jiraToken?: string;
  run?: typeof exec;
  fetch?: typeof fetch;
};

type Found = { repository: { nameWithOwner: string }; title: string; number: number };

/**
 * His work tools. GitHub goes through the `gh` command, already signed in. Slack and Jira talk to their
 * web services and appear only when their keys are set (SLACK_TOKEN; JIRA_SITE, JIRA_EMAIL and
 * JIRA_TOKEN), so they cost nothing until then.
 */
export function workTools(config: WorkConfig): Tool[] {
  const run = config.run ?? exec;
  const request = config.fetch ?? fetch;
  const call = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`The service answered ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };
  const search = async (kind: 'issues' | 'prs', filter: string[]) =>
    (JSON.parse(await run('gh', ['search', kind, ...filter, '--state', 'open', '--limit', '15', '--json', 'repository,title,number'], { timeoutMs: 20_000 })) as Found[]).map(
      (one) => `${one.repository.nameWithOwner} #${one.number}: ${one.title}`,
    );

  const tools: Tool[] = [
    {
      name: 'github_inbox',
      description: 'What is waiting for him on GitHub: open issues assigned to him, pull requests waiting for his review, and his own open pull requests.',
      parameters: { type: 'object', properties: {} },
      slow: true,
      run: async () => {
        const [assigned, review, mine] = await Promise.all([search('issues', ['--assignee', '@me']), search('prs', ['--review-requested', '@me']), search('prs', ['--author', '@me'])]);
        const part = (title: string, lines: string[]) => `${title}: ${lines.length ? `\n${lines.join('\n')}` : 'none'}`;
        return [part('Issues assigned to him', assigned), part('Pull requests waiting for his review', review), part('His open pull requests', mine)].join('\n\n');
      },
    },
    {
      name: 'github_create_issue',
      description: 'Open an issue in one of his GitHub repositories ("owner/name").',
      parameters: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] },
      approval: (args) => `open an issue in ${text(args, 'repo')} called ${text(args, 'title')}`,
      slow: true,
      run: async (args) => `Opened: ${await run('gh', ['issue', 'create', '-R', text(args, 'repo'), '-t', text(args, 'title'), '-b', typeof args.body === 'string' ? args.body : ''], { timeoutMs: 30_000 })}`,
    },
  ];

  if (config.slackToken) {
    const slack = (method: string, init: RequestInit = {}) =>
      call(`https://slack.com/api/${method}`, { ...init, headers: { authorization: `Bearer ${config.slackToken}`, 'content-type': 'application/json; charset=utf-8' } }).then((body) => {
        if (body.ok !== true) throw new Error(`Slack refused: ${String(body.error)}`);
        return body;
      });
    tools.push(
      {
        name: 'slack_search',
        description: 'Search his Slack messages, newest first. Slack\'s own search words work: "to:me" for messages to him, "in:#channel", "from:@name", "after:yesterday". Use "to:me after:yesterday" for what he missed.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        slow: true,
        run: async (args) => {
          const body = await slack(`search.messages?count=12&sort=timestamp&query=${encodeURIComponent(text(args, 'query'))}`);
          const matches = ((body.messages as { matches?: { username?: string; text?: string; channel?: { name?: string } }[] } | undefined)?.matches ?? []).map(
            (one) => `#${one.channel?.name ?? '?'} ${one.username ?? 'someone'}: ${(one.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
          );
          return matches.length ? clip(matches.join('\n'), 4000) : 'No Slack messages match that.';
        },
      },
      {
        name: 'slack_send',
        description: 'Post a message in Slack, to a channel ("#general") or a person ("@name" or their member id). The Mac reads it back to him and asks before it goes.',
        parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
        alwaysAsk: true,
        approval: (args) => `post in Slack to ${text(args, 'channel')}, saying: ${text(args, 'text').slice(0, 280)}`,
        slow: true,
        run: async (args) => {
          await slack('chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: text(args, 'channel').trim(), text: text(args, 'text') }) });
          return `Posted to ${text(args, 'channel').trim()}.`;
        },
      },
    );
  }

  if (config.jiraSite && config.jiraEmail && config.jiraToken) {
    const site = config.jiraSite.replace(/\/+$/, '');
    const headers = { authorization: `Basic ${Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' };
    tools.push(
      {
        name: 'jira_my_issues',
        description: 'The open Jira issues assigned to him, most recently changed first.',
        parameters: { type: 'object', properties: {} },
        slow: true,
        run: async () => {
          const jql = encodeURIComponent('assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC');
          const body = await call(`${site}/rest/api/3/search/jql?jql=${jql}&maxResults=15&fields=summary,status`, { headers });
          const issues = ((body.issues as { key: string; fields: { summary: string; status?: { name?: string } } }[] | undefined) ?? []).map((one) => `${one.key} (${one.fields.status?.name ?? 'open'}): ${one.fields.summary}`);
          return issues.length ? issues.join('\n') : 'No open Jira issues are assigned to him.';
        },
      },
      {
        name: 'jira_create_issue',
        description: 'Create a Jira task in a project, by the project key (e.g. "WEB").',
        parameters: { type: 'object', properties: { project: { type: 'string', description: 'The project key' }, summary: { type: 'string' }, description: { type: 'string' } }, required: ['project', 'summary'] },
        approval: (args) => `create a Jira issue in ${text(args, 'project')} called ${text(args, 'summary')}`,
        slow: true,
        run: async (args) => {
          const description = typeof args.description === 'string' && args.description.trim() ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description }] }] } : undefined;
          const body = await call(`${site}/rest/api/3/issue`, { method: 'POST', headers, body: JSON.stringify({ fields: { project: { key: text(args, 'project').trim().toUpperCase() }, summary: text(args, 'summary'), issuetype: { name: 'Task' }, ...(description ? { description } : {}) } }) });
          return `Created ${String(body.key)}.`;
        },
      },
    );
  }
  return tools;
}
