/** One thing Jarvis can do on the Mac. The model picks a tool and writes its arguments. */
export type Tool = {
  name: string;
  /** Tells the model when to use it. */
  description: string;
  /** JSON Schema of the arguments. */
  parameters: { type: 'object'; properties: Record<string, object>; required?: string[] };
  /**
   * The approval rule. Returns what to ask the user before running ("move report.pdf to the Trash"),
   * or undefined when the action is safe to run unasked. Omitted means never ask.
   */
  approval?(args: Args): string | undefined;
  /** Takes long enough that Jarvis should say "one moment" first. */
  slow?: boolean;
  /** Does the work and returns what the model should know about the outcome. Throws on failure. */
  run(args: Args): Promise<string>;
};

/** Arguments as the model wrote them: untrusted, so every tool checks what it reads. */
export type Args = Record<string, unknown>;

/** Reads a required text argument. */
export function text(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

/** Reads a whole-number argument within a range, or the fallback when it is absent. */
export function integer(args: Args, key: string, range: { min: number; max: number; fallback: number }): number {
  const value = args[key] ?? range.fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`"${key}" must be a whole number from ${range.min} to ${range.max}`);
  }
  return value;
}

/** Keeps a tool result to a size the model can take in. */
export const clip = (value: string, max = 6000) => (value.length > max ? `${value.slice(0, max)}\n[cut: ${value.length - max} more characters]` : value);
