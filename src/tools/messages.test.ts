import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageTools } from './messages.ts';

const setup = () => {
  const sent: string[][] = [];
  const done: string[] = [];
  const tools = messageTools({
    script: async (_source, args) => (sent.push(args), ''),
    contacts: async (name) => JSON.stringify(name === 'Dana' ? [{ name: 'Dana Smith', emails: ['dana@work.com'], phones: ['+233 20 123 4567'] }] : []),
    open: async (url) => void done.push(`open ${url}`),
    helper: async (args) => (done.push(args.join(' ')), '{}'),
    wait: async () => {},
  });
  return { tool: (name: string) => tools.find((one) => one.name === name)!, sent, done };
};

test('a contact is looked up by name; an unknown one says so', async () => {
  const { tool } = setup();
  assert.equal(await tool('find_contact').run({ name: 'Dana' }), 'Dana Smith: dana@work.com, +233 20 123 4567');
  assert.match(await tool('find_contact').run({ name: 'Zed' }), /Nobody called "Zed"/);
});

test('an email is read back in full, always asked about, and sent to one valid address only', async () => {
  const { tool, sent } = setup();
  const email = tool('send_email');
  assert.equal(email.alwaysAsk, true);
  assert.equal(email.approval?.({ to: 'dana@work.com', subject: 'Lunch', body: 'Are you free at one?' }), 'send an email to dana@work.com, subject Lunch, saying: Are you free at one?');
  assert.equal(await email.run({ to: 'dana@work.com', subject: 'Lunch', body: 'Are you free at one?' }), 'Sent to dana@work.com.');
  assert.deepEqual(sent, [['dana@work.com', 'Lunch', 'Are you free at one?']]);
  await assert.rejects(email.run({ to: 'Dana', subject: 'x', body: 'y' }), /one email address/);
  await assert.rejects(email.run({ to: 'a@b.com, c@d.com', subject: 'x', body: 'y' }), /one email address/);
});

test('a message goes by iMessage or WhatsApp, to a real number, after being read back', async () => {
  const { tool, sent, done } = setup();
  const message = tool('send_message');
  assert.equal(message.alwaysAsk, true);
  assert.equal(message.approval?.({ to: '+233 20 123 4567', text: 'Running late', via: 'whatsapp' }), 'send a WhatsApp message to +233 20 123 4567, saying: Running late');
  await message.run({ to: '+233 20 123 4567', text: 'Running late' });
  assert.deepEqual(sent, [['+233201234567', 'Running late']]);
  await message.run({ to: '+233 20 123 4567', text: 'Running late & sorry', via: 'whatsapp' });
  assert.deepEqual(done, ['open whatsapp://send?phone=233201234567&text=Running%20late%20%26%20sorry', 'key return --app WhatsApp']);
  await assert.rejects(message.run({ to: 'Dana', text: 'hi' }), /phone number or an iMessage email/);
  await assert.rejects(message.run({ to: 'dana@work.com', text: 'hi', via: 'whatsapp' }), /country code/);
});
