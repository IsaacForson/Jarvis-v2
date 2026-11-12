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
  medium: {
    model: 'nvidia/nemotron-3-super-120b-a12b',
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
  // Deep tasks only: thinking on, runs in the background, so it has no spoken-reply budget.
  hard: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    extraBody: { chat_template_kwargs: { enable_thinking: true } },
  },
} satisfies Record<string, Tier>;
