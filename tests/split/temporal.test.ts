import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Interaction, Item } from '../../src/core/data/types.ts';
import { historyIds, kEffOf, promptHistoryOf, type UserContext } from '../../src/core/split/context.ts';
import { scorerFromSplit, targetRank } from '../../src/core/split/scorer.ts';
import { userKeyOf } from '../../src/core/split/manifest.ts';
import {
  chooseQ,
  devHeldoutSizes,
  nearestRankIndex,
  sortInteractions,
  splitAt,
  temporalSplit,
} from '../../src/core/split/temporal.ts';

const row = (userId: number, itemId: number, ts: number): Interaction => ({ userId, itemId, rating: 4, ts });

/** `n` history rows for a user at ts = base+1..base+n on items itemBase+1.. */
const historyRows = (userId: number, n: number, itemBase = 0, base = 0): Interaction[] =>
  Array.from({ length: n }, (_, i) => row(userId, itemBase + i + 1, base + i + 1));

describe('nearestRankIndex = ceil(q*N) - 1', () => {
  it.each([
    [0.8, 10, 7],
    [0.75, 4, 2],
    [0.75, 7, 5],
    [0.7, 10, 6],
    [0.7, 3, 2],
    [1, 5, 4],
    [0.8, 1, 0],
  ])('q=%f N=%i -> %i', (q, n, idx) => {
    expect(nearestRankIndex(q, n)).toBe(idx);
  });

  it('rejects invalid inputs', () => {
    expect(() => nearestRankIndex(0, 10)).toThrow();
    expect(() => nearestRankIndex(1.2, 10)).toThrow();
    expect(() => nearestRankIndex(0.8, 0)).toThrow();
  });
});

