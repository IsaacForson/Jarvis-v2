import { osascript } from './exec.ts';
import { clip, integer, type Tool } from './types.ts';

type RawMail = { id: number; from: string; subject: string; received: string };

/** Every unread email in the inbox, as the Mail app reports it. */
export const unreadMail = async (): Promise<RawMail[]> => JSON.parse(await osascript(UNREAD, { javascript: true })) as RawMail[];

// Runs inside the Mail app; one request per property for the whole unread list.
const UNREAD = `
  const unread = Application('Mail').inbox.messages.whose({ readStatus: false });
  const ids = unread.id();
  const from = unread.sender(), subjects = unread.subject(), dates = unread.dateReceived();
  JSON.stringify(ids.map((id, i) => ({ id, from: from[i], subject: subjects[i], received: dates[i].toISOString() })));`;
const BODY = (id: number) => `
  const found = Application('Mail').inbox.messages.whose({ id: ${id} })();
  found.length ? JSON.stringify({ from: found[0].sender(), subject: found[0].subject(), body: found[0].content() }) : 'null';`;

/** The text of one inbox email, or '' if it is gone. Reading it here does not mark it as read. */
export const mailBody = async (id: number): Promise<string> =>
  ((JSON.parse(await osascript(BODY(id), { javascript: true })) as { body: string } | null)?.body ?? '').replace(/\s+/g, ' ').trim();

const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** Newest first, capped, one line each. The id lets the model ask for a message's text. */
export function describeUnread(mail: RawMail[], limit: number): string {
  if (mail.length === 0) return 'No unread email.';
  const newest = [...mail].sort((a, b) => b.received.localeCompare(a.received)).slice(0, limit);
  const lines = newest.map((message) => `[id ${message.id}] ${when.format(new Date(message.received))}, from ${message.from}: ${message.subject || '(no subject)'}`);
  return `${mail.length} unread email${mail.length === 1 ? '' : 's'}${mail.length > limit ? `, newest ${limit} shown` : ''}:\n${lines.join('\n')}`;
}

export const mailTools: Tool[] = [
  {
    name: 'unread_email',
    description: "List the user's unread email from the Mac's Mail app: sender, subject and time of each, newest first, with an id for read_email.",
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many to list (1 to 30, default 10)' } } },
    slow: true,
    run: async (args) => {
      const limit = integer(args, 'limit', { min: 1, max: 30, fallback: 10 });
      return describeUnread(await unreadMail(), limit);
    },
  },
  {
    name: 'read_email',
    description: 'Read the text of one email, by the id that unread_email listed. Reading it here does not mark it as read.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    slow: true,
    run: async (args) => {
      const id = integer(args, 'id', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: -1 });
      const message = JSON.parse(await osascript(BODY(id), { javascript: true })) as { from: string; subject: string; body: string } | null;
      if (!message) throw new Error('No email with that id is in the inbox');
      return clip(`From: ${message.from}\nSubject: ${message.subject}\n\n${message.body.replace(/\n{3,}/g, '\n\n').trim()}`, 4000);
    },
  },
];
