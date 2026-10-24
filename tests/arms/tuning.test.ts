import { describe, expect, it } from 'vitest';
import { buildUserContext } from '../../src/core/arms/candidates.ts';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import { weightGrid } from '../../src/core/arms/tuned-rerank.ts';
import {
  chooseListSize,
  decideListSize,
  devCeilings,
  tuneNeighbourhood,
  tuneOnDev,
  tuneTunedWeights,
  type DevUser,
  type FitsCap,
} from '../../src/core/arms/tuning.ts';
import { judgeFromScorer } from '../../src/core/metrics/ranking.ts';
import type { Scorer } from '../../src/core/split/scorer.ts';
import { T, toyItemById, toyItems, toyRows } from '../helpers/toy.ts';

const train = buildTrainingData(toyRows(), T, toyItems());
const itemById = toyItemById();
const always: FitsCap = () => true;

function setup(users: [string, number[], number][]): { dev: DevUser[]; scorer: Scorer } {
  return {
    dev: users.map(([userKey, history]) => ({ userKey, history })),
    scorer: { targets: new Map(users.map(([userKey, , target]): [string, number] => [userKey, target])) },
  };
}

describe('neighbourhood k tuning (dev itemknn NDCG@10)', () => {
  it('ties → smaller k; trials reported in ascending k regardless of grid order', () => {
    // Every neighbour list has ≤ 3 entries, so k ∈ {20, 50, 100, all} rank identically.
    const { dev, scorer } = setup([
      ['a', [1], 3],
      ['b', [4], 2],
    ]);
    const r = tuneNeighbourhood(train, dev, judgeFromScorer(scorer), ['all', 100, 20, 50]);
    expect(r.trials.map((t) => t.k)).toEqual([20, 50, 100, 'all']);
    expect(new Set(r.trials.map((t) => t.meanNdcg10)).size).toBe(1);
    expect(r.k).toBe(20);
    expect(r.noDevUsers).toBe(false);
  });

  it('a strictly better larger k wins; a strictly better smaller k wins', () => {
    // history [4]: k=1 → [5, 2, 1, 3, …]; k=all → [5, 3, 2, 1, …]
    const toAll = setup([['a', [4], 3]]); // rank 4 (k=1) vs 2 (all)
    expect(tuneNeighbourhood(train, toAll.dev, judgeFromScorer(toAll.scorer), [1, 'all']).k).toBe('all');
    const toOne = setup([['a', [4], 2]]); // rank 2 (k=1) vs 3 (all)
    expect(tuneNeighbourhood(train, toOne.dev, judgeFromScorer(toOne.scorer), [1, 'all']).k).toBe(1);
  });

  it('is deterministic', () => {
    const { dev, scorer } = setup([
      ['a', [1], 3],
      ['b', [4], 2],
      ['c', [2], 9],
    ]);
    const j = judgeFromScorer(scorer);
    expect(tuneNeighbourhood(train, dev, j)).toEqual(tuneNeighbourhood(train, dev, j));
  });

  it('no dev users → smallest k, flagged', () => {
    const r = tuneNeighbourhood(train, [], judgeFromScorer({ targets: new Map() }));
    expect(r.k).toBe(20);
    expect(r.noDevUsers).toBe(true);
  });
});

describe('K rule {20, 30}', () => {
  it('K = 30 only when the gain is ≥ 0.03 (exact integer test) and fitsCap(30)', () => {
    expect(decideListSize({ n: 100, hits20: 40, hits30: 43 }, always)).toMatchObject({ ok: true, K: 30 });
    expect(decideListSize({ n: 100, hits20: 40, hits30: 42 }, always)).toMatchObject({ ok: true, K: 20 });
    expect(decideListSize({ n: 7, hits20: 1, hits30: 1 }, always)).toMatchObject({ ok: true, K: 20 });
    const capped = decideListSize({ n: 100, hits20: 40, hits30: 50 }, (K) => K === 20);
    expect(capped).toMatchObject({ ok: true, K: 20 });
    expect(capped.reason).toMatch(/does not fit the cap/);
  });

  it('fitsCap(20) false → live refused with a reason (no silent K reduction)', () => {
    const r = decideListSize({ n: 100, hits20: 40, hits30: 50 }, () => false);
    expect(r.ok).toBe(false);
    expect(r.K).toBeNull();
    expect(r.reason).toMatch(/refused/);
  });

  it('no dev users → K = 20', () => {
    expect(decideListSize({ n: 0, hits20: 0, hits30: 0 }, always)).toMatchObject({ ok: true, K: 20 });
  });

  it('dev ceilings count targets in the kNN top-20 / top-30', () => {
    const { dev, scorer } = setup([
      ['a', [1], 3], // in list
      ['b', [1], 6], // cold target: never in list
    ]);
    expect(devCeilings(train, dev, judgeFromScorer(scorer), 'all')).toEqual({ n: 2, hits20: 1, hits30: 1 });
    expect(chooseListSize(train, dev, judgeFromScorer(scorer), 'all', always)).toMatchObject({ ok: true, K: 20 });
  });
});

describe('tuned-rerank weight tuning', () => {
  it('all-tied grid → the first (knn-heaviest) weights', () => {
    const { dev, scorer } = setup([['a', [1], 6]]); // cold target: NDCG 0 for every weight
    const ctxs = dev.map((u) => buildUserContext(train, itemById, u, { k: 'all', K: 20 }));
    const r = tuneTunedWeights(train, 'all', ctxs, judgeFromScorer(scorer));
    expect(r.weights).toEqual({ knn: 1, recency: 0, genre: 0 });
    expect(r.trials).toHaveLength(15);
  });

  it('picks the first grid entry reaching the best dev NDCG@10', () => {
    // history [1], target 5 (genre match, kNN rank 5). First grid weights putting 5 on top: knn .25, recency 0, genre .75.
    const { dev, scorer } = setup([['a', [1], 5]]);
    const ctxs = dev.map((u) => buildUserContext(train, itemById, u, { k: 'all', K: 20 }));
    const r = tuneTunedWeights(train, 'all', ctxs, judgeFromScorer(scorer));
    expect(r.weights).toEqual({ knn: 0.25, recency: 0, genre: 0.75 });
    expect(r.trials[0].meanNdcg10).toBeCloseTo(1 / Math.log2(6), 10);
    expect(Math.max(...r.trials.map((t) => t.meanNdcg10))).toBe(1);
    expect(r.trials.map((t) => t.weights)).toEqual(weightGrid());
  });
});

describe('tuneOnDev', () => {
  it('runs k → K → weights deterministically', () => {
    const { dev, scorer } = setup([
      ['a', [1], 5],
      ['b', [4], 3],
      ['c', [2], 4],
    ]);
    const input = { train, itemById, devUsers: dev, judge: judgeFromScorer(scorer), fitsCap: always };
    const r = tuneOnDev(input);
    expect(r).toEqual(tuneOnDev(input));
    expect(r.K.ok).toBe(true);
    expect(r.weightsK).toBe(20);
  });

  it('refused live still tunes local weights at K = 20 and carries the refusal', () => {
    const { dev, scorer } = setup([['a', [1], 5]]);
    const r = tuneOnDev({ train, itemById, devUsers: dev, judge: judgeFromScorer(scorer), fitsCap: () => false });
    expect(r.K.ok).toBe(false);
    expect(r.weightsK).toBe(20);
  });
});
