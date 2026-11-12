import { type BrowserContext, chromium, type Page } from 'playwright-core';
import { PAYMENT, RISKY } from './rules.ts';
import { integer, text, type Tool } from './types.ts';

/** One thing on a page that can be clicked or typed into, as found by the last look at the page. */
export type Item = {
  ref: number;
  kind: 'link' | 'button' | 'textbox' | 'checkbox' | 'radio' | 'dropdown';
  label: string;
  /** A password or payment-card field: never typed into. */
  secret: boolean;
  /** A search box, or a button of a search form: using it changes nothing. */
  search: boolean;
  /** A button that sends a form. */
  submits: boolean;
};
type Snapshot = { title: string; url: string; text: string; items: Item[] };

// Runs inside the page. Numbers every visible control and tags it, so a later click can find it again.
const LOOK = `(() => {
  document.querySelectorAll('[data-jarvis-ref]').forEach((el) => el.removeAttribute('data-jarvis-ref'));
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const words = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const isSearch = (el) => el && (el.type === 'search' || el.getAttribute('role') === 'searchbox' || /^(q|query|search|search_query|p)$/i.test(el.getAttribute('name') || ''));
  const items = [];
  for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [role=searchbox], [contenteditable=true]')) {
    if (items.length >= 120) break;
    if (!shown(el) || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    const kind = tag === 'a' || role === 'link' ? 'link'
      : tag === 'select' ? 'dropdown'
      : type === 'checkbox' || type === 'radio' ? type
      : tag === 'textarea' || role === 'textbox' || role === 'searchbox' || el.isContentEditable || (tag === 'input' && !['submit', 'button', 'image', 'reset', 'file'].includes(type)) ? 'textbox'
      : 'button';
    const label = words(el);
    if (!label && kind !== 'textbox') continue;
    const form = el.closest('form');
    const searchForm = !!form && (form.getAttribute('role') === 'search' || [...form.querySelectorAll('input')].some(isSearch));
    const hints = (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.id || '');
    el.setAttribute('data-jarvis-ref', String(items.length + 1));
    items.push({
      ref: items.length + 1, kind, label,
      secret: type === 'password' || /cc-|card.?num|cvv|cvc|security.?code|passw/i.test(hints),
      search: isSearch(el) || (kind === 'button' && searchForm),
      submits: kind === 'button' && !!form && type !== 'button' && type !== 'reset',
    });
  }
  const main = document.querySelector('main, article, [role=main]') || document.body;
  return { title: document.title, url: location.href, text: (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(), items };
})()`;

const ROBOT_CHECK = /captcha|unusual traffic|are you a (robot|human)|verify you are human|bot check|select all squares/i;
const PART = 3000;
const host = (url: string) => {
  try {
    return new URL(url).host || 'this page';
  } catch {
    return 'this page';
  }
};

/** What to ask before a click, undefined if it is harmless, or an Error if it must never happen. */
export function clickRule(item: Item, url: string): string | Error | undefined {
  if (item.kind === 'link' || item.kind === 'textbox' || item.search) return undefined;
  if (PAYMENT.test(item.label)) return new Error('That would spend money, which I never do. He must press it himself.');
  if (item.submits || RISKY.test(item.label)) return `press "${item.label}" on ${host(url)}`;
  return undefined;
}

/** The same for typing: card and password fields are refused; sending a form is asked about, a search is not. */
export function typeRule(item: Item, url: string, submit: boolean): string | Error | undefined {
  if (item.kind !== 'textbox') return new Error('That is not a text field.');
  if (item.secret) return new Error('That is a password or payment field, which I never type into. He must fill it in himself, in the browser window.');
  return submit && !item.search ? `send the form on ${host(url)}` : undefined;
}

