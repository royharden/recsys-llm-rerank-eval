import { describe, expect, it } from 'vitest';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import {
  ceiling,
  conditionalOnTargetInK,
  coreMetrics,
  coverageAt10,
  evaluateUser,
  evaluateUsers,
  formatMetric,
  headShareAt10,
  hitAt10,
  ndcgAt10,
  noveltyAt10,
  ownPoolShare,
  pairedVectors,
  popularityTerciles,
  rankIn,
  reciprocalRankAtK,
  summarizeArm,
  type UserRanking,
} from '../../src/core/metrics/ranking.ts';
import type { Scorer } from '../../src/core/split/scorer.ts';
import { T, toyItems, toyRows } from '../helpers/toy.ts';

const train = buildTrainingData(toyRows(), T, toyItems());
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function ranking(userKey: string, order: number[], candidateIds: number[] = order): UserRanking {
  return { userKey, order, candidateIds, kEff: order.length, flags: [] };
}

describe('per-rank formulas (hand-computed)', () => {
  const cases: [number | null, number, number, number][] = [
    [1, 1, 1, 1],
    [10, 1, 1 / Math.log2(11), 1 / 10],
    [11, 0, 0, 1 / 11],
    [null, 0, 0, 0],
  ];
  it.each(cases)('rank %s → HR@10 %d, NDCG@10 %f, RR@20 %f', (rank, hr, ndcg, rr) => {
    expect(hitAt10(rank)).toBe(hr);
    expect(ndcgAt10(rank)).toBeCloseTo(ndcg, 12);
    expect(reciprocalRankAtK(rank, 20)).toBeCloseTo(rr, 12);
  });

  it('NDCG@10 at rank 3 is 1/log2(4) = 0.5; RR is truncated at K', () => {
    expect(ndcgAt10(3)).toBe(0.5);
    expect(reciprocalRankAtK(11, 10)).toBe(0);
    expect(reciprocalRankAtK(20, 20)).toBe(1 / 20);
    expect(reciprocalRankAtK(21, 20)).toBe(0);
  });

  it('rankIn is 1-based, null when absent', () => {
    expect(rankIn(7, [3, 7, 9])).toBe(2);
    expect(rankIn(4, [3, 7, 9])).toBeNull();
    expect(rankIn(4, [])).toBeNull();
  });
});

describe('evaluateUser / aggregates', () => {
  // Orders of 20 synthetic ids 101..120 with the target placed at rank 1, 10, 11 or absent.
  const order = range(101, 120);
  const scorer: Scorer = {
    targets: new Map([
      ['r1', 101],
      ['r10', 110],
      ['r11', 111],
      ['abs', 999],
    ]),
  };
  const evals = ['r1', 'r10', 'r11', 'abs'].map((k) => evaluateUser(scorer, train, ranking(k, order), 20));

  it('per-user values', () => {
    expect(evals.map((e) => e.rank)).toEqual([1, 10, 11, null]);
    expect(evals.map((e) => e.hit10)).toEqual([1, 1, 0, 0]);
    expect(evals.map((e) => e.targetInCandidates)).toEqual([true, true, true, false]);
    expect(evals[0].top10).toEqual(range(101, 110));
  });

  it('means: HR@10, NDCG@10, MRR@K', () => {
    const m = coreMetrics(evals);
    expect(m.n).toBe(4);
    expect(m.hr10).toEqual({ kind: 'value', value: 0.5 });
    expect(m.ndcg10.kind === 'value' && m.ndcg10.value).toBeCloseTo((1 + 1 / Math.log2(11)) / 4, 12);
    expect(m.mrrK.kind === 'value' && m.mrrK.value).toBeCloseTo((1 + 0.1 + 1 / 11) / 4, 12);
    expect(ceiling(evals)).toEqual({ kind: 'value', value: 0.75 });
    expect(ownPoolShare(evals)).toEqual({ kind: 'value', value: 0.75 });
  });

  it('throws for a user the Scorer does not know', () => {
    expect(() => evaluateUser(scorer, train, ranking('nobody', order), 20)).toThrow();
  });
});

describe('cold target and empty lists', () => {
  it('a cold target (not in the catalogue) is a miss that stays in the denominator', () => {
    const scorer: Scorer = { targets: new Map([['cold', 6], ['hit', 2]]) };
    const evals = evaluateUsers(scorer, train, [ranking('cold', [2, 3, 4]), ranking('hit', [2, 3, 4])], 20);
    expect(evals[0]).toMatchObject({ rank: null, coldTarget: true, targetPopularity: 0, targetInCandidates: false, ndcg10: 0 });
    expect(evals[1]).toMatchObject({ rank: 1, coldTarget: false, targetPopularity: 3 });
    const m = summarizeArm(evals, train);
    expect(m.n).toBe(2);
    expect(m.hr10).toEqual({ kind: 'value', value: 0.5 });
    expect(m.coldTargets).toBe(1);
  });

  it('kEff = 0 (empty list) is a miss; list-based metrics are unavailable, never NaN', () => {
    const scorer: Scorer = { targets: new Map([['e1', 2], ['e2', 3]]) };
    const empty: UserRanking[] = ['e1', 'e2'].map((k) => ({
      userKey: k,
      order: [],
      candidateIds: [],
      kEff: 0,
      flags: ['short_list', 'no_candidates'],
    }));
    const m = summarizeArm(evaluateUsers(scorer, train, empty, 20), train);
    expect(m.n).toBe(2);
    expect(m.hr10).toEqual({ kind: 'value', value: 0 });
    expect(m.ndcg10).toEqual({ kind: 'value', value: 0 });
    expect(m.coverage10).toEqual({ kind: 'unavailable', reason: 'no recommendations' });
    expect(m.novelty10).toEqual({ kind: 'unavailable', reason: 'no recommendations' });
    expect(m.headShare10).toEqual({ kind: 'unavailable', reason: 'no recommendations' });
    expect(m.noCandidates).toBe(2);
    expect(m.shortLists).toBe(2);
    expect(formatMetric(m.coverage10)).toBe('unavailable: no recommendations');
  });

  it('no users → means unavailable', () => {
    const m = summarizeArm([], train);
    expect(m.hr10).toEqual({ kind: 'unavailable', reason: 'no users' });
    expect(m.ceiling.kind).toBe('unavailable');
    expect(m.conditional.n).toBe(0);
    expect(m.conditional.ndcg10.kind).toBe('unavailable');
  });
});

