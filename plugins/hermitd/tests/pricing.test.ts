import { describe, test, expect } from 'bun:test';
import { resolvePricing, calculateCost, PRICING } from '../scripts/lib/pricing';

const empty = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

describe('resolvePricing', () => {
  test('exact id', () => {
    const r = resolvePricing('claude-sonnet-5');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-sonnet-5']);
  });

  test('dated snapshot is exact: claude-haiku-4-5-20251001 → haiku-4-5', () => {
    const r = resolvePricing('claude-haiku-4-5-20251001');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-haiku-4-5']);
  });

  test('claude-sonnet-5-5 is exact', () => {
    const r = resolvePricing('claude-sonnet-5-5');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-sonnet-5-5']);
  });

  test('tier alias sonnet → sonnet-5-5, not exact', () => {
    const r = resolvePricing('sonnet');
    expect(r.exact).toBe(false);
    expect(r.rates).toBe(PRICING['claude-sonnet-5-5']);
  });

  test('claude-haiku-5-5 is exact', () => {
    const r = resolvePricing('claude-haiku-5-5');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-haiku-5-5']);
  });

  test('tier alias haiku → haiku-5-5, not exact', () => {
    const r = resolvePricing('haiku');
    expect(r.exact).toBe(false);
    expect(r.rates).toBe(PRICING['claude-haiku-5-5']);
  });

  test('claude-opus-5-5 is exact', () => {
    const r = resolvePricing('claude-opus-5-5');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-opus-5-5']);
  });

  test('tier alias opus → opus-5-5, not exact', () => {
    const r = resolvePricing('opus');
    expect(r.exact).toBe(false);
    expect(r.rates).toEqual(PRICING['claude-opus-5-5']);
  });

  test('dated opus-4-5 snapshot is exact, not the opus alias', () => {
    const r = resolvePricing('claude-opus-4-5-20251101');
    expect(r.exact).toBe(true);
    expect(r.rates).toEqual(PRICING['claude-opus-4-5']);
  });

  test('unknown claude-nova-9 → sonnet-5, not exact', () => {
    const r = resolvePricing('claude-nova-9');
    expect(r.exact).toBe(false);
    expect(r.rates).toEqual(PRICING['claude-sonnet-5']);
  });
});

describe('calculateCost', () => {
  test('1M 5m writes on sonnet-5 = $2.50', () => {
    expect(calculateCost('claude-sonnet-5', { ...empty, cacheWrite5m: 1_000_000 }).total).toBeCloseTo(2.50, 9);
  });

  test('1M 1h writes on sonnet-5 = $4.00', () => {
    expect(calculateCost('claude-sonnet-5', { ...empty, cacheWrite1h: 1_000_000 }).total).toBeCloseTo(4.00, 9);
  });

  test('Fable 5.1 1M reads = $0.25', () => {
    expect(calculateCost('claude-fable-5-1', { ...empty, cacheRead: 1_000_000 }).total).toBeCloseTo(0.25, 9);
  });

  test('fast on opus-5 1M input = $10', () => {
    expect(calculateCost('claude-opus-5', { ...empty, input: 1_000_000, fast: true }).total).toBeCloseTo(10, 9);
  });

  test('Opus 5.5 1M reads = $0.20', () => {
    expect(calculateCost('claude-opus-5-5', { ...empty, cacheRead: 1_000_000 }).total).toBeCloseTo(0.20, 9);
  });

  test('fast on opus-5-5: 1M input = $8, 1M reads = $0.40', () => {
    expect(calculateCost('claude-opus-5-5', { ...empty, input: 1_000_000, fast: true }).total).toBeCloseTo(8, 9);
    expect(calculateCost('claude-opus-5-5', { ...empty, cacheRead: 1_000_000, fast: true }).total).toBeCloseTo(0.40, 9);
  });

  test('fast ignored on sonnet-5', () => {
    expect(calculateCost('claude-sonnet-5', { ...empty, input: 1_000_000, fast: true }).total).toBeCloseTo(2, 9);
  });

  test('byType sums to total', () => {
    const r = calculateCost('claude-sonnet-5', {
      input: 100, cacheWrite5m: 200, cacheWrite1h: 300, cacheRead: 400, output: 500,
    });
    const s = r.byType.input + r.byType.cacheWrite + r.byType.cacheRead + r.byType.output;
    expect(s).toBeCloseTo(r.total, 12);
  });
});