export function describePage(page: Snapshot, part = 1): string {
  const parts = Math.max(1, Math.ceil(page.text.length / PART));
  const shown = Math.min(part, parts);
  const items = page.items.map((item) => `[${item.ref}] ${item.kind}: ${item.label || '(no label)'}`).join('\n');
  return [
    `Page: ${page.title || '(no title)'}`,
    `Address: ${page.url}`,
    '',
    `Text, part ${shown} of ${parts}${parts > shown ? ' (use web_read with a part number for more)' : ''}:`,
    page.text.slice((shown - 1) * PART, shown * PART) || '(no text)',
    '',
    page.items.length ? `Things on the page you can use, by number:\n${items}` : 'Nothing on the page can be clicked or typed into.',
  ].join('\n');
}

/**
 * Web browsing in a real Chrome window with its own profile, so sites the user signs in to there stay
 * signed in, and Jarvis never touches the user's everyday browser. The window opens on first use.
 */
export function webTools(options: { profileDir: string; headless?: boolean }): { tools: Tool[]; close(): Promise<void> } {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let last: Snapshot | undefined;

  const current = async (): Promise<Page> => {
    if (!context) {
      context = await chromium.launchPersistentContext(options.profileDir, { channel: 'chrome', headless: options.headless ?? false, acceptDownloads: false, viewport: null }).catch((error: unknown) => {
        throw new Error(`I could not open Chrome (${error instanceof Error ? error.message.split('\n')[0] : error}). Google Chrome must be installed.`);
      });
      context.on('close', () => (context = page = last = undefined)); // the user closed the window
      context.on('page', (opened) => (page = opened)); // a link opened a new tab: follow it
      context.setDefaultTimeout(15_000);
    }
    if (!page || page.isClosed()) page = context.pages().at(-1) ?? (await context.newPage());
    return page;
  };
  const look = async (part = 1): Promise<string> => {
    const now = await current();
    await now.waitForLoadState('domcontentloaded').catch(() => {});
    last = (await now.evaluate(LOOK)) as Snapshot;
    return describePage(last, part);
  };
  const item = (args: Record<string, unknown>): Item => {
    const ref = integer(args, 'ref', { min: 1, max: 500, fallback: 0 });
    const found = last?.items.find((candidate) => candidate.ref === ref);
    if (!found) throw new Error(`There is no item ${ref} on the page as last read. Read the page again and use a number from that list.`);
    return found;
  };
  // A rule is checked twice: once to decide whether to ask, and again when running, where a refusal throws.
  const ask = (rule: () => string | Error | undefined): string | undefined => {
    try {
      const outcome = rule();
      return typeof outcome === 'string' ? outcome : undefined;
    } catch {
      return undefined; // bad arguments: run() reports them
    }
  };
  const refuse = (outcome: string | Error | undefined) => {
    if (outcome instanceof Error) throw outcome;
  };
  const settle = async (now: Page) => {
    await now.waitForLoadState('domcontentloaded').catch(() => {});
    await now.waitForTimeout(600); // let the page react to the click or the typing
  };
  const number = { type: 'integer', description: 'The number of the item, from the list in the last page reading' };

  const tools: Tool[] = [
    {
      name: 'web_search',
      description: 'Search the web. Returns the results page: titles, addresses and summaries, with numbered links to open.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      slow: true,
      run: async (args) => {
        const query = encodeURIComponent(text(args, 'query'));
        const now = await current();
        // Tested 12 Nov 2026 with this browser: DuckDuckGo and Bing answer; Google and DuckDuckGo's
        // plain-HTML page show a robot check. If the first shows one too, the second is tried.
        for (const engine of ['https://duckduckgo.com/?q=', 'https://www.bing.com/search?q=']) {
          await now.goto(engine + query, { waitUntil: 'domcontentloaded' });
          await now.waitForTimeout(1200); // results are filled in after the page loads
          const page = await look();
          if (last && last.items.length > 5 && !ROBOT_CHECK.test(last.text)) return page;
        }
        throw new Error('The search engines asked for a robot check, so I could not search. Opening a site directly still works.');
      },
    },
    {
      name: 'web_open',
      description:
        'Open a web address in your own browser window and read the page: its text and a numbered list of links, buttons and fields. Use this whenever you need to read a page or do something on it.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'A full http or https address' } }, required: ['url'] },
      slow: true,
      run: async (args) => {
        const address = text(args, 'url').trim();
        // "example.com/page" is how people and models say addresses; treat it as https.
        const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https addresses can be opened');
        await (await current()).goto(url.href, { waitUntil: 'domcontentloaded' });
        return look();
      },
    },
    {
      name: 'web_read',
      description: 'Read the page that is open in the browser now: after the user changed it, or to get a later part of a long page.',
      parameters: { type: 'object', properties: { part: { type: 'integer', description: 'Which part of the text (default 1)' } } },
      run: async (args) => look(integer(args, 'part', { min: 1, max: 200, fallback: 1 })),
    },
    {
      name: 'web_click',
      description: 'Click a link, button, checkbox or dropdown on the open page, by its number, then read the page again. Buttons that send or change something are confirmed with the user first; payment buttons are never pressed.',
      parameters: { type: 'object', properties: { ref: number }, required: ['ref'] },
      approval: (args) => ask(() => clickRule(item(args), last?.url ?? '')),
      slow: true,
      run: async (args) => {
        const target = item(args);
        refuse(clickRule(target, last?.url ?? ''));
        const now = await current();
        await now.locator(`[data-jarvis-ref="${target.ref}"]`).click();
        await settle(now);
        return look();
      },
    },
    {
      name: 'web_type',
      description: 'Type into a text field on the open page, by its number, replacing what is there; set submit to press Enter afterwards. Sending a form is confirmed with the user first (a search is not). Password and payment fields are never typed into.',
      parameters: { type: 'object', properties: { ref: number, text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after typing' } }, required: ['ref', 'text'] },
      approval: (args) => ask(() => typeRule(item(args), last?.url ?? '', args.submit === true)),
      slow: true,
      run: async (args) => {
        const target = item(args);
        refuse(typeRule(target, last?.url ?? '', args.submit === true));
        if (typeof args.text !== 'string') throw new Error('"text" must be text');
        const now = await current();
        const field = now.locator(`[data-jarvis-ref="${target.ref}"]`);
        await field.fill(args.text);
        if (args.submit === true) await field.press('Enter');
        await settle(now);
        return look();
      },
    },
    {
      name: 'web_select',
      description: 'Choose an option in a dropdown on the open page, by the dropdown number and the option text as shown, then read the page again.',
      parameters: { type: 'object', properties: { ref: number, option: { type: 'string', description: 'The option text' } }, required: ['ref', 'option'] },
      slow: true,
      run: async (args) => {
        const target = item(args);
        if (target.kind !== 'dropdown') throw new Error('That is not a dropdown. Click it instead.');
        const option = text(args, 'option');
        const now = await current();
        const field = now.locator(`[data-jarvis-ref="${target.ref}"]`);
        await field.selectOption({ label: option }).catch(() => field.selectOption(option)).catch(async () => {
          const options = await field.locator('option').allInnerTexts();
          throw new Error(`No option "${option}". The options are: ${options.map((one) => one.trim()).join(', ')}`);
        });
        await settle(now);
        return look();
      },
    },
    {
      name: 'web_key',
      description: 'Press a key on the open page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+a", then read the page again. Enter is confirmed with the user first, as it may send a form.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      approval: (args) => (typeof args.key === 'string' && /enter|return/i.test(args.key) ? `press Enter on ${host(last?.url ?? '')}, which may send a form` : undefined),
      run: async (args) => {
        const now = await current();
        await now.keyboard.press(text(args, 'key'));
        await settle(now);
        return look();
      },
    },
    {
      name: 'web_scroll',
      description: 'Scroll the open page down or up, so that more of it loads (long feeds, lazy pages), then read it again.',
      parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] },
      run: async (args) => {
        const now = await current();
        await now.mouse.wheel(0, args.direction === 'up' ? -1500 : 1500);
        await settle(now);
        return look();
      },
    },
    {
      name: 'web_back',
      description: 'Go back to the previous page in the browser, then read it.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        await (await current()).goBack({ waitUntil: 'domcontentloaded' });
        return look();
      },
    },
  ];
  return { tools, close: async () => void (await context?.close().catch(() => {})) };
}
