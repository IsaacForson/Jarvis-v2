import { exec } from './exec.ts';
import { PAYMENT, RISKY } from './rules.ts';
import { clip, integer, text, type Tool } from './types.ts';

/** A control in an app's window, as the native helper reports it. `path` is the route back to it. */
export type Control = { path: string; role: string; label: string; secure: boolean; value?: string };
type Window = { app: string; window: string; items: Control[]; texts: string[] };

// Apps where pressing Return sends something to another person.
const MESSAGING = /messages|mail|slack|whatsapp|telegram|discord|teams|signal|outlook|messenger|spark|zoom|skype/i;

const kind = (role: string) => role.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** What to ask before pressing a control, undefined if it is harmless, or an Error if it must never happen. */
export function pressRule(control: Control, app: string): string | Error | undefined {
  if (PAYMENT.test(control.label)) return new Error('That would spend money, which I never do. He must press it himself.');
  return RISKY.test(control.label) ? `press "${control.label}" in ${app}` : undefined;
}

/** The same for a key combination: sending, deleting and quitting are asked about. `app` is the one in front, if known. */
export function keyRule(keys: string, app: string | undefined): string | undefined {
  const parts = keys.toLowerCase().split('+');
  const key = parts.at(-1) ?? '';
  const command = parts.includes('cmd') || parts.includes('command');
  const where = app ?? 'the app in front';
  if ((key === 'return' || key === 'enter') && (!app || MESSAGING.test(app))) return `press Return in ${where}, which may send a message`;
  if (command && (key === 'delete' || key === 'backspace')) return `press Command-Delete in ${where}, which may delete something`;
  if (command && key === 'q') return `quit ${where}`;
  return undefined;
}

export function describeWindow(window: Window): string {
  const controls = window.items.map((item, index) => {
    // The label is quoted so a button labelled "7" is not mistaken for control number 7.
    const name = item.label ? `${kind(item.role)} "${item.label}"` : kind(item.role);
    const holds = item.secure ? ' (password field)' : item.value ? ` (now: ${item.value.slice(0, 80)})` : '';
    return `[${index + 1}] ${name}${holds}`;
  });
  return [
    `App: ${window.app}${window.window ? `, window "${window.window}"` : ''}`,
    '',
    `Text in the window: ${clip([...new Set(window.texts)].join(' | '), 2500) || '(none)'}`,
    '',
    controls.length ? `Controls you can use, by number:\n${controls.join('\n')}` : 'The window shows no controls I can use. Try read_screen to look at it instead.',
  ].join('\n');
}

/**
 * Working inside any Mac app: read a window's controls, press them, type into fields, send keystrokes.
 * `helper` runs the native accessibility program (dist/ax) with the given arguments and returns its output.
 */
