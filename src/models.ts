export type Tier = {
  model: string;
  extraBody: Record<string, unknown>;
  /** Target for the first words of a reply, from the spec's speed budget. Only the tier that speaks has one. */
  firstTextBudgetMs?: number;
};

/** The models picked in the spec's Models section, 12 Nov 2026. */
export const TIERS = {
  // Answers every spoken turn, so thinking stays off.
  easy: {
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    firstTextBudgetMs: 600,
  },
  // The spec's pick, nemotron-3-super-120b-a12b, is listed but answers 404 (not deployed) as of 12 Nov 2026.
  medium: {
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
  // Deep tasks only: thinking on, runs in the background, so it has no spoken-reply budget.
  hard: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    extraBody: { chat_template_kwargs: { enable_thinking: true } },
  },
} satisfies Record<string, Tier>;

/**
 * Models for spoken replies, in order of preference. Measured 12 Nov 2026 over eight requests each:
 * Super VL started in 0.9 to 1.2 s every time; Bolt in about 0.65 s but is a much smaller model;
 * Lightning is fastest when healthy (0.7 s) but stalled for over 30 s on three of eight requests.
 */
export const SPOKEN: Tier[] = [
  TIERS.medium,
  { model: 'nvidia/nemotron-3.5-bolt-e4b', extraBody: { chat_template_kwargs: { enable_thinking: false } } },
  TIERS.easy,
];

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Groq's models, for the quick brain: conversation and simple actions. Measured 14 Nov 2026 with a few
 * tools: gpt-oss-120b replied or called the right tool in 0.4 to 0.7 s, every time; gpt-oss-20b was as
 * quick but invented an argument; qwen answered in words that it had acted, without calling a tool.
 * Each key allows 8,000 tokens a minute, and the reply's token allowance counts towards it, so the
 * quick brain gets brief instructions, few tools and a small allowance.
 */
export const QUICK: (Tier & { maxTokens: number })[] = [
  { model: 'openai/gpt-oss-120b', extraBody: { reasoning_effort: 'low' }, maxTokens: 500 },
  { model: 'openai/gpt-oss-20b', extraBody: { reasoning_effort: 'low' }, maxTokens: 500 },
];
/** One-word judgements: 20 of 20 sample requests routed right in about 0.35 s. */
export const QUICK_VERDICT: Tier = { model: 'qwen/qwen3.8-27b', extraBody: { reasoning_effort: 'none' } };
