/**
 * Token pricing.
 *
 * The whole reason this file exists: a Claude Code message does not have "an
 * input token count". It has four separately-priced input buckets, and pricing
 * them as one number is wrong by a large multiple.
 *
 *   input_tokens        1.00x  input rate   uncached, full price
 *   cache_read          0.10x  input rate   the overwhelming majority of tokens
 *   cache_write 5m      1.25x  input rate
 *   cache_write 1h      2.00x  input rate   in practice, most cache writes
 *   output_tokens       1.00x  output rate
 *
 * Two mistakes are easy and both are large:
 *
 *   1. Pricing every input-side token at the full input rate. Cache reads are
 *      routinely ~97% of all tokens, so this overstates cost by roughly 6x.
 *   2. Using the flat `cache_creation_input_tokens` field at 1.25x. Most cache
 *      writes carry the 1-hour TTL and bill at 2x, so this understates.
 *      Read the nested `cache_creation` object instead.
 */

export interface Rate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** ISO date this rate takes effect. Rates are matched newest-first. */
  from: string;
  /** ISO date this rate stops applying, if it was superseded. */
  until?: string;
}

/**
 * Rate cards are dated so that re-running a report over a past period keeps
 * producing the same answer after a price change. Add new entries; never edit
 * an old one in place.
 */
const RATES: Record<string, Rate[]> = {
  "claude-fable-5": [{ input: 10, output: 50, from: "2020-01-01" }],
  "claude-mythos-5": [{ input: 10, output: 50, from: "2020-01-01" }],
  "claude-opus-5": [{ input: 5, output: 25, from: "2020-01-01" }],
  "claude-opus-4-8": [{ input: 5, output: 25, from: "2020-01-01" }],
  "claude-opus-4-7": [{ input: 5, output: 25, from: "2020-01-01" }],
  "claude-opus-4-6": [{ input: 5, output: 25, from: "2020-01-01" }],
  "claude-opus-4-5": [{ input: 5, output: 25, from: "2020-01-01" }],
  "claude-opus-4-1": [{ input: 15, output: 75, from: "2020-01-01" }],
  "claude-sonnet-5": [
    // Introductory pricing, then standard.
    { input: 2, output: 10, from: "2020-01-01", until: "2026-08-31" },
    { input: 3, output: 15, from: "2026-09-01" },
  ],
  "claude-sonnet-4-6": [{ input: 3, output: 15, from: "2020-01-01" }],
  "claude-sonnet-4-5": [{ input: 3, output: 15, from: "2020-01-01" }],
  "claude-haiku-4-5": [{ input: 1, output: 5, from: "2020-01-01" }],
};

/** Fast mode is a different price for the same model. */
const FAST_RATES: Record<string, Rate[]> = {
  "claude-opus-5": [{ input: 10, output: 50, from: "2020-01-01" }],
  "claude-opus-4-8": [{ input: 10, output: 50, from: "2020-01-01" }],
};

/** Model ids sometimes carry a date suffix; strip it to find the rate card. */
function normalise(model: string): string {
  if (RATES[model]) return model;
  const stripped = model.replace(/-\d{8}$/, "");
  return RATES[stripped] ? stripped : model;
}

export function rateFor(model: string, when: string, fast = false): Rate | null {
  const key = normalise(model);
  const table = (fast && FAST_RATES[key]) || RATES[key];
  if (!table) return null;
  const day = when.slice(0, 10);
  for (const r of table) {
    if (day >= r.from && (!r.until || day <= r.until)) return r;
  }
  return table[table.length - 1] ?? null;
}

export function isKnownModel(model: string): boolean {
  return RATES[normalise(model)] !== undefined;
}

export interface Buckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const ZERO: Buckets = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
};

export function addBuckets(a: Buckets, b: Buckets): Buckets {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

export function totalTokens(b: Buckets): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}

const MILLION = 1_000_000;

/** Cost in USD for one bucket set, at the rate in force on `when`. */
export function costOf(b: Buckets, model: string, when: string, fast = false): number {
  const r = rateFor(model, when, fast);
  if (!r) return 0;
  return (
    (b.input * r.input +
      b.cacheRead * r.input * 0.1 +
      b.cacheWrite5m * r.input * 1.25 +
      b.cacheWrite1h * r.input * 2.0 +
      b.output * r.output) /
    MILLION
  );
}

/** Per-bucket cost split — what `peil buckets` reports. */
export function costByBucket(
  b: Buckets,
  model: string,
  when: string,
  fast = false,
): Record<keyof Buckets, number> {
  const r = rateFor(model, when, fast);
  if (!r) return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  return {
    input: (b.input * r.input) / MILLION,
    cacheRead: (b.cacheRead * r.input * 0.1) / MILLION,
    cacheWrite5m: (b.cacheWrite5m * r.input * 1.25) / MILLION,
    cacheWrite1h: (b.cacheWrite1h * r.input * 2.0) / MILLION,
    output: (b.output * r.output) / MILLION,
  };
}

export const BUCKET_LABELS: Record<keyof Buckets, string> = {
  cacheRead: "Cache read",
  cacheWrite1h: "Cache write 1h",
  output: "Output",
  input: "Input",
  cacheWrite5m: "Cache write 5m",
};

export const BUCKET_MULTIPLIERS: Record<keyof Buckets, string> = {
  cacheRead: "0.1x",
  cacheWrite1h: "2.0x",
  output: "output",
  input: "1.0x",
  cacheWrite5m: "1.25x",
};
