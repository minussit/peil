/**
 * Grouping and costing.
 *
 * Cost is always computed per message and then summed — never by summing
 * buckets first and pricing the total. Rates vary by model, by date, and by
 * fast mode, so pricing an aggregate silently picks one rate for all of it.
 */

import { addBuckets, costOf, costByBucket, totalTokens, ZERO, type Buckets } from "./pricing.js";
import { resolveBranch, type Confidence } from "./git.js";
import { projectOf, type Message } from "./transcripts.js";

export interface Group {
  key: string;
  cost: number;
  buckets: Buckets;
  messages: number;
  sessions: Set<string>;
  days: Set<string>;
  tools: Map<string, number>;
  first: string;
  last: string;
}

function emptyGroup(key: string): Group {
  return {
    key,
    cost: 0,
    buckets: { ...ZERO },
    messages: 0,
    sessions: new Set(),
    days: new Set(),
    tools: new Map(),
    first: "",
    last: "",
  };
}

export function costOfMessage(m: Message): number {
  return costOf(m.buckets, m.model, m.ts, m.fast);
}

export function groupBy(messages: Message[], keyOf: (m: Message) => string | null): Group[] {
  const map = new Map<string, Group>();
  for (const m of messages) {
    const key = keyOf(m);
    if (key === null) continue;
    let g = map.get(key);
    if (!g) {
      g = emptyGroup(key);
      map.set(key, g);
    }
    g.cost += costOfMessage(m);
    g.buckets = addBuckets(g.buckets, m.buckets);
    g.messages++;
    if (m.sessionId) g.sessions.add(m.sessionId);
    if (m.ts) {
      const day = m.ts.slice(0, 10);
      g.days.add(day);
      if (!g.first || m.ts < g.first) g.first = m.ts;
      if (!g.last || m.ts > g.last) g.last = m.ts;
    }
    for (const t of m.tools) g.tools.set(t, (g.tools.get(t) ?? 0) + 1);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function totals(messages: Message[]): Group {
  const g = emptyGroup("total");
  for (const m of messages) {
    g.cost += costOfMessage(m);
    g.buckets = addBuckets(g.buckets, m.buckets);
    g.messages++;
    if (m.sessionId) g.sessions.add(m.sessionId);
    if (m.ts) {
      g.days.add(m.ts.slice(0, 10));
      if (!g.first || m.ts < g.first) g.first = m.ts;
      if (!g.last || m.ts > g.last) g.last = m.ts;
    }
    for (const t of m.tools) g.tools.set(t, (g.tools.get(t) ?? 0) + 1);
  }
  return g;
}

export const byModel = (ms: Message[]) => groupBy(ms, (m) => m.model);
export const byProject = (ms: Message[]) => groupBy(ms, projectOf);
export const byDay = (ms: Message[]) => groupBy(ms, (m) => m.ts.slice(0, 10));

export interface BranchGroup extends Group {
  confidence: Confidence;
}

/** Group by branch, keeping only messages where a branch could be resolved. */
export function byBranch(ms: Message[], sidecar: Map<string, string>): BranchGroup[] {
  const conf = new Map<string, Confidence>();
  const groups = groupBy(ms, (m) => {
    const info = resolveBranch(m, sidecar);
    if (!info.branch) return null;
    // A hook reading beats a transcript reading for the same branch.
    const prev = conf.get(info.branch);
    if (!prev || info.confidence === "hook") conf.set(info.branch, info.confidence);
    return info.branch;
  });
  return groups.map((g) => ({ ...g, confidence: conf.get(g.key) ?? "none" }));
}

export interface Attribution {
  attributed: number;
  attributedCost: number;
  noRepo: number;
  noRepoCost: number;
  lost: number;
  lostCost: number;
}

/** How much of the period could be tied to a branch, and why the rest could not. */
export function attribution(ms: Message[], sidecar: Map<string, string>): Attribution {
  const a: Attribution = {
    attributed: 0,
    attributedCost: 0,
    noRepo: 0,
    noRepoCost: 0,
    lost: 0,
    lostCost: 0,
  };
  for (const m of ms) {
    const cost = costOfMessage(m);
    const info = resolveBranch(m, sidecar);
    if (info.branch) {
      a.attributed++;
      a.attributedCost += cost;
    } else if (info.reason === "no-repo") {
      a.noRepo++;
      a.noRepoCost += cost;
    } else {
      a.lost++;
      a.lostCost += cost;
    }
  }
  return a;
}

export interface BucketRow {
  key: keyof Buckets;
  tokens: number;
  cost: number;
  tokenShare: number;
  costShare: number;
}

/** Token share against cost share — the split that explains where money goes. */
export function bucketBreakdown(ms: Message[]): BucketRow[] {
  const tokens: Record<keyof Buckets, number> = { ...ZERO };
  const cost: Record<keyof Buckets, number> = { ...ZERO };
  for (const m of ms) {
    const c = costByBucket(m.buckets, m.model, m.ts, m.fast);
    for (const k of Object.keys(tokens) as (keyof Buckets)[]) {
      tokens[k] += m.buckets[k];
      cost[k] += c[k];
    }
  }
  const tokenTotal = Object.values(tokens).reduce((a, b) => a + b, 0) || 1;
  const costTotal = Object.values(cost).reduce((a, b) => a + b, 0) || 1;
  return (Object.keys(tokens) as (keyof Buckets)[])
    .map((k) => ({
      key: k,
      tokens: tokens[k],
      cost: cost[k],
      tokenShare: (100 * tokens[k]) / tokenTotal,
      costShare: (100 * cost[k]) / costTotal,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export { totalTokens };
