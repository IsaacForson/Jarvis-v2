import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { clickRule, describePage, type Item, typeRule, webTools } from './web.ts';

const item = (over: Partial<Item>): Item => ({ ref: 1, kind: 'button', label: 'OK', secret: false, search: false, submits: false, ...over });
const url = 'https://shop.example.com/cart';

test('links, text fields and search buttons are clicked without asking', () => {
  assert.equal(clickRule(item({ kind: 'link', label: 'Delete account help' }), url), undefined);
  assert.equal(clickRule(item({ label: 'Search', search: true, submits: true }), url), undefined);
  assert.equal(clickRule(item({ label: 'Show more' }), url), undefined);
});

test('buttons that send or change something are asked about, naming the button and the site', () => {
  assert.equal(clickRule(item({ label: 'Send message', submits: true }), url), 'press "Send message" on shop.example.com');
  assert.equal(clickRule(item({ label: 'Delete' }), url), 'press "Delete" on shop.example.com');
  assert.equal(clickRule(item({ label: 'Continue', submits: true }), url), 'press "Continue" on shop.example.com');
});

test('payment buttons are refused outright', () => {
  for (const label of ['Pay now', 'Buy now', 'Place your order', 'Checkout', 'Complete purchase', 'Donate']) {
    assert.ok(clickRule(item({ label, submits: true }), url) instanceof Error, label);
  }
});

test('adding to a cart and cookie banners need no yes; checking out is refused', () => {
  assert.equal(clickRule(item({ kind: 'button', label: 'Add to Cart', submits: true }), url), undefined);
  assert.equal(clickRule(item({ kind: 'button', label: 'Accept all', consent: true }), url), undefined);
  assert.ok(clickRule(item({ kind: 'button', label: 'Proceed to checkout' }), url) instanceof Error);
  // A checkout link is refused like a button; a headline that mentions buying is just a link.
  assert.ok(clickRule(item({ kind: 'link', label: 'Buy now' }), url) instanceof Error);
  assert.equal(clickRule(item({ kind: 'link', label: 'Should you buy the new MacBook this year?' }), url), undefined);
});

test('typing: secrets are refused, sending a form is asked about, a search is not', () => {
  assert.ok(typeRule(item({ kind: 'textbox', label: 'Password', secret: true }), url, false) instanceof Error);
  assert.ok(typeRule(item({ kind: 'button' }), url, false) instanceof Error);
  assert.equal(typeRule(item({ kind: 'textbox', label: 'Message' }), url, false), undefined);
  assert.equal(typeRule(item({ kind: 'textbox', label: 'Message' }), url, true), 'send the form on shop.example.com');
  assert.equal(typeRule(item({ kind: 'textbox', label: 'Search', search: true }), url, true), undefined);
});

