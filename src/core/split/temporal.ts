// Global temporal split (PLAN §3): one cut T for all users, history = ts < T, target = first row ts >= T.
import type { Interaction } from '../data/types.ts';
import { rngFor, shuffle } from '../stats/prng.ts';

export const Q_CANDIDATES: readonly number[] = [0.8, 0.75, 0.7];
export const MIN_HISTORY = 10;
export const MIN_HELDOUT = 150;

export type ExclusionReason = 'insufficient_history' | 'no_target';

/** Total order used everywhere: (ts, itemId), then userId so the order is fully deterministic. */
export function compareInteractions(a: Interaction, b: Interaction): number {
  return a.ts - b.ts || a.itemId - b.itemId || a.userId - b.userId;
}

export function sortInteractions(rows: readonly Interaction[]): Interaction[] {
  return rows.slice().sort(compareInteractions);
}

/**
 * Nearest-rank index ceil(q·N) − 1, computed in integers (q is scaled to millionths) so that e.g. q=0.7, N=10 gives 6
 * rather than suffering from 0.7·10 = 7.000000000000001.
 */
export function nearestRankIndex(q: number, n: number): number {
  if (!(q > 0 && q <= 1)) throw new Error(`nearestRankIndex: q must be in (0, 1], got ${q}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`nearestRankIndex: n must be a positive integer, got ${n}`);
  const qm = Math.round(q * 1_000_000);
  return Math.ceil((qm * n) / 1_000_000) - 1;
}

/** T = ts of the row at nearestRankIndex(q, N) in (ts, itemId) order. */
export function cutTimestamp(sorted: readonly Interaction[], q: number): number {
  return sorted[nearestRankIndex(q, sorted.length)].ts;
}

/** 50/50 split sizes: dev gets floor(n/2), held-out gets the rest. */
export function devHeldoutSizes(n: number): { dev: number; heldout: number } {
  const dev = Math.floor(n / 2);
  return { dev, heldout: n - dev };
}

export interface UserSplit {
  userId: number;
  /** Pre-T rows, oldest first in (ts, itemId) order. */
  history: Interaction[];
  /** Distinct items in history. */
  historyItems: number;
  /** First row with ts >= T (ties broken by itemId), or null. */
  target: Interaction | null;
  exclusion: ExclusionReason | null;
}

interface Partition {
  users: Map<number, UserSplit>;
  eligible: number[];
  exclusions: Record<ExclusionReason, number>;
}

function partition(sorted: readonly Interaction[], T: number, minHistory: number): Partition {
  const byUser = new Map<number, Interaction[]>();
  for (const r of sorted) {
    const list = byUser.get(r.userId);
    if (list) list.push(r);
    else byUser.set(r.userId, [r]);
  }
  const users = new Map<number, UserSplit>();
  const eligible: number[] = [];
  const exclusions: Record<ExclusionReason, number> = { insufficient_history: 0, no_target: 0 };
  for (const userId of [...byUser.keys()].sort((a, b) => a - b)) {
    const rows = byUser.get(userId) ?? [];
    const cut = rows.findIndex((r) => r.ts >= T);
    const history = cut === -1 ? rows : rows.slice(0, cut);
    const target = cut === -1 ? null : rows[cut];
    const historyItems = new Set(history.map((r) => r.itemId)).size;
    const exclusion: ExclusionReason | null =
      historyItems < minHistory ? 'insufficient_history' : target === null ? 'no_target' : null;
    if (exclusion) exclusions[exclusion]++;
    else eligible.push(userId);
    users.set(userId, { userId, history, historyItems, target, exclusion });
  }
  return { users, eligible, exclusions };
}

export interface SplitOptions {
  seed: number;
  minHistory?: number;
}

export interface SplitResult {
  T: number;
  seed: number;
  minHistory: number;
  /** Every user, ascending userId. */
  users: ReadonlyMap<number, UserSplit>;
  /** Ascending. */
  eligibleUserIds: number[];
  /** Ascending; disjoint from heldoutUserIds; union = eligibleUserIds. */
  devUserIds: number[];
  heldoutUserIds: number[];
  /** Items with >= 1 pre-T interaction, ascending. */
  catalogue: number[];
  /** Eligible users whose target item is not in the catalogue (kept in denominators as misses). */
  coldTargetUserIds: number[];
  exclusions: Record<ExclusionReason, number>;
}

/** Split at a fixed cut T (used both when freezing and when re-deriving from a stored manifest). */
export function splitAt(rows: readonly Interaction[], T: number, opts: SplitOptions): SplitResult {
  const minHistory = opts.minHistory ?? MIN_HISTORY;
  const sorted = sortInteractions(rows);
  const { users, eligible, exclusions } = partition(sorted, T, minHistory);

  const cat = new Set<number>();
  for (const r of sorted) {
    if (r.ts >= T) break;
    cat.add(r.itemId);
  }
  const catalogue = [...cat].sort((a, b) => a - b);

  const asc = (a: number, b: number) => a - b;
  const order = shuffle(eligible, rngFor(opts.seed, 'split', 'dev-heldout'));
  const { dev } = devHeldoutSizes(order.length);
  const devUserIds = order.slice(0, dev).sort(asc);
  const heldoutUserIds = order.slice(dev).sort(asc);

  const coldTargetUserIds = eligible.filter((u) => {
    const t = users.get(u)?.target;
    return t != null && !cat.has(t.itemId);
  });

  return { T, seed: opts.seed, minHistory, users, eligibleUserIds: eligible, devUserIds, heldoutUserIds, catalogue, coldTargetUserIds, exclusions };
}

export interface QTrial {
  q: number;
  T: number;
  eligible: number;
  dev: number;
  heldout: number;
}

export interface QDecision {
  q: number;
  T: number;
  trials: QTrial[];
  /** True when no candidate q reached minHeldout; the q with the largest held-out count was used. */
  insufficientPrecision: boolean;
  minHeldout: number;
}

export interface QOptions {
  minHistory?: number;
  minHeldout?: number;
  qCandidates?: readonly number[];
}

/**
 * q rule (PLAN §3): try q in order, pick the first whose held-out count >= minHeldout; otherwise the q with the largest
 * held-out count (ties → earlier q), flagged insufficientPrecision. Count-only: decided before any arm is scored.
 */
export function chooseQ(rows: readonly Interaction[], opts: QOptions = {}): QDecision {
  if (rows.length === 0) throw new Error('chooseQ: no interactions');
  const minHistory = opts.minHistory ?? MIN_HISTORY;
  const minHeldout = opts.minHeldout ?? MIN_HELDOUT;
  const qs = opts.qCandidates ?? Q_CANDIDATES;
  if (qs.length === 0) throw new Error('chooseQ: no q candidates');
  const sorted = sortInteractions(rows);
  const trials: QTrial[] = qs.map((q) => {
    const T = cutTimestamp(sorted, q);
    const eligible = partition(sorted, T, minHistory).eligible.length;
    return { q, T, eligible, ...devHeldoutSizes(eligible) };
  });
  const firstOk = trials.find((t) => t.heldout >= minHeldout);
  if (firstOk) return { q: firstOk.q, T: firstOk.T, trials, insufficientPrecision: false, minHeldout };
  const best = trials.reduce((b, t) => (t.heldout > b.heldout ? t : b), trials[0]);
  return { q: best.q, T: best.T, trials, insufficientPrecision: true, minHeldout };
}

/** chooseQ then splitAt the chosen T. */
export function temporalSplit(
  rows: readonly Interaction[],
  opts: SplitOptions & QOptions,
): { decision: QDecision; split: SplitResult } {
  const decision = chooseQ(rows, opts);
  const split = splitAt(rows, decision.T, { seed: opts.seed, minHistory: opts.minHistory });
  return { decision, split };
}
