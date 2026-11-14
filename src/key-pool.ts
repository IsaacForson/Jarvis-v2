import { execFileSync } from 'node:child_process';

export const COOLDOWN_MS = 60_000;

export class AllKeysCoolingError extends Error {
  readonly retryInMs: number;
  constructor(retryInMs: number) {
    super(`Every API key is rate-limited; the first frees up in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'AllKeysCoolingError';
    this.retryInMs = retryInMs;
  }
}

export type PooledKey = { index: number; key: string };

/** Parses the NVIDIA_API_KEYS value: keys separated by commas or whitespace. */
export function parseKeys(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(/[\s,]+/).filter(Boolean))];
}

/** One provider's keys as `npm run keys-to-keychain` stored them in the macOS Keychain, or '' if they are not there. */
export function keychainKeys(provider: 'nvidia' | 'groq' = 'nvidia'): string {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Jarvis', '-a', `${provider}-api-keys`, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Hands out keys in turn, one request each, skipping any key that reported its limit. */
export class KeyPool {
  readonly #keys: string[];
  readonly #readyAt: number[];
  readonly #now: () => number;
  #cursor = 0;

  constructor(keys: string[], now: () => number = Date.now) {
    if (keys.length === 0) throw new Error('No API keys: set NVIDIA_API_KEYS in .env (see .env.example), or store them with npm run keys-to-keychain');
    this.#keys = [...keys];
    this.#readyAt = keys.map(() => 0);
    this.#now = now;
  }

  get size(): number {
    return this.#keys.length;
  }

  next(): PooledKey {
    const now = this.#now();
    for (let step = 0; step < this.size; step++) {
      const index = (this.#cursor + step) % this.size;
      if (this.#readyAt[index]! <= now) {
        this.#cursor = (index + 1) % this.size;
        return { index, key: this.#keys[index]! };
      }
    }
    throw new AllKeysCoolingError(Math.min(...this.#readyAt) - now);
  }

  cooldown(index: number, ms: number = COOLDOWN_MS): void {
    if (!(index in this.#readyAt)) throw new RangeError(`No key at index ${index}`);
    this.#readyAt[index] = this.#now() + ms;
  }
}
