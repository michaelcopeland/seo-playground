import type { DailySpend, ToolSpend } from './db';

// Dates are plain local calendar days (YYYY-MM-DD), matching SQLite's 'localtime' grouping.

export function toDayString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDay(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // Reject rollovers like 2026-02-31
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export type SpendPreset = '7d' | '30d' | 'this-month' | 'last-month' | 'this-year' | 'all';

export const SPEND_PRESETS: Array<{ key: SpendPreset; label: string }> = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-year', label: 'This year' },
  { key: 'all', label: 'All time' },
];

export function presetRange(preset: SpendPreset, now: Date, firstTs: number | null): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case '7d': return { from: toDayString(addDays(today, -6)), to: toDayString(today) };
    case '30d': return { from: toDayString(addDays(today, -29)), to: toDayString(today) };
    case 'this-month': return { from: toDayString(new Date(today.getFullYear(), today.getMonth(), 1)), to: toDayString(today) };
    case 'last-month': return {
      from: toDayString(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: toDayString(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
    case 'this-year': return { from: toDayString(new Date(today.getFullYear(), 0, 1)), to: toDayString(today) };
    case 'all': return { from: toDayString(firstTs !== null ? new Date(firstTs) : today), to: toDayString(today) };
  }
}

export interface SpendRange {
  from: string;
  to: string;
  /** Inclusive start of `from`, local time. */
  fromMs: number;
  /** Exclusive end: start of the day after `to`. */
  toMs: number;
  /** The preset matching this range, if any. */
  preset: SpendPreset | null;
}

/** Resolves ?preset= or ?from=&to= into a range. Defaults to the last 30 days; swaps reversed dates. */
export function resolveSpendRange(
  params: { from?: string; to?: string; preset?: string },
  now: Date,
  firstTs: number | null,
): SpendRange {
  let from: string;
  let to: string;
  const preset = SPEND_PRESETS.find((p) => p.key === params.preset)?.key;
  const fromDate = parseDay(params.from);
  const toDate = parseDay(params.to);

  if (preset) {
    ({ from, to } = presetRange(preset, now, firstTs));
  } else if (fromDate || toDate) {
    const today = toDayString(now);
    from = fromDate ? toDayString(fromDate) : (toDate ? toDayString(toDate) : today);
    to = toDate ? toDayString(toDate) : today;
    if (from > to) [from, to] = [to, from];
  } else {
    ({ from, to } = presetRange('30d', now, firstTs));
  }

  const matched = SPEND_PRESETS.find((p) => {
    const r = presetRange(p.key, now, firstTs);
    return r.from === from && r.to === to;
  })?.key ?? null;

  return {
    from, to,
    fromMs: parseDay(from)!.getTime(),
    toMs: addDays(parseDay(to)!, 1).getTime(),
    preset: preset ?? matched,
  };
}

export interface SpendBucket {
  key: string;
  label: string;
  calls: number;
  knownCost: number;
  unknownCalls: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Spreads daily totals over every day (or month, for ranges longer than ~3 months) of the range,
 * filling gaps with zeros so the chart's time axis stays continuous.
 */
export function bucketSpend(daily: DailySpend[], from: string, to: string): { unit: 'day' | 'month'; buckets: SpendBucket[] } {
  const start = parseDay(from)!;
  const end = parseDay(to)!;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const unit = days > 92 ? 'month' : 'day';
  const byKey = new Map<string, SpendBucket>();

  if (unit === 'day') {
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const key = toDayString(d);
      byKey.set(key, { key, label: `${d.getDate()} ${MONTHS[d.getMonth()]}`, calls: 0, knownCost: 0, unknownCalls: 0 });
    }
  } else {
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const key = toDayString(d).slice(0, 7);
      byKey.set(key, { key, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, calls: 0, knownCost: 0, unknownCalls: 0 });
    }
  }

  for (const row of daily) {
    const b = byKey.get(unit === 'day' ? row.day : row.day.slice(0, 7));
    if (!b) continue;
    b.calls += row.calls;
    b.knownCost += row.knownCost;
    b.unknownCalls += row.unknownCalls;
  }
  return { unit, buckets: [...byKey.values()] };
}

export interface SpendTotals {
  calls: number;
  knownCost: number;
  unknownCalls: number;
  /** Known cost plus unknown calls priced at their tool's average. Equals knownCost when nothing is unknown. */
  estimatedCost: number;
  /** Unknown calls from tools that never reported a cost, so they can't be estimated. */
  unestimableCalls: number;
}

/** Estimated cost for one tool, or null if it has unknown calls but no known average to price them with. */
export function estimateToolCost(t: ToolSpend): number | null {
  if (t.unknownCalls === 0) return t.knownCost;
  if (t.avgKnownCost === null) return null;
  return t.knownCost + t.unknownCalls * t.avgKnownCost;
}

export function totalSpend(tools: ToolSpend[]): SpendTotals {
  const totals: SpendTotals = { calls: 0, knownCost: 0, unknownCalls: 0, estimatedCost: 0, unestimableCalls: 0 };
  for (const t of tools) {
    totals.calls += t.calls;
    totals.knownCost += t.knownCost;
    totals.unknownCalls += t.unknownCalls;
    const est = estimateToolCost(t);
    if (est === null) {
      totals.estimatedCost += t.knownCost;
      totals.unestimableCalls += t.unknownCalls;
    } else {
      totals.estimatedCost += est;
    }
  }
  return totals;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