test('a long page is read in parts', () => {
  const page = { title: 'Long', url, text: 'a'.repeat(3000) + 'b'.repeat(500), items: [item({ kind: 'link', label: 'Home' })] };
  assert.match(describePage(page), /Text, part 1 of 2 \(use web_read/);
  assert.match(describePage(page, 2), /part 2 of 2:\nb{500}\n/);
  assert.match(describePage(page), /\[1\] link: Home/);
});

// --- The real browser against a local site ---
const PAGES: Record<string, string> = {
  '/': `<title>Home</title><main><h1>Welcome</h1><p>Fresh bread daily.</p>
        <a href="/contact">Contact us</a> <a href="/hidden" style="display:none">Hidden</a>
        <form action="/found" role="search"><input type="search" name="q" placeholder="Search the shop"><button>Search</button></form></main>`,
  '/contact': `<title>Contact</title><main><form action="/sent" method="get">
        <input name="email" placeholder="Your email"><input type="password" name="pw" placeholder="Password">
        <input name="cardnumber" placeholder="Card number"><textarea name="message" placeholder="Message"></textarea>
        <button type="submit">Send message</button><button type="submit">Pay now</button></form></main>`,
  '/found': '<title>Results</title><main>Results for your search.</main>',
  '/book': `<title>Book</title><main><form action="/booked" method="get">
        <label>Day <input type="date" name="day" aria-label="Day"></label><input type="time" name="at" aria-label="Arrival time">
        <select name="room" aria-label="Room"><option>Single</option><option>Double</option></select>
        <button type="submit">Book now</button></form></main>`,
  '/booked': '<title>Booked</title><main>Booking received.</main>',
  '/framed': `<title>Framed</title><main><p>News of the day.</p><iframe src="/consent-frame" width="600" height="300"></iframe></main>`,
  '/consent-frame': `<title>Privacy</title><div class="message">We value your privacy. <button onclick="document.body.textContent = 'Accepted'">Accept all</button></div>`,
  '/long': `<title>Long</title><div id="cookie-banner">We use cookies. <button>Accept all</button></div>
        <main><a href="/report.csv">Download the report</a>${'<p>Line</p>'.repeat(400)}<button>Load more</button></main>`,
  '/sent': '<title>Sent</title><main>Thank you, your message was sent.</main>',
};
const visits: string[] = [];
const server = createServer((req, res) => {
  visits.push(req.url ?? '');
  if (req.url === '/report.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
    return void res.end('a,b\n1,2\n');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html>${PAGES[(req.url ?? '/').split('?')[0]!] ?? '<title>Missing</title>'}`);
});
let site = '';
let profileDir = '';
let web: ReturnType<typeof webTools>;
const tool = (name: string) => web.tools.find((candidate) => candidate.name === name)!;
const ref = (page: string, label: string) => Number(new RegExp(`\\[(\\d+)\\] \\w+: ${label}`).exec(page)?.[1]);

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profileDir = await mkdtemp(join(tmpdir(), 'jarvis-web-'));
  web = webTools({ profileDir, headless: true, downloadsDir: profileDir });
});
after(async () => {
  await web.close();
  server.close();
  await rm(profileDir, { recursive: true, force: true });
});

test('opening a page returns its text and numbered controls, without hidden ones', async () => {
  const page = await tool('web_open').run({ url: `${site}/` });
  assert.match(page, /Page: Home/);
  assert.match(page, /Fresh bread daily\./);
  assert.match(page, /\] link: Contact us/);
  assert.match(page, /\] textbox: Search the shop/);
  assert.doesNotMatch(page, /Hidden/);
  await assert.rejects(tool('web_open').run({ url: 'file:///etc/passwd' }), /Only http and https/);
  assert.match(await tool('web_open').run({ url: site.replace('http://', 'HTTP://') }), /Page: Home/);
});

test('a search needs no approval and goes through', async () => {
  const page = await tool('web_open').run({ url: `${site}/` });
  const box = ref(page, 'Search the shop');
  assert.equal(tool('web_type').approval?.({ ref: box, text: 'rye', submit: true }), undefined);
  assert.match(await tool('web_type').run({ ref: box, text: 'rye', submit: true }), /Results for your search/);
  assert.ok(visits.includes('/found?q=rye'));
});

test('following a link, then the form rules on the real page', async () => {
  const home = await tool('web_open').run({ url: `${site}/` });
  const contact = await tool('web_click').run({ ref: ref(home, 'Contact us') });
  assert.match(contact, /Page: Contact/);

  await assert.rejects(tool('web_type').run({ ref: ref(contact, 'Password'), text: 'hunter2' }), /password or payment field/);
  await assert.rejects(tool('web_type').run({ ref: ref(contact, 'Card number'), text: '4111' }), /password or payment field/);
  await assert.rejects(tool('web_click').run({ ref: ref(contact, 'Pay now') }), /spend money/);
  assert.equal(tool('web_click').approval?.({ ref: ref(contact, 'Pay now') }), undefined, 'a refusal is not something to ask about');

  await tool('web_type').run({ ref: ref(contact, 'Message'), text: 'Hello there' });
  const send = ref(await tool('web_read').run({}), 'Send message');
  assert.match(tool('web_click').approval?.({ ref: send }) ?? '', /^press "Send message" on 127\.0\.0\.1/);
  assert.ok(!visits.some((visit) => visit.startsWith('/sent')), 'nothing is sent before approval');
  assert.match(await tool('web_click').run({ ref: send }), /your message was sent/);
  assert.ok(visits.some((visit) => visit.includes('message=Hello+there')));

  assert.match(await tool('web_back').run({}), /Page: Contact/);
  await assert.rejects(tool('web_click').run({ ref: 99 }), /no item 99/);
});

test('booking: fields say what format they need, dropdowns are chosen by text, and booking is asked about', async () => {
  const page = await tool('web_open').run({ url: `${site}/book` });
  assert.match(page, /\] textbox \(date, YYYY-MM-DD\): Day/);
  assert.match(page, /\] textbox \(time, HH:MM 24-hour\): Arrival time/);
  const number = (label: string) => Number(new RegExp(`^\\[(\\d+)\\] .*: ${label}$`, 'm').exec(page)?.[1]);
  await tool('web_type').run({ ref: number('Day'), text: '2026-12-24' });
  await tool('web_type').run({ ref: number('Arrival time'), text: '19:45' });
  await tool('web_select').run({ ref: number('Room'), option: 'Double' });
  await assert.rejects(tool('web_select').run({ ref: number('Room'), option: 'Suite' }), /The options are: Single, Double/);
  const book = number('Book now');
  assert.match(tool('web_click').approval?.({ ref: book }) ?? '', /^press "Book now"/);
  assert.match(await tool('web_click').run({ ref: book }), /Booking received/);
  assert.ok(visits.some((visit) => visit === '/booked?day=2026-12-24&at=19%3A45&room=Double'));
});

test('long pages scroll to the end and back, cookie banners are accepted unasked, downloads are saved', async () => {
  const page = await tool('web_open').run({ url: `${site}/long` });
  assert.match(page, /Scrolled 0% down a page \d+ screens long/);
  const accept = ref(page, 'Accept all');
  assert.equal(tool('web_click').approval?.({ ref: accept }), undefined, 'a cookie banner needs no yes');
  assert.match(await tool('web_scroll').run({ direction: 'bottom' }), /Scrolled 100% down/);
  assert.match(await tool('web_scroll').run({ direction: 'up', screens: 2 }), /Scrolled (9\d)% down/);
  assert.match(await tool('web_scroll').run({ direction: 'top' }), /Scrolled 0% down/);
  const clicked = await tool('web_click').run({ ref: ref(await tool('web_read').run({}), 'Download the report') });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.match(clicked + (await tool('web_read').run({})), /Downloaded: ~\/Downloads\/report\.csv\./, 'reported once, by the next reading');
  assert.equal(await readFile(join(profileDir, 'report.csv'), 'utf8'), 'a,b\n1,2\n');
});

test('site permissions are allowed and blocked; the camera is asked about first', async () => {
  await tool('web_open').run({ url: `${site}/` });
  assert.match(tool('web_permission').approval?.({ permission: 'camera', allow: true }) ?? '', /use your camera/);
  assert.equal(tool('web_permission').approval?.({ permission: 'notifications', allow: true }), undefined);
  assert.match(await tool('web_permission').run({ permission: 'notifications', allow: true }), /Allowed notifications for 127\.0\.0\.1/);
  assert.match(await tool('web_permission').run({ permission: 'notifications', allow: false }), /Blocked notifications/);
});

test('controls inside a frame, such as a consent dialog, are listed and clicked', async () => {
  const page = await tool('web_open').run({ url: `${site}/framed` });
  assert.match(page, /Text, part 1 of 1:\n\[In a frame from 127\.0\.0\.1:\d+\]\nWe value your privacy\. Accept all\n\[End of frame\]\n\nNews of the day\./);
  const accept = ref(page, 'Accept all');
  assert.ok(accept > 0);
  await tool('web_click').run({ ref: accept });
  assert.doesNotMatch(await tool('web_read').run({}), /Accept all/, 'the click landed inside the frame');
});
