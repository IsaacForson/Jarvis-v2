import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { type BrowserContext, chromium, type Frame, type Page } from 'playwright-core';
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
  /** What a field expects, when it is particular: date, time, email, number and the like. */
  format?: string;
  /** A button of a cookie or consent banner: harmless to accept or decline. */
  consent?: boolean;
  /** Which frame of the page it is in, when not the page itself (cookie banners and embedded forms often are). */
  frame?: number;
};
type Snapshot = {
  title: string;
  url: string;
  text: string;
  items: Item[];
  scroll?: { top: number; height: number; view: number };
  /** The video on the page, if any: whether it plays, and where it is, in seconds. */
  media?: { playing: boolean; at: number; length: number; muted: boolean } | null;
  /** Files saved since the last look. */
  downloads?: string[];
};

// Runs inside the page (or a frame in it). Numbers every visible control from `start` and tags it, so a later click can find it again.
const LOOK = (start = 0) => `((start) => {
  document.querySelectorAll('[data-jarvis-ref]').forEach((el) => el.removeAttribute('data-jarvis-ref'));
  const shown = (el) => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const words = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const isSearch = (el) => el && (el.type === 'search' || el.getAttribute('role') === 'searchbox' || /^(q|query|search|search_query|search_term|k|p)$/i.test(el.getAttribute('name') || ''));
  const CONSENT = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=gdpr i],[class*=gdpr i],[aria-label*=cookie i],[aria-label*=consent i]';
  const found = [];
  for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [role=searchbox], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option], [contenteditable=true]')) {
    if (!shown(el) || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    const kind = tag === 'a' || role === 'link' ? 'link'
      : tag === 'select' ? 'dropdown'
      : type === 'checkbox' || type === 'radio' ? type
      : role === 'checkbox' || role === 'switch' ? 'checkbox'
      : tag === 'textarea' || role === 'textbox' || role === 'searchbox' || el.isContentEditable || (tag === 'input' && !['submit', 'button', 'image', 'reset', 'file'].includes(type)) ? 'textbox'
      : 'button';
    const label = words(el);
    if (!label && kind !== 'textbox') continue;
    const form = el.closest('form');
    const searchForm = !!form && (form.getAttribute('role') === 'search' || [...form.querySelectorAll('input')].some(isSearch));
    const hints = (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (el.id || '');
    const box = el.getBoundingClientRect();
    found.push({
      el,
      // How far off screen: what is in view, or nearly, is listed first when there are too many to list.
      distance: box.bottom < 0 ? -box.bottom : box.top > innerHeight ? box.top - innerHeight : 0,
      item: {
        kind, label,
        secret: type === 'password' || /cc-|card.?num|cvv|cvc|security.?code|passw/i.test(hints),
        search: isSearch(el) || (kind === 'button' && searchForm),
        submits: kind === 'button' && !!form && type !== 'button' && type !== 'reset',
        consent: kind !== 'textbox' && (!!el.closest(CONSENT) || /cookie/i.test(label)),
        ...(kind === 'textbox' && ['date', 'time', 'datetime-local', 'month', 'week', 'number', 'email', 'tel', 'url'].includes(type) ? { format: type } : {}),
      },
    });
  }
  const keep = new Set([...found].sort((a, b) => a.distance - b.distance).slice(0, 150));
  const items = found.filter((one) => keep.has(one)).map((one, index) => {
    one.el.setAttribute('data-jarvis-ref', String(start + index + 1));
    return { ref: start + index + 1, ...one.item };
  });
  const main = document.querySelector('main, article, [role=main]') || document.body;
  const video = [...document.querySelectorAll('video')].find((one) => one.duration > 0) || null;
  const scroller = document.scrollingElement || document.documentElement;
  return {
    title: document.title, url: location.href, text: (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(), items,
    scroll: { top: Math.round(scroller.scrollTop), height: Math.round(scroller.scrollHeight), view: innerHeight },
    media: video ? { playing: !video.paused && !video.ended, at: Math.round(video.currentTime), length: Math.round(video.duration), muted: video.muted } : null,
  };
})(${start})`;

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
  // Checkout "buttons" are often links. Only short labels count, so a headline that mentions buying still opens.
  if (item.kind === 'link' && PAYMENT.test(item.label) && item.label.trim().split(/\s+/).length <= 4) return new Error('That leads to paying, which I never do. He must press it himself.');
  if (item.kind === 'link' || item.kind === 'textbox' || item.search || item.consent) return undefined;
  // Filling a cart is undone with one click; only checking out is not.
  if (/^\s*add to (cart|basket|bag|trolley|wish ?list)\b/i.test(item.label)) return undefined;
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
  const formats: Record<string, string> = { date: 'date, YYYY-MM-DD', time: 'time, HH:MM 24-hour', 'datetime-local': 'date and time, YYYY-MM-DDTHH:MM', month: 'month, YYYY-MM', week: 'week, YYYY-Www' };
  const items = page.items.map((item) => `[${item.ref}] ${item.kind}${item.format ? ` (${formats[item.format] ?? item.format})` : ''}: ${item.label || '(no label)'}`).join('\n');
  const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const where = page.scroll && page.scroll.height > page.scroll.view * 1.2
    ? `Scrolled ${Math.round((page.scroll.top / Math.max(1, page.scroll.height - page.scroll.view)) * 100)}% down a page ${Math.round(page.scroll.height / page.scroll.view)} screens long (web_scroll moves; the list below favours what is in view).`
    : '';
  const media = page.media ? `Video: ${page.media.playing ? 'playing' : 'paused'} at ${minutes(page.media.at)} of ${minutes(page.media.length)}${page.media.muted ? ', muted' : ''}.` : '';
  const downloads = page.downloads?.length ? `Downloaded: ${page.downloads.join(', ')}.` : '';
  return [
    `Page: ${page.title || '(no title)'}`,
    `Address: ${page.url}`,
    ...[where, media, downloads].filter(Boolean),
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
 * `jobTools` are the same tools working in a second window of their own, so a background job and a
 * spoken request can browse at the same time without steering each other's page.
 */
export function webTools(options: { profileDir: string; headless?: boolean; downloadsDir?: string }): { tools: Tool[]; jobTools: Tool[]; close(): Promise<void> } {
  let context: BrowserContext | undefined;
  /** Permissions allowed per site, so one can be withdrawn without losing the rest. */
  const allowed = new Map<string, Set<string>>();
  const downloadsDir = options.downloadsDir ?? join(homedir(), 'Downloads');
  const watched = new WeakSet<Page>();
  /** Pages that belong to the jobs' window; the spoken side never adopts them. */
  const jobPages = new WeakSet<Page>();
  /** Each side's way of taking over a tab that one of its own links opened. */
  const adopters: ((opened: Page, opener: Page | null) => void)[] = [];
  const open = async (): Promise<BrowserContext> => {
    if (context) return context;
    const launched = await chromium.launchPersistentContext(options.profileDir, { channel: 'chrome', headless: options.headless ?? false, acceptDownloads: true, viewport: null }).catch((error: unknown) => {
      throw new Error(`I could not open Chrome (${error instanceof Error ? error.message.split('\n')[0] : error}). Google Chrome must be installed.`);
    });
    launched.on('close', () => (context = undefined)); // the user closed the window
    launched.on('page', (opened) => void opened.opener().then((opener) => adopters.forEach((adopt) => adopt(opened, opener)), () => {}));
    launched.setDefaultTimeout(15_000);
    return (context = launched);
  };
  /** A new browser window, not a tab: a tab would come to the front of the window the user is watching. */
  const newWindow = async (live: BrowserContext): Promise<Page> => {
    try {
      const cdp = await live.newCDPSession(live.pages()[0] ?? (await live.newPage()));
      const [opened] = await Promise.all([live.waitForEvent('page', { timeout: 5000 }), cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })]);
      await cdp.detach().catch(() => {});
      return opened;
    } catch {
      return live.newPage(); // shortcut: falls back to a tab, which steals the front; fine for the rare browser that refuses a window
    }
  };

  const side = (forJobs: boolean): Tool[] => {
    let page: Page | undefined;
    let last: Snapshot | undefined;
    let downloaded: string[] = [];
    let frames: Frame[] = [];
    const follow = (opened: Page) => {
      page = opened;
      if (forJobs) jobPages.add(opened);
      if (watched.has(opened)) return;
      watched.add(opened);
      // Downloads are kept in the Downloads folder under the name the site gives, never over an existing file.
      opened.on('download', (download) => {
        void (async () => {
          const name = download.suggestedFilename();
          let target = join(downloadsDir, name);
          for (let copy = 2; existsSync(target); copy++) target = join(downloadsDir, `${basename(name, extname(name))} ${copy}${extname(name)}`);
          await download.saveAs(target);
          downloaded.push(`~/Downloads/${basename(target)}`);
        })().catch((error: unknown) => downloaded.push(`a download that failed (${error instanceof Error ? error.message : error})`));
      });
    };

    adopters.push((opened, opener) => {
      if (opener && opener === page) follow(opened); // a link opened a new tab: follow it
    });
    const current = async (): Promise<Page> => {
      const live = await open();
      if (!page || page.isClosed()) {
        last = undefined;
        follow(forJobs ? await newWindow(live) : (live.pages().filter((one) => !jobPages.has(one)).at(-1) ?? (await live.newPage())));
      }
      return page!;
    };
    const look = async (part = 1): Promise<string> => {
      const now = await current();
      await now.waitForLoadState('domcontentloaded').catch(() => {});
      const snapshot = (await now.evaluate(LOOK())) as Snapshot;
      // Frames big enough to matter: consent dialogs, embedded forms and players often live in one.
      frames = now.frames();
      for (const [index, frame] of frames.entries()) {
        if (index === 0 || snapshot.items.length >= 200) continue;
        const box = await frame.frameElement().then((element) => element.boundingBox(), () => null).catch(() => null);
        if (!box || box.width < 200 || box.height < 80) continue;
        const inner = (await Promise.race([frame.evaluate(LOOK(snapshot.items.length)), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => undefined)) as Snapshot | undefined;
        if (!inner?.items.length) continue;
        // Consent managers serve their banners from their own sites, in a frame.
        const consent = /sourcepoint|consensu|onetrust|cookielaw|cookiebot|trustarc|didomi|quantcast|usercentrics|privacy-mgmt|consent/i.test(frame.url());
        snapshot.items.push(...inner.items.map((one) => ({ ...one, frame: index, ...(consent && one.kind !== 'textbox' ? { consent: true } : {}) })));
        // First, since a dialog in a frame usually sits on top of the page.
        snapshot.text = `[In a frame from ${host(frame.url())}]\n${inner.text.slice(0, 1000)}\n[End of frame]\n\n${snapshot.text}`;
      }
      last = { ...snapshot, downloads: downloaded };
      downloaded = [];
      return describePage(last, part);
    };
    /** The element an item names, in the page or in the frame it was found in. */
    const locate = (now: Page, target: Item) => (target.frame !== undefined && frames[target.frame] ? frames[target.frame]! : now).locator(`[data-jarvis-ref="${target.ref}"]`);
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
          const now = await current();
          await now.goto(url.href, { waitUntil: 'domcontentloaded' });
          // Cookie banners and sign-in prompts often arrive a moment after the page.
          await now.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
          await now.waitForTimeout(1500);
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
          await locate(now, target).click();
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
          const field = locate(now, target);
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
          const field = locate(now, target);
          // Matched here first: Playwright waits its full timeout for an option that does not exist.
          const options = (await field.locator('option').allInnerTexts()).map((one) => one.trim());
          const wanted = option.trim().toLowerCase();
          const match = options.find((one) => one.toLowerCase() === wanted) ?? options.find((one) => one.toLowerCase().includes(wanted));
          if (!match) throw new Error(`No option "${option}". The options are: ${options.join(', ')}`);
          await field.selectOption({ label: match });
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
        description:
          'Scroll the open page: down or up by a screen, or to the top or bottom, then read it again. Use it to see more of a long page, load more results, or reach buttons further down; the reading says how far down the page you are.',
        parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] }, screens: { type: 'integer', description: 'How many screens to move up or down (default 1)' } }, required: ['direction'] },
        run: async (args) => {
          const now = await current();
          const screens = integer(args, 'screens', { min: 1, max: 20, fallback: 1 });
          if (args.direction === 'top' || args.direction === 'bottom') {
            await now.evaluate((end) => {
              const scroller = document.scrollingElement ?? document.documentElement;
              scroller.scrollTo({ top: end === 'top' ? 0 : scroller.scrollHeight });
            }, args.direction);
          } else {
            // The mouse wheel, as a person would, so pages that load more on scroll do so.
            const height = await now.evaluate(() => innerHeight);
            await now.mouse.wheel(0, (args.direction === 'up' ? -1 : 1) * screens * height * 0.85);
          }
          await settle(now);
          return look();
        },
      },
      {
        name: 'web_permission',
        description:
          "Allow or block a permission for the open site, such as location, notifications, camera or microphone, when the site asks for it or needs it. Blocked is the default. Allowing the camera or microphone is asked about first.",
        parameters: {
          type: 'object',
          properties: { permission: { type: 'string', enum: ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'midi'] }, allow: { type: 'boolean' } },
          required: ['permission', 'allow'],
        },
        approval: (args) => (args.allow === true && (args.permission === 'camera' || args.permission === 'microphone') ? `let ${host(last?.url ?? '')} use your ${String(args.permission)}` : undefined),
        run: async (args) => {
          const permission = text(args, 'permission');
          const now = await current();
          const origin = new URL(now.url()).origin;
          const forSite = allowed.get(origin) ?? new Set<string>();
          if (args.allow === true) forSite.add(permission);
          else forSite.delete(permission);
          allowed.set(origin, forSite);
          // Playwright can only withdraw everything, so the rest is given back afterwards.
          const live = await open();
          await live.clearPermissions();
          for (const [site, granted] of allowed) if (granted.size) await live.grantPermissions([...granted], { origin: site });
          return `${args.allow === true ? 'Allowed' : 'Blocked'} ${permission} for ${host(origin)}. Reload the page if it was waiting.`;
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
    return tools;
  };
  return { tools: side(false), jobTools: side(true), close: async () => void (await context?.close().catch(() => {})) };
}
