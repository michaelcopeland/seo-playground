import { describe, it, expect } from 'vitest';
import { resolveSpendRange, bucketSpend, totalSpend, estimateToolCost } from './spend';
import type { ToolSpend } from './db';

const now = new Date(2026, 8, 15, 14, 30); // 15 Sep 2026, local time

describe('resolveSpendRange', () => {
  it('defaults to the last 30 days, inclusive of today', () => {
    const r = resolveSpendRange({}, now, null);
    expect(r).toMatchObject({ from: '2026-08-17', to: '2026-09-15', preset: '30d' });
    expect(r.fromMs).toBe(new Date(2026, 7, 17).getTime());
    expect(r.toMs).toBe(new Date(2026, 8, 16).getTime());
  });

  it('resolves last month to its full calendar month', () => {
    expect(resolveSpendRange({ preset: 'last-month' }, now, null)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('starts "all time" at the first recorded call', () => {
    expect(resolveSpendRange({ preset: 'all' }, now, new Date(2026, 1, 3, 9).getTime())).toMatchObject({ from: '2026-02-03', to: '2026-09-15' });
  });

  it('accepts a custom range and swaps reversed dates', () => {
    expect(resolveSpendRange({ from: '2026-09-10', to: '2026-09-01' }, now, null)).toMatchObject({ from: '2026-09-01', to: '2026-09-10', preset: null });
  });

  it('ignores invalid dates instead of crashing', () => {
    expect(resolveSpendRange({ from: '2026-02-31', to: 'nope' }, now, null)).toMatchObject({ from: '2026-08-17', to: '2026-09-15' });
  });
});

describe('bucketSpend', () => {
  it('fills every day of a short range, including days with no calls', () => {
    const { unit, buckets } = bucketSpend([{ day: '2026-09-02', calls: 2, knownCost: 0.5, unknownCalls: 1 }], '2026-09-01', '2026-09-03');
    expect(unit).toBe('day');
    expect(buckets.map((b) => [b.key, b.knownCost, b.unknownCalls])).toEqual([['2026-09-01', 0, 0], ['2026-09-02', 0.5, 1], ['2026-09-03', 0, 0]]);
  });

  it('groups long ranges by month', () => {
    const { unit, buckets } = bucketSpend(
      [{ day: '2026-01-05', calls: 1, knownCost: 1, unknownCalls: 0 }, { day: '2026-01-20', calls: 1, knownCost: 2, unknownCalls: 1 }],
      '2026-01-01', '2026-06-30',
    );
    expect(unit).toBe('month');
    expect(buckets).toHaveLength(6);
    expect(buckets[0]).toMatchObject({ key: '2026-01', calls: 2, knownCost: 3, unknownCalls: 1 });
  });
});

describe('unknown costs', () => {
  const tool = (t: Partial<ToolSpend>): ToolSpend => ({ tool: 'x', href: null, calls: 0, knownCost: 0, unknownCalls: 0, avgKnownCost: null, ...t });

  it('prices unknown calls at the tool average, and never counts them as zero in the estimate', () => {
    expect(estimateToolCost(tool({ calls: 3, knownCost: 0.004, unknownCalls: 1, avgKnownCost: 0.002 }))).toBeCloseTo(0.006);
  });

  it('cannot estimate a tool that never recorded a cost', () => {
    expect(estimateToolCost(tool({ calls: 2, unknownCalls: 2 }))).toBeNull();
  });

  it('keeps known spend separate from the estimate and counts unpriceable calls', () => {
    const totals = totalSpend([
      tool({ tool: 'serp', calls: 3, knownCost: 0.004, unknownCalls: 1, avgKnownCost: 0.002 }),
      tool({ tool: 'old', calls: 2, unknownCalls: 2 }),
    ]);
    expect(totals).toMatchObject({ calls: 5, unknownCalls: 3, unestimableCalls: 2 });
    expect(totals.knownCost).toBeCloseTo(0.004);
    expect(totals.estimatedCost).toBeCloseTo(0.006);
  });
});
