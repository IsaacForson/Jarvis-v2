// Phase 0: how fast does each chosen model start talking? Run with `npm run speed`.
import { createChat } from './chat.ts';
import { KeyPool, parseKeys } from './key-pool.ts';
import { TIERS, type Tier } from './models.ts';
import { measureTurn, median, type TurnTiming } from './timing.ts';

const SYSTEM = 'You are Jarvis, a spoken assistant. Reply in one or two short sentences.';
const PROMPTS = [
  'Good morning. What should I do first today?',
  'Remind me why sleep matters, briefly.',
  'What is fifteen percent of two hundred and forty?',
  'I am thinking of skipping lunch to finish work. Thoughts?',
  'Give me one tip for a clearer email.',
];

const pool = new KeyPool(parseKeys(process.env.NVIDIA_API_KEYS));
const chat = createChat(pool);
console.log(`${pool.size} API key(s) loaded, ${PROMPTS.length} requests per model.\n`);

const ms = (value: number) => `${Math.round(value)} ms`;
let failed = false;

for (const [name, tier] of Object.entries<Tier>(TIERS)) {
  const runs: TurnTiming[] = [];
  for (const prompt of PROMPTS) {
    try {
      runs.push(
        await measureTurn(
          chat({
            model: tier.model,
            extraBody: tier.extraBody,
            maxTokens: 200,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: prompt },
            ],
          }),
        ),
      );
    } catch (error) {
      failed = true;
      console.error(`  ${name}: request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`${name}  ${tier.model}  (${runs.length}/${PROMPTS.length} succeeded)`);
  if (runs.length === 0) continue;
  const firstText = runs.map((run) => run.firstTextMs);
  const firstSentence = runs.map((run) => run.firstSentenceMs);
  const budget = tier.firstTextBudgetMs;
  const verdict = budget === undefined ? '' : median(firstText) <= budget ? `  within the ${budget} ms budget` : `  OVER the ${budget} ms budget`;
  console.log(`  first words     median ${ms(median(firstText))}, worst ${ms(Math.max(...firstText))}${verdict}`);
  console.log(`  first sentence  median ${ms(median(firstSentence))}, worst ${ms(Math.max(...firstSentence))}`);
  console.log(`  whole reply     median ${ms(median(runs.map((run) => run.totalMs)))}`);
  console.log(`  sample: ${runs[0]!.text.trim()}\n`);
}

process.exitCode = failed ? 1 : 0;