describe('coverage@10, novelty, head share (hand-computed on the toy catalogue)', () => {
  // catalogue size 8, Σpop = 14, pop(2) = 3, pop(3) = 2, pop(5) = 1; head = top ceil(8/10) = 1 item = {2}
  const scorer: Scorer = { targets: new Map([['a', 9], ['b', 9]]) };
  const evals = evaluateUsers(scorer, train, [ranking('a', [2, 3]), ranking('b', [2, 5])], 20);

  it('coverage = |{2,3,5}| / 8', () => {
    expect(coverageAt10(evals, train)).toEqual({ kind: 'value', value: 3 / 8 });
  });

  it('novelty = mean −log2(pop/Σpop) over the 4 recommended pairs', () => {
    const want = (2 * Math.log2(14 / 3) + Math.log2(14 / 2) + Math.log2(14 / 1)) / 4;
    const got = noveltyAt10(evals, train);
    expect(got.kind).toBe('value');
    expect(got.kind === 'value' && got.value).toBeCloseTo(want, 12);
  });

  it('head share = 2 of 4 pairs are item 2', () => {
    expect(headShareAt10(evals, train)).toEqual({ kind: 'value', value: 0.5 });
  });

  it('only the first 10 positions count', () => {
    const s: Scorer = { targets: new Map([['long', 9]]) };
    const long = [2, 3, 4, 7, 5, 8, 1, 2, 2, 2, 9]; // 11th item (9) is beyond the cut-off
    const ev = evaluateUsers(s, train, [ranking('long', long)], 20);
    expect(ev[0].rank).toBe(11);
    expect(coverageAt10(ev, train)).toEqual({ kind: 'value', value: 7 / 8 });
  });
});

describe('exploratory rows', () => {
  it('conditional-on-target-in-K has its own n', () => {
    const scorer: Scorer = { targets: new Map([['in', 3], ['out', 9]]) };
    const evals = evaluateUsers(scorer, train, [ranking('in', [2, 3], [2, 3]), ranking('out', [2, 3], [2, 3])], 20);
    const c = conditionalOnTargetInK(evals);
    expect(c.n).toBe(1);
    expect(c.hr10).toEqual({ kind: 'value', value: 1 });
    expect(c.ndcg10.kind === 'value' && c.ndcg10.value).toBeCloseTo(1 / Math.log2(3), 12);
  });

  it('popularity terciles: equal-count groups by (target popularity, userKey)', () => {
    // target pops: a 0 (item 6), b 1 (5), c 1 (8), d 2 (1), e 3 (2), f 3 (2)
    const targets: [string, number][] = [
      ['a', 6],
      ['b', 5],
      ['c', 8],
      ['d', 1],
      ['e', 2],
      ['f', 2],
    ];
    const scorer: Scorer = { targets: new Map(targets) };
    // e and f hit at rank 1; everyone else misses
    const evals = evaluateUsers(
      scorer,
      train,
      targets.map(([k]) => ranking(k, k === 'e' || k === 'f' ? [2] : [4])),
      20,
    );
    const rows = popularityTerciles(evals);
    expect(rows.map((r) => [r.tercile, r.n, r.popMin, r.popMax])).toEqual([
      ['low', 2, 0, 1],
      ['mid', 2, 1, 2],
      ['high', 2, 3, 3],
    ]);
    expect(rows[2].ndcg10).toEqual({ kind: 'value', value: 1 });
    expect(rows[0].ndcg10).toEqual({ kind: 'value', value: 0 });
  });

  it('empty terciles are unavailable', () => {
    const rows = popularityTerciles([]);
    expect(rows.every((r) => r.n === 0 && r.ndcg10.kind === 'unavailable' && r.popMin === null)).toBe(true);
  });
});

describe('pairedVectors', () => {
  const scorer: Scorer = { targets: new Map([['x', 2], ['y', 3]]) };
  const a = evaluateUsers(scorer, train, [ranking('x', [2]), ranking('y', [4, 3])], 20);
  const b = evaluateUsers(scorer, train, [ranking('y', [3]), ranking('x', [4])], 20);

  it('aligns per-user values by userKey', () => {
    const p = pairedVectors(a, b, 'hit10');
    expect(p.userKeys).toEqual(['x', 'y']);
    expect(p.a).toEqual([1, 1]);
    expect(p.b).toEqual([0, 1]);
  });

  it('throws on mismatched user sets', () => {
    expect(() => pairedVectors(a, b.slice(0, 1))).toThrow();
    const other = evaluateUsers({ targets: new Map([['z', 2], ['x', 2]]) }, train, [ranking('z', [2]), ranking('x', [2])], 20);
    expect(() => pairedVectors(a, other)).toThrow();
  });
});