export function appTools(helper: (args: string[]) => Promise<string>, open: (app: string) => Promise<unknown> = (app) => exec('open', ['-a', app])): Tool[] {
  let last: Window | undefined;

  const read = async (app?: string): Promise<string> => {
    last = JSON.parse(await helper(['tree', ...(app ? ['--app', app] : [])])) as Window;
    return describeWindow(last);
  };
  const reread = async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 500)); // let the app react first
    return read(last?.app);
  };
  const byNumber = (ref: unknown): Control => {
    const found = typeof ref === 'number' && Number.isInteger(ref) ? last?.items[ref - 1] : undefined;
    if (!found) throw new Error(`There is no control ${String(ref)} in the window as last read. Read the window again and use a number from that list.`);
    return found;
  };
  const control = (args: Record<string, unknown>): Control => byNumber(integer(args, 'ref', { min: 1, max: 500, fallback: 0 }));
  const byLabel = (label: unknown): Control => {
    const wanted = typeof label === 'string' ? label.trim().toLowerCase() : '';
    const matches = (last?.items ?? []).filter((item) => item.label.toLowerCase() === wanted);
    if (!wanted || matches.length === 0) throw new Error(`No control is labelled "${String(label)}" in the window as last read. Use a label exactly as the reading shows it.`);
    if (matches.length > 1) throw new Error(`${matches.length} controls are labelled "${String(label)}". Use their numbers with refs instead.`);
    return matches[0]!;
  };
  /** The controls an app_click names: by label (`labels`), or by number, one (`ref`) or several (`refs`). */
  const controls = (args: Record<string, unknown>): Control[] => {
    if (args.labels !== undefined) {
      if (!Array.isArray(args.labels) || args.labels.length < 1 || args.labels.length > 20) throw new Error('"labels" must be a list of 1 to 20 control labels');
      return args.labels.map(byLabel);
    }
    if (args.refs === undefined) return [control(args)];
    if (!Array.isArray(args.refs) || args.refs.length < 1 || args.refs.length > 20) throw new Error('"refs" must be a list of 1 to 20 control numbers');
    return args.refs.map(byNumber);
  };
  /** What a press of these controls needs: a refusal, a question for the user, or nothing. */
  const pressRules = (found: Control[]): string | Error | undefined => {
    const rules = found.map((one) => pressRule(one, last?.app ?? 'the app'));
    return rules.find((rule) => rule instanceof Error) ?? (rules.filter((rule) => typeof rule === 'string').join(', then ') || undefined);
  };
  const menuList = async (menu?: string): Promise<{ app: string; items: { title: string; enabled: boolean; submenu: boolean }[] }> =>
    JSON.parse(await helper(['menus', ...(menu ? [menu] : []), ...target()]));
  const target = () => (last ? ['--app', last.app] : []);
  /**
   * Presses a control. Apps rearrange themselves (Calculator swaps buttons after a key press), which
   * makes the saved route to a control stale; then the window is read afresh and the control is found
   * again by its kind and label, provided exactly one matches.
   */
  const press = async (one: Control): Promise<void> => {
    try {
      await helper(['press', one.path, one.role, ...target()]);
    } catch (error) {
      if (!(error instanceof Error) || !/has changed/.test(error.message)) throw error;
      await read(last?.app);
      const again = (last?.items ?? []).filter((item) => item.role === one.role && item.label === one.label);
      if (!one.label || again.length !== 1) throw error;
      await helper(['press', again[0]!.path, again[0]!.role, ...target()]);
    }
  };
  const number = { type: 'integer', description: 'The number of the control, from the list in the last window reading' };

  return [
    {
      name: 'app_read',
      description:
        'Read the front window of a Mac app: its text and a numbered list of its buttons, fields and other controls. Give an app name to open it and bring it to the front; without one, the app already in front is read. Use this before app_click or app_type, and again whenever the window changes. System dialogs, such as a permission request or "Are you sure you want to open it?", belong to UserNotificationCenter or CoreServicesUIAgent: read those by name.',
      parameters: { type: 'object', properties: { app: { type: 'string', description: 'The app name, e.g. "Notes" or "Finder"' } } },
      slow: true,
      run: async (args) => {
        const app = typeof args.app === 'string' && args.app.trim() ? args.app.trim() : undefined;
        if (app) {
          await open(app);
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        return read(app);
      },
    },
    {
      name: 'app_click',
      description:
        'Press one or more controls in the app window, in order, then read the window again. Name them by label with labels, exactly as the reading shows them in quotes, e.g. ["2", "3", "multiply", "9", "equals"]; this is the reliable way. For a control with no label, or a label that appears twice, use its number in square brackets with ref or refs. Controls that send, delete or change something are confirmed with the user first; payment buttons are never pressed.',
      parameters: {
        type: 'object',
        properties: {
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels of the controls to press, in order' },
          ref: number,
          refs: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the controls to press, in order' },
        },
      },
      approval: (args) => {
        try {
          const rule = pressRules(controls(args));
          return typeof rule === 'string' ? rule : undefined;
        } catch {
          return undefined; // bad arguments: run() reports them
        }
      },
      slow: true,
      run: async (args) => {
        const found = controls(args);
        const rule = pressRules(found);
        if (rule instanceof Error) throw rule;
        for (const one of found) {
          await press(one);
          if (found.length > 1) await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return reread();
      },
    },
    {
      name: 'app_type',
      description: 'Type into a text field of the app window, by its number, replacing what is there, then read the window again. Password fields are never typed into.',
      parameters: { type: 'object', properties: { ref: number, text: { type: 'string' } }, required: ['ref', 'text'] },
      slow: true,
      run: async (args) => {
        const found = control(args);
        if (found.secure) throw new Error('That is a password field, which I never type into. He must fill it in himself.');
        if (typeof args.text !== 'string') throw new Error('"text" must be text');
        await helper(['type', args.text, found.path, found.role, ...target()]);
        return reread();
      },
    },
    {
      name: 'app_menus',
      description: "List the menu bar of the app that was last read: without a menu name, the menus themselves; with one (e.g. \"File\"), the items inside it. Use this to find a command that has no button in the window.",
      parameters: { type: 'object', properties: { menu: { type: 'string', description: 'A menu name from the menu bar' } } },
      run: async (args) => {
        const menu = typeof args.menu === 'string' && args.menu.trim() ? args.menu.trim() : undefined;
        const { app, items } = await menuList(menu);
        const lines = items.map((item) => `${item.title}${item.submenu ? ' (has a submenu)' : ''}${item.enabled ? '' : ' (greyed out)'}`);
        return `${menu ? `Items in the ${menu} menu of ${app}` : `Menus of ${app}`}:\n${lines.join('\n')}`;
      },
    },
    {
      name: 'app_menu',
      description: 'Choose a command from the menu bar of the app that was last read, by its route, e.g. ["File", "Export as PDF…"] or ["Format", "Font", "Bold"]. Then the window is read again. Commands that send, delete, quit or change something are confirmed with the user first.',
      parameters: { type: 'object', properties: { path: { type: 'array', items: { type: 'string' }, description: 'The menu name, then the item, then any submenu items' } }, required: ['path'] },
      approval: (args) => {
        const route = Array.isArray(args.path) ? args.path.filter((part): part is string => typeof part === 'string') : [];
        const item = route.at(-1) ?? '';
        if (PAYMENT.test(item)) return undefined; // refused in run()
        return RISKY.test(item) || /^quit\b/i.test(item) ? `choose "${route.join(' > ')}" from the menus of ${last?.app ?? 'the app'}` : undefined;
      },
      slow: true,
      run: async (args) => {
        if (!Array.isArray(args.path) || args.path.length < 2 || args.path.length > 6 || !args.path.every((part) => typeof part === 'string' && part.trim())) {
          throw new Error('"path" must list the menu and the item, e.g. ["File", "Save"]');
        }
        if (PAYMENT.test(args.path.at(-1) as string)) throw new Error('That would spend money, which I never do. He must choose it himself.');
        await helper(['menu', ...(args.path as string[]), ...target()]);
        return reread();
      },
    },
    {
      name: 'key_press',
      description:
        'Press a key or keyboard shortcut in the app that was last read, e.g. "return", "tab", "escape", "cmd+n", "cmd+shift+s", "down". Then the window is read again. Sending a message, deleting and quitting are confirmed with the user first.',
      parameters: { type: 'object', properties: { keys: { type: 'string', description: 'Key names joined by +, modifiers first' } }, required: ['keys'] },
      approval: (args) => (typeof args.keys === 'string' ? keyRule(args.keys, last?.app) : undefined),
      slow: true,
      run: async (args) => {
        await helper(['key', text(args, 'keys').replace(/\s+/g, ''), ...target()]);
        return reread();
      },
    },
  ];
}
