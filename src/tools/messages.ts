import { exec, osascript } from './exec.ts';
import { text, type Tool } from './types.ts';

// Each script takes its values as arguments (`on run`, or JSON), never pasted into the script text.
const CONTACTS = (name: string) => `
  const people = Application('Contacts').people.whose({ name: { _contains: ${JSON.stringify(name)} } })();
  JSON.stringify(people.slice(0, 5).map((one) => ({ name: one.name(), emails: one.emails().map((email) => email.value()), phones: one.phones().map((phone) => phone.value()) })));`;
const EMAIL = `on run {recipient, theSubject, theBody}
  tell application "Mail"
    set draft to make new outgoing message with properties {subject:theSubject, content:theBody, visible:false}
    tell draft to make new to recipient at end of to recipients with properties {address:recipient}
    send draft
  end tell
end run`;
const IMESSAGE = `on run {recipient, theBody}
  tell application "Messages"
    send theBody to participant recipient of (1st account whose service type = iMessage)
  end tell
end run`;

export type MessageDeps = {
  /** Runs AppleScript with arguments. */
  script?: (source: string, args: string[]) => Promise<string>;
  contacts?: (name: string) => Promise<string>;
  open?: (url: string) => Promise<unknown>;
  /** The native helper, to press Return in WhatsApp. */
  helper(args: string[]): Promise<string>;
  wait?: (ms: number) => Promise<void>;
};

const ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const said = (value: string) => (value.length > 280 ? `${value.slice(0, 280)}, and more` : value);

/**
 * Sending email (the Mail app), iMessages and texts (the Messages app) and WhatsApp messages. Every one
 * is read back and confirmed aloud first, even when Jarvis otherwise acts on its own: a message to
 * someone else cannot be taken back.
 */
export function messageTools(deps: MessageDeps): Tool[] {
  const script = deps.script ?? ((source, args) => exec('osascript', ['-e', source, ...args], { timeoutMs: 60_000 }));
  const contacts = deps.contacts ?? ((name) => osascript(CONTACTS(name), { javascript: true }));
  const open = deps.open ?? ((url) => exec('open', [url]));
  const wait = deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return [
    {
      name: 'find_contact',
      description: "Look someone up in his Contacts by name: their email addresses and phone numbers, for send_email and send_message. Use it unless he gave the address or number himself.",
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      slow: true,
      run: async (args) => {
        const found = JSON.parse(await contacts(text(args, 'name').trim())) as { name: string; emails: string[]; phones: string[] }[];
        if (found.length === 0) return `Nobody called "${String(args.name)}" is in his Contacts. Ask him for the address or number.`;
        return found.map((one) => `${one.name}: ${[...one.emails, ...one.phones].join(', ') || 'no email or phone saved'}`).join('\n');
      },
    },
    {
      name: 'send_email',
      description: 'Send an email from his Mail app. The Mac reads it back to him and asks before it goes, so call this directly once you have the address, the subject and the text; write the text as he would, signed with nothing unless he says.',
      parameters: { type: 'object', properties: { to: { type: 'string', description: 'One email address' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
      alwaysAsk: true,
      approval: (args) => `send an email to ${text(args, 'to')}, subject ${text(args, 'subject')}, saying: ${said(text(args, 'body'))}`,
      slow: true,
      run: async (args) => {
        const to = text(args, 'to').trim();
        if (!ADDRESS.test(to)) throw new Error('"to" must be one email address; look the person up with find_contact');
        await script(EMAIL, [to, text(args, 'subject'), text(args, 'body')]);
        return `Sent to ${to}.`;
      },
    },
    {
      name: 'send_message',
      description:
        'Send a text message: an iMessage or SMS through his Messages app (to a phone number or an iMessage email), or a WhatsApp message (to a phone number with its country code). The Mac reads it back to him and asks before it goes.',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', description: 'A phone number with country code, or an iMessage email' }, text: { type: 'string' }, via: { type: 'string', enum: ['imessage', 'whatsapp'], description: 'Default imessage' } },
        required: ['to', 'text'],
      },
      alwaysAsk: true,
      approval: (args) => `send a ${args.via === 'whatsapp' ? 'WhatsApp message' : 'message'} to ${text(args, 'to')}, saying: ${said(text(args, 'text'))}`,
      slow: true,
      run: async (args) => {
        const to = text(args, 'to').trim();
        const digits = to.replace(/[\s().-]/g, '');
        const phone = /^\+?\d{7,15}$/.test(digits);
        if (args.via === 'whatsapp') {
          if (!phone) throw new Error('WhatsApp needs a phone number with its country code, such as +233201234567');
          // WhatsApp has no scripting: its link opens the chat with the text typed in, and Return sends it.
          await open(`whatsapp://send?phone=${digits.replace('+', '')}&text=${encodeURIComponent(text(args, 'text'))}`);
          await wait(3000);
          await deps.helper(['key', 'return', '--app', 'WhatsApp']);
          return `Sent on WhatsApp to ${to}. Read the WhatsApp window with app_read to check it went.`;
        }
        if (!phone && !ADDRESS.test(to)) throw new Error('"to" must be a phone number or an iMessage email; look the person up with find_contact');
        await script(IMESSAGE, [phone ? digits : to, text(args, 'text')]);
        return `Sent to ${to}.`;
      },
    },
  ];
}