describe('ordering and cut', () => {
  it('sorts by (ts, itemId), then userId', () => {
    const sorted = sortInteractions([row(1, 5, 10), row(2, 3, 10), row(1, 2, 5), row(1, 3, 10)]);
    expect(sorted.map((r) => [r.ts, r.itemId, r.userId])).toEqual([
      [5, 2, 1],
      [10, 3, 1],
      [10, 3, 2],
      [10, 5, 1],
    ]);
  });

  it('T is the ts at the nearest-rank index on a toy dataset', () => {
    const rows = [30, 100, 10, 80, 50, 20, 90, 60, 40, 70].map((ts, i) => row(1, i + 1, ts));
    expect(chooseQ(rows, { qCandidates: [0.8], minHeldout: 0 }).T).toBe(80);
    expect(chooseQ(rows, { qCandidates: [0.7], minHeldout: 0 }).T).toBe(70);
  });

  it('history is ts < T; target is the first row with ts >= T, ties broken by item id (not file order)', () => {
    const rows = [...historyRows(1, 10), row(1, 50, 100), row(1, 40, 100), row(1, 30, 120)];
    const s = splitAt(rows, 100, { seed: 1 });
    const u = s.users.get(1);
    expect(u?.history.map((r) => r.ts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(u?.target?.itemId).toBe(40);
  });

  it('orders tied history rows by item id', () => {
    const rows = [row(1, 9, 5), row(1, 3, 5), ...historyRows(1, 10, 100, 10), row(1, 500, 100)];
    const u = splitAt(rows, 100, { seed: 1 }).users.get(1);
    expect(u?.history.slice(0, 2).map((r) => r.itemId)).toEqual([3, 9]);
  });
});

describe('eligibility, catalogue, cold targets', () => {
  const rows = [
    ...historyRows(1, 10), // A: 10 history + target -> eligible
    row(1, 999, 100), // A's target is never seen pre-T -> cold
    ...historyRows(2, 9), // B: 9 history + target -> insufficient_history
    row(2, 55, 100),
    ...historyRows(3, 10), // C: 10 history, no target -> no_target
  ];
  const s = splitAt(rows, 100, { seed: 7 });

  it('requires >= 10 distinct history items and a target', () => {
    expect(s.eligibleUserIds).toEqual([1]);
    expect(s.exclusions).toEqual({ insufficient_history: 1, no_target: 1 });
    expect(s.users.get(2)?.exclusion).toBe('insufficient_history');
    expect(s.users.get(3)?.exclusion).toBe('no_target');
  });

  it('catalogue = items with >= 1 pre-T interaction; cold targets are counted', () => {
    expect(s.catalogue).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.coldTargetUserIds).toEqual([1]);
  });
});

describe('q rule', () => {
  // ts 1..20, one row per ts. T(0.8)=16, T(0.75)=15, T(0.7)=14.
  const rows = [
    ...[1, 2, 3, 4].map((ts) => row(1, ts, ts)),
    ...[5, 6, 7, 8].map((ts) => row(2, ts, ts)),
    ...[9, 10, 11].map((ts) => row(3, ts, ts)),
    ...[12, 13].map((ts) => row(4, ts, ts)),
    row(1, 14, 14), // A's late row
    row(2, 15, 15), // B's late row
    row(3, 16, 16), // C's late row
    ...[17, 18, 19, 20].map((ts) => row(5, ts, ts)), // only late rows: never eligible
  ];

  it('records every trial and picks the first q with held-out >= minHeldout', () => {
    const d = chooseQ(rows, { minHistory: 1, minHeldout: 2 });
    expect(d.trials).toEqual([
      { q: 0.8, T: 16, eligible: 1, dev: 0, heldout: 1 },
      { q: 0.75, T: 15, eligible: 2, dev: 1, heldout: 1 },
      { q: 0.7, T: 14, eligible: 3, dev: 1, heldout: 2 },
    ]);
    expect(d).toMatchObject({ q: 0.7, T: 14, insufficientPrecision: false });
  });

  it('stops at the first q that qualifies', () => {
    expect(chooseQ(rows, { minHistory: 1, minHeldout: 1 })).toMatchObject({ q: 0.8, insufficientPrecision: false });
  });

  it('falls back to the largest held-out count and flags insufficient_precision', () => {
    expect(chooseQ(rows, { minHistory: 1, minHeldout: 3 })).toMatchObject({ q: 0.7, T: 14, insufficientPrecision: true });
  });

  it('breaks ties between equally small held-out counts toward the earlier q', () => {
    const flat = [...historyRows(1, 5), ...[6, 7, 8, 9, 10].map((i) => row(1, i, 50))];
    const d = chooseQ(flat, { minHistory: 1, minHeldout: 99 });
    expect(d.trials.map((t) => t.T)).toEqual([50, 50, 50]);
    expect(d).toMatchObject({ q: 0.8, insufficientPrecision: true });
  });

  it('uses the defaults 0.8/0.75/0.7, minHistory 10, minHeldout 150', () => {
    const d = chooseQ(rows);
    expect(d.trials.map((t) => t.q)).toEqual([0.8, 0.75, 0.7]);
    expect(d.minHeldout).toBe(150);
    expect(d.trials.every((t) => t.eligible === 0)).toBe(true);
  });
});

describe('dev / held-out assignment', () => {
  const many = (n: number): Interaction[] => Array.from({ length: n }, (_, i) => [row(i + 1, 1, 1), row(i + 1, 2, 100)]).flat();

  it('is a disjoint, exhaustive, sorted 50/50 split', () => {
    const s = splitAt(many(41), 100, { seed: 38, minHistory: 1 });
    const dev = new Set(s.devUserIds);
    expect(s.devUserIds).toHaveLength(20);
    expect(s.heldoutUserIds).toHaveLength(21);
    expect(s.heldoutUserIds.some((u) => dev.has(u))).toBe(false);
    expect([...s.devUserIds, ...s.heldoutUserIds].sort((a, b) => a - b)).toEqual(s.eligibleUserIds);
    expect(s.devUserIds).toEqual([...s.devUserIds].sort((a, b) => a - b));
    expect(devHeldoutSizes(41)).toEqual({ dev: 20, heldout: 21 });
  });

  it('is deterministic for a seed and changes with the seed', () => {
    const a = splitAt(many(40), 100, { seed: 38, minHistory: 1 });
    const b = splitAt(many(40), 100, { seed: 38, minHistory: 1 });
    const c = splitAt(many(40), 100, { seed: 39, minHistory: 1 });
    expect(b.devUserIds).toEqual(a.devUserIds);
    expect(c.devUserIds).not.toEqual(a.devUserIds);
  });

  it('does not depend on input row order', () => {
    const rows = many(30);
    const a = splitAt(rows, 100, { seed: 5, minHistory: 1 });
    const b = splitAt(rows.slice().reverse(), 100, { seed: 5, minHistory: 1 });
    expect(b.devUserIds).toEqual(a.devUserIds);
  });
});

describe('post-T mutation does not change history (fixed T)', () => {
  const items = new Map<number, Item>(
    Array.from({ length: 60 }, (_, i): [number, Item] => [i + 1, { itemId: i + 1, title: `Item ${i + 1}`, year: 1990, genres: ['Drama'] }]),
  );
  const base = [...historyRows(1, 35), row(1, 40, 100), ...historyRows(2, 12, 20), row(2, 50, 101)];
  const extra = [row(1, 41, 500), row(2, 51, 501), row(9, 52, 502), row(9, 53, 503)];

  it('keeps histories, targets, prompt history and the dev/held-out assignment', () => {
    const a = splitAt(base, 100, { seed: 3 });
    const b = splitAt([...base, ...extra], 100, { seed: 3 });
    for (const u of [1, 2]) {
      expect(b.users.get(u)?.history).toEqual(a.users.get(u)?.history);
      expect(b.users.get(u)?.target).toEqual(a.users.get(u)?.target);
      const ha = historyIds(a.users.get(u)?.history ?? []);
      const hb = historyIds(b.users.get(u)?.history ?? []);
      expect(promptHistoryOf(hb, items)).toEqual(promptHistoryOf(ha, items));
    }
    expect(b.eligibleUserIds).toEqual(a.eligibleUserIds);
    expect(b.devUserIds).toEqual(a.devUserIds);
    expect(b.catalogue).toEqual(a.catalogue);
  });

  it('prompt history is the last 30 history items, oldest first', () => {
    const h = historyIds(splitAt(base, 100, { seed: 3 }).users.get(1)?.history ?? []);
    const p = promptHistoryOf(h, items);
    expect(p).toHaveLength(30);
    expect(p[0].itemId).toBe(6);
    expect(p[29].itemId).toBe(35);
  });
});

describe('UserContext, kEff, Scorer', () => {
  it('UserContext has no target field', () => {
    expectTypeOf<UserContext>().not.toHaveProperty('target');
    const ctx: UserContext = { userKey: 'k', history: [1], promptHistory: [], candidates: [], kEff: 0, flags: ['no_candidates'] };
    // @ts-expect-error UserContext deliberately has no target field
    expect(ctx.target).toBeUndefined();
    expect(Object.keys(ctx)).not.toContain('target');
  });

  it('kEff = min(K, available) with short_list / no_candidates flags', () => {
    expect(kEffOf(20, 25)).toEqual({ kEff: 20, flags: [] });
    expect(kEffOf(20, 6)).toEqual({ kEff: 6, flags: ['short_list'] });
    expect(kEffOf(20, 0)).toEqual({ kEff: 0, flags: ['short_list', 'no_candidates'] });
  });

  it('Scorer maps userKey -> target and ranks are 1-based (null when absent)', () => {
    const rows = [...historyRows(1, 10), row(1, 77, 100)];
    const { split } = temporalSplit(rows, { seed: 1, qCandidates: [1], minHeldout: 0 });
    const s = splitAt(rows, 100, { seed: 1 });
    expect(split.T).toBe(100);
    const salt = '00112233445566778899aabbccddeeff';
    const scorer = scorerFromSplit(s, s.eligibleUserIds, salt);
    const key = userKeyOf(salt, 1);
    expect(scorer.targets.get(key)).toBe(77);
    expect(targetRank(scorer, key, [5, 77, 6])).toBe(2);
    expect(targetRank(scorer, key, [5, 6])).toBeNull();
    expect(() => targetRank(scorer, 'nope', [77])).toThrow();
    expect(() => scorerFromSplit(s, [42], salt)).toThrow();
  });
});
