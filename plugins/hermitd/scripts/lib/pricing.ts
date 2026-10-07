// Per-1M-token pricing (USD). Source of truth for all cost calculations.
// Verified 2026-09-29 against:
//   https://platform.claude.com/docs/en/about-claude/models/overview.md
//   https://platform.claude.com/docs/en/about-claude/pricing.md
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md
// Change ONLY this file when Anthropic updates prices; bump the verified date to today.

export const PRICING_VERIFIED = '2026-09-29';

export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
export const CACHE_READ = 0.1;

export type ModelPricing = {
  input: number;
  output: number;
  cacheReadMult?: number;
  fast?: { input: number; output: number };
};

export type CostByType = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

const CURRENT_TIER: Record<string, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
};

const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheReadMult: 0.025 },
  'claude-fable-5':   { input: 10, output: 50 },
  'claude-opus-5-5':  { input: 4, output: 20, cacheReadMult: 0.05, fast: { input: 8, output: 40 } },
  'claude-opus-5':    { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-8':  { input: 5, output: 25, fast: { input: 10, output: 50 } },
  'claude-opus-4-7':  { input: 5, output: 25 },
  'claude-opus-4-6':  { input: 5, output: 25 },
  'claude-opus-4-5':  { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5':  { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Base tier only: Haiku 5.5 rates rise to $0.50 / $2.50 past 100k prompt tokens.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const TIER_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const;

function resolvePricing(model: string): { rates: ModelPricing; exact: boolean } {
  if (PRICING[model]) return { rates: PRICING[model], exact: true };
  const dated = /^(.*)-(\d{8})$/.exec(model);
  if (dated && PRICING[dated[1]]) return { rates: PRICING[dated[1]], exact: true };
  const lower = model.toLowerCase();
  for (const tier of TIER_ORDER) {
    if (lower.includes(tier)) {
      return { rates: PRICING[CURRENT_TIER[tier]], exact: false };
    }
  }
  return { rates: PRICING['claude-sonnet-5'], exact: false };
}

function calculateCost(
  model: string,
  t: { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number; fast?: boolean },
): { total: number; byType: CostByType } {
  const { rates } = resolvePricing(model);
  const inputRate = t.fast && rates.fast ? rates.fast.input : rates.input;
  const outputRate = t.fast && rates.fast ? rates.fast.output : rates.output;
  const cacheReadRate = inputRate * (rates.cacheReadMult ?? CACHE_READ);
  const byType: CostByType = {
    input: (t.input / 1_000_000) * inputRate,
    cacheWrite:
      (t.cacheWrite5m / 1_000_000) * inputRate * CACHE_WRITE_5M +
      (t.cacheWrite1h / 1_000_000) * inputRate * CACHE_WRITE_1H,
    cacheRead: (t.cacheRead / 1_000_000) * cacheReadRate,
    output: (t.output / 1_000_000) * outputRate,
  };
  return { total: byType.input + byType.cacheWrite + byType.cacheRead + byType.output, byType };
}

export { PRICING, resolvePricing, calculateCost };
