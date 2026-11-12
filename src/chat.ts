import OpenAI from 'openai';
import type { KeyPool } from './key-pool.ts';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export type ChatRequest = {
  model: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  maxTokens?: number;
  /** Model-specific fields the OpenAI types do not know, such as chat_template_kwargs. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
};

/** Returns a function that streams a reply's text, using the pool's keys in turn. */
export function createChat(pool: KeyPool, baseURL: string = NVIDIA_BASE_URL) {
  const clients = new Map<number, OpenAI>();
  const clientFor = (index: number, apiKey: string): OpenAI => {
    let client = clients.get(index);
    if (!client) {
      // The pool does the retrying, so the client must not retry the same key itself.
      // A spoken reply cannot wait long: give up on a silent server after 8 s and let the pool try another key.
      client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 8_000 });
      clients.set(index, client);
    }
    return client;
  };

  const open = async (request: ChatRequest) => {
    let serverFailures = 0;
    // Ends when a key answers, or when pool.next() throws because every key is cooling.
    for (;;) {
      const { index, key } = pool.next();
      try {
        return await clientFor(index, key).chat.completions.create(
          {
            ...request.extraBody,
            model: request.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            stream: true,
          },
          { signal: request.signal },
        );
      } catch (error) {
        if (error instanceof OpenAI.RateLimitError) {
          pool.cooldown(index);
          continue;
        }
        // NVIDIA's side hiccuped (5xx or a dropped connection): try again, twice at most.
        const transient = error instanceof OpenAI.InternalServerError || (error instanceof OpenAI.APIConnectionError && !(error instanceof OpenAI.APIUserAbortError));
        if (transient && !request.signal?.aborted && ++serverFailures <= 2) continue;
        if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
          // Name the key by position only; the key itself must never reach a log.
          throw new Error(`API key #${index + 1} was rejected (HTTP ${error.status})`, { cause: error });
        }
        throw error;
      }
    }
  };

  return async function* streamChat(request: ChatRequest): AsyncGenerator<string> {
    for await (const chunk of await open(request)) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
  };
}
