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
  /** Models to move on to, in order, when the one before is down, missing or too slow to start. */
  fallbacks?: Pick<ChatRequest, 'model' | 'extraBody'>[];
  /** How long to wait for a model to start answering before trying the next. Default 8 s. */
  timeoutMs?: number;
  /** Actions the model may ask for. What it asks for is the stream's return value. */
  tools?: OpenAI.Chat.ChatCompletionTool[];
};

/** One action the model asked for; `arguments` is JSON text exactly as the model wrote it. */
export type ToolCall = { id: string; name: string; arguments: string };

/** Returns a function that streams a reply's text, using the pool's keys in turn. */
export function createChat(pool: KeyPool, baseURL: string = NVIDIA_BASE_URL) {
  const clients = new Map<number, OpenAI>();
  const clientFor = (index: number, apiKey: string): OpenAI => {
    let client = clients.get(index);
    if (!client) {
      // The pool does the retrying, so the client must not retry the same key itself.
      // A reply cannot wait long: give up on a silent server after 8 s and move on to another key or model.
      client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 8_000 });
      clients.set(index, client);
    }
    return client;
  };

  const open = async (request: ChatRequest) => {
    const candidates = [request, ...(request.fallbacks ?? [])];
    let failures = 0;
    // Ends when a key answers, or when pool.next() throws because every key is cooling.
    for (;;) {
      const { index, key } = pool.next();
      // Each failure moves one model down the list; with no list, the same model is retried.
      const candidate = candidates[Math.min(failures, candidates.length - 1)]!;
      try {
        return await clientFor(index, key).chat.completions.create(
          {
            ...candidate.extraBody,
            model: candidate.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            ...(request.tools?.length ? { tools: request.tools } : {}),
            stream: true,
          },
          { signal: request.signal, ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}) },
        );
      } catch (error) {
        if (error instanceof OpenAI.RateLimitError) {
          pool.cooldown(index);
          continue;
        }
        // NVIDIA's side failed: a 5xx, a dropped or stalled connection, or a model that is listed but not
        // running (404). Try again, twice at most beyond the models listed.
        const transient =
          error instanceof OpenAI.InternalServerError ||
          error instanceof OpenAI.NotFoundError ||
          (error instanceof OpenAI.APIConnectionError && !(error instanceof OpenAI.APIUserAbortError));
        if (transient && !request.signal?.aborted && ++failures <= Math.max(2, candidates.length - 1)) continue;
        if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
          // Name the key by position only; the key itself must never reach a log.
          throw new Error(`API key #${index + 1} was rejected (HTTP ${error.status})`, { cause: error });
        }
        throw error;
      }
    }
  };

  /** Yields the reply's text as it arrives; returns the actions the model asked for, if any. */
  return async function* streamChat(request: ChatRequest): AsyncGenerator<string, ToolCall[]> {
    const calls: ToolCall[] = [];
    for await (const chunk of await open(request)) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) yield delta.content;
      // A tool call arrives in fragments: its id and name first, then its arguments piece by piece.
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= { id: '', name: '', arguments: '' });
        call.id ||= part.id ?? '';
        call.name += part.function?.name ?? '';
        call.arguments += part.function?.arguments ?? '';
      }
    }
    return calls.filter(Boolean);
  };
}
