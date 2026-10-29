import { describe, expect, it } from 'vitest';
import { buildUserContext } from '../../src/core/arms/candidates.ts';
import { createItemKnnArm } from '../../src/core/arms/itemknn.ts';
import { createRandomRerankArm } from '../../src/core/arms/random-rerank.ts';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import {
  checkWeights,
  createTunedRerankArm,
  orderByWeights,
  tunedFeatures,
  weightGrid,
} from '../../src/core/arms/tuned-rerank.ts';
import { isPermutationOf } from '../../src/core/arms/types.ts';
import type { UserContext } from '../../src/core/split/context.ts';
import { S12, T, toyItemById, toyItems, toyRows } from '../helpers/toy.ts';

const train = buildTrainingData(toyRows(), T, toyItems());
const itemById = toyItemById();
const HISTORIES = [[1], [2], [4], [1, 2], [3, 4], [7]];
const ctxOf = (history: number[], userKey = `u${history.join('-')}`, K = 20): UserContext =>
  buildUserContext(train, itemById, { userKey, history }, { k: 'all', K });
const ids = (ctx: UserContext) => ctx.candidates.map((c) => c.itemId);

describe('random-rerank', () => {
  it('always returns a permutation of the candidates', async () => {
    for (const seed of [1, 2, 38]) {
      const arm = createRandomRerankArm(seed);
      for (const h of HISTORIES) {
        const ctx = ctxOf(h);
        expect(isPermutationOf((await arm.rank(ctx)).order, ids(ctx))).toBe(true);
      }
    }
  });

  it('is reproducible for a seed and independent of the order users are ranked in', async () => {
    const a = createRandomRerankArm(38);
    const b = createRandomRerankArm(38);
    const x = ctxOf([1], 'alice');
    const y = ctxOf([2], 'bob');
    const ax = (await a.rank(x)).order;
    await b.rank(y);
    expect((await b.rank(x)).order).toEqual(ax);
    expect((await a.rank(x)).order).toEqual(ax);
  });

  it('different seeds give different permutations for some user', async () => {
    const ctxs = HISTORIES.map((h) => ctxOf(h));
    const one = await Promise.all(ctxs.map((c) => createRandomRerankArm(1).rank(c)));
    const two = await Promise.all(ctxs.map((c) => createRandomRerankArm(2).rank(c)));
    expect(one.some((r, i) => r.order.join() !== two[i].order.join())).toBe(true);
  });

  it('repeatIndex changes the stream; empty candidates stay empty', async () => {
    const arm = createRandomRerankArm(7);
    const ctx = ctxOf([1]);
    expect(isPermutationOf((await arm.rank(ctx, { repeatIndex: 1 })).order, ids(ctx))).toBe(true);
    const empty = ctxOf([...train.catalogue]);
    expect((await arm.rank(empty)).order).toEqual([]);
  });
});

describe('tuned-rerank', () => {
  it('weight grid: 15 convex triples on 0.25 steps, knn-heaviest first', () => {
    const g = weightGrid();
    expect(g).toHaveLength(15);
    expect(g[0]).toEqual({ knn: 1, recency: 0, genre: 0 });
    expect(g[1]).toEqual({ knn: 0.75, recency: 0.25, genre: 0 });
    expect(g[14]).toEqual({ knn: 0, recency: 0, genre: 1 });
    for (const w of g) expect(w.knn + w.recency + w.genre).toBe(1);
    expect(new Set(g.map((w) => `${w.knn}/${w.recency}/${w.genre}`)).size).toBe(15);
    expect(() => checkWeights({ knn: 0.3, recency: 0.3, genre: 0.4 })).toThrow();
    expect(() => checkWeights({ knn: 0.5, recency: 0.25, genre: 0 })).toThrow();
  });

  it('features for history [1]: min-max kNN, recency = mean cosine to the last 5, genre-profile cosine', () => {
    const f = tunedFeatures(train, 'all', ctxOf([1]));
    expect(f.map((x) => x.itemId)).toEqual([2, 3, 4, 7, 5, 8, 9]);
    expect(f[0].knn).toBe(1);
    expect(f[1].knn).toBeCloseTo(0.5 / S12, 5);
    expect(f[2].knn).toBe(0);
    expect(f[0].recency).toBeCloseTo(S12, 6);
    expect(f[1].recency).toBeCloseTo(0.5, 6);
    // profile = Action (item 1); 3 = Action+Comedy → 1/√2; 5 = Action → 1; 2 = Comedy → 0; 9 has no genres → 0
    expect(f[1].genre).toBeCloseTo(Math.SQRT1_2, 6);
    expect(f[4].genre).toBeCloseTo(1, 6);
    expect(f[0].genre).toBe(0);
    expect(f[6].genre).toBe(0);
  });

  it('constant kNN scores normalise to 0 (no NaN)', () => {
    const f = tunedFeatures(train, 'all', ctxOf([7])); // item 7 has no neighbours: every candidate scores 0
    for (const x of f) {
      expect(x.knn).toBe(0);
      expect(Number.isNaN(x.genre)).toBe(false);
    }
  });

  it('weights (1, 0, 0) reproduce the kNN order exactly', async () => {
    const tuned = createTunedRerankArm(train, 'all', { knn: 1, recency: 0, genre: 0 });
    const knn = createItemKnnArm();
    for (const h of HISTORIES) {
      const ctx = ctxOf(h);
      expect((await tuned.rank(ctx)).order).toEqual((await knn.rank(ctx)).order);
    }
  });

  it('genre-only ordering with ties broken by kNN order', () => {
    const f = tunedFeatures(train, 'all', ctxOf([1]));
    // genre: 5 → 1, 3 → .707, all others 0 → kNN order 2, 4, 7, 8, 9
    expect(orderByWeights(f, { knn: 0, recency: 0, genre: 1 })).toEqual([5, 3, 2, 4, 7, 8, 9]);
  });

  it('always returns a permutation of the candidates for every grid weight', async () => {
    for (const w of weightGrid()) {
      const arm = createTunedRerankArm(train, 'all', w);
      for (const h of HISTORIES) {
        const ctx = ctxOf(h);
        expect(isPermutationOf((await arm.rank(ctx)).order, ids(ctx))).toBe(true);
      }
    }
  });

  it('isPermutationOf rejects extras, repeats and omissions', () => {
    expect(isPermutationOf([2, 1], [1, 2])).toBe(true);
    expect(isPermutationOf([1, 1], [1, 2])).toBe(false);
    expect(isPermutationOf([1, 3], [1, 2])).toBe(false);
    expect(isPermutationOf([1], [1, 2])).toBe(false);
  });
});
