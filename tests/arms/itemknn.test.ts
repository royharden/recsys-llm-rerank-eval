import { describe, expect, it } from 'vitest';
import { buildCandidates, buildUserContext, LIST_K_GRID } from '../../src/core/arms/candidates.ts';
import { createItemKnnArm, KNN_K_GRID, knnRanking, knnScoresFor } from '../../src/core/arms/itemknn.ts';
import { createMostPopArm, mostPopular } from '../../src/core/arms/mostpop.ts';
import { buildTrainingData, headItems, neighboursOf, popularityOf, similarity } from '../../src/core/arms/train.ts';
import { ARM_IDS, ARM_KIND, type ArmId } from '../../src/core/arms/types.ts';
import { postTRows, S12, S24, S45, T, toyItemById, toyItems, toyRows } from '../helpers/toy.ts';

const train = buildTrainingData(toyRows(), T, toyItems());
const itemById = toyItemById();

describe('arm ids and the shared interface', () => {
  it('has exactly the six arm ids with a kind each', () => {
    expect([...ARM_IDS]).toEqual(['mostpop', 'itemknn', 'random-rerank', 'tuned-rerank', 'llm-list', 'jev-point']);
    expect(Object.keys(ARM_KIND).sort()).toEqual([...ARM_IDS].sort());
    const generators: ArmId[] = ARM_IDS.filter((a) => ARM_KIND[a] === 'generator');
    expect(generators).toEqual(['mostpop', 'itemknn']);
  });
});

describe('training data (pre-T only)', () => {
  it('catalogue, popularity and cosine match the hand computation', () => {
    expect(train.catalogue).toEqual([1, 2, 3, 4, 5, 7, 8, 9]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => popularityOf(train, i))).toEqual([2, 3, 2, 2, 1, 0, 2, 1, 1]);
    expect(train.totalPopularity).toBe(14);
    expect(similarity(train, 1, 2)).toBeCloseTo(S12, 6);
    expect(similarity(train, 2, 1)).toBeCloseTo(S12, 6);
    expect(similarity(train, 1, 3)).toBeCloseTo(0.5, 6);
    expect(similarity(train, 2, 4)).toBeCloseTo(S24, 6);
    expect(similarity(train, 4, 5)).toBeCloseTo(S45, 6);
    expect(similarity(train, 1, 4)).toBe(0);
    expect(similarity(train, 2, 2)).toBe(0);
    expect(similarity(train, 1, 6)).toBe(0); // 6 is not in the catalogue
  });

  it('neighbour lists: sim desc, then popularity desc, then id asc; positive sims only', () => {
    expect(neighboursOf(train, 1)).toEqual([2, 3]);
    expect(neighboursOf(train, 2)).toEqual([1, 3, 4]); // 1 and 3 tie on sim and popularity → id
    expect(neighboursOf(train, 3)).toEqual([2, 1, 4]); // 1 and 4 tie on sim (.5) and popularity → id
    expect(neighboursOf(train, 4)).toEqual([5, 3, 2]);
    expect(neighboursOf(train, 7)).toEqual([]);
    expect(neighboursOf(train, 4, 1)).toEqual([5]);
  });

  it('head set is the top ceil(10%) by popularity', () => {
    expect([...headItems(train)]).toEqual([2]);
  });

  it('a post-T interaction injected into the input changes nothing', () => {
    const withPost = buildTrainingData([...postTRows(), ...toyRows()], T, toyItems());
    expect(withPost.rows).toBe(train.rows);
    expect(withPost.catalogue).toEqual(train.catalogue);
    expect(Array.from(withPost.popularity)).toEqual(Array.from(train.popularity));
    expect(Array.from(withPost.sim)).toEqual(Array.from(train.sim));
    expect(Array.from(withPost.neighbours)).toEqual(Array.from(train.neighbours));
    expect(Array.from(withPost.popularityOrder)).toEqual(Array.from(train.popularityOrder));
    for (const history of [[1], [2], [4], [1, 2]]) {
      const a = buildUserContext(train, itemById, { userKey: 'u', history }, { k: 'all', K: 20 });
      const b = buildUserContext(withPost, itemById, { userKey: 'u', history }, { k: 'all', K: 20 });
      expect(b).toEqual(a);
    }
  });

  it('is independent of input row order', () => {
    const shuffled = buildTrainingData(toyRows().reverse(), T, toyItems());
    expect(Array.from(shuffled.sim)).toEqual(Array.from(train.sim));
    expect(Array.from(shuffled.neighbours)).toEqual(Array.from(train.neighbours));
  });
});

describe('itemknn scoring and tie rule', () => {
  it('k = all, history [1]: positive scores first, then zero-score ties by popularity desc, then id', () => {
    const r = knnRanking(train, [1], 'all', 20);
    // 2 (.8165), 3 (.5), then zeros: 4 (pop 2), 7 (pop 2), 5 (pop 1), 8 (pop 1), 9 (pop 1)
    expect(r.ids).toEqual([2, 3, 4, 7, 5, 8, 9]);
    expect(r.scores[0]).toBeCloseTo(S12, 6);
    expect(r.scores[1]).toBeCloseTo(0.5, 6);
    expect(r.poolSize).toBe(7);
  });

  it('exactly equal positive scores and equal popularity → item id', () => {
    // history [2]: s(2,1) = s(2,3) = 2/√6 exactly, both popularity 2
    expect(knnRanking(train, [2], 'all', 20).ids).toEqual([1, 3, 4, 7, 5, 8, 9]);
  });

  it('neighbourhood size k limits which neighbours contribute', () => {
    // N_1(4) = {5}; with k = all, 3 (.5) and 2 (.408) also score.
    expect(knnRanking(train, [4], 1, 20).ids).toEqual([5, 2, 1, 3, 7, 8, 9]); // zeros: 2 (pop 3) before 1, 3, 7 (pop 2)
    expect(knnRanking(train, [4], 'all', 20).ids).toEqual([5, 3, 2, 1, 7, 8, 9]);
    expect(knnScoresFor(train, [4], 1, [5, 3])).toEqual([expect.closeTo(S45, 6), 0]);
  });

  it('sums similarities over the history and excludes history items', () => {
    const r = knnRanking(train, [1, 2], 'all', 20);
    expect(r.ids).toEqual([3, 4, 7, 5, 8, 9]);
    expect(r.ids).not.toContain(1);
    expect(r.ids).not.toContain(2);
    expect(r.scores[0]).toBeCloseTo(0.5 + S12, 6);
    expect(r.scores[1]).toBeCloseTo(S24, 6);
  });

  it('grid values are the planned k set and k beyond the stored lists is rejected', () => {
    expect([...KNN_K_GRID]).toEqual([20, 50, 100, 'all']);
    expect(() => knnRanking(train, [1], 101, 10)).toThrow(/maxNeighbours/);
    expect(() => knnRanking(train, [1], 0, 10)).toThrow();
  });
});

describe('candidates and kEff flags', () => {
  it('K grid is {20, 30}', () => {
    expect([...LIST_K_GRID]).toEqual([20, 30]);
  });

  it('kEff = K when the pool is large enough: no flags, knnRank 1..K, metadata attached', () => {
    const c = buildCandidates(train, itemById, [1], 'all', 5);
    expect(c.kEff).toBe(5);
    expect(c.flags).toEqual([]);
    expect(c.candidates.map((x) => x.itemId)).toEqual([2, 3, 4, 7, 5]);
    expect(c.candidates.map((x) => x.knnRank)).toEqual([1, 2, 3, 4, 5]);
    expect(c.candidates[0]).toEqual({ itemId: 2, title: 'Movie 2', year: 1992, genres: ['Comedy'], knnRank: 1 });
  });

  it('kEff < K → short_list', () => {
    const c = buildCandidates(train, itemById, [1], 'all', 20);
    expect(c.kEff).toBe(7);
    expect(c.flags).toEqual(['short_list']);
  });

  it('kEff = 0 → no_candidates; context is still built and every arm returns an empty list (a miss)', async () => {
    const all = [...train.catalogue];
    const ctx = buildUserContext(train, itemById, { userKey: 'full', history: all }, { k: 'all', K: 20 });
    expect(ctx.kEff).toBe(0);
    expect(ctx.flags).toEqual(['short_list', 'no_candidates']);
    expect(ctx.candidates).toEqual([]);
    expect((await createItemKnnArm().rank(ctx)).order).toEqual([]);
    expect((await createMostPopArm(train).rank(ctx)).order).toEqual([]);
  });

  it('UserContext has history, promptHistory and no target field', () => {
    const ctx = buildUserContext(train, itemById, { userKey: 'k1', history: [1, 2] }, { k: 'all', K: 20 });
    expect(ctx.history).toEqual([1, 2]);
    expect(ctx.promptHistory.map((p) => p.itemId)).toEqual([1, 2]);
    expect(Object.keys(ctx).sort()).toEqual(['candidates', 'flags', 'history', 'kEff', 'promptHistory', 'userKey']);
  });
});

describe('generator arms', () => {
  it('itemknn arm returns the candidate list in knnRank order with zero repairs', async () => {
    const ctx = buildUserContext(train, itemById, { userKey: 'k', history: [4] }, { k: 'all', K: 20 });
    const r = await createItemKnnArm().rank(ctx);
    expect(r).toEqual({
      order: [5, 3, 2, 1, 7, 8, 9],
      repairs: { unknown: 0, repeat: 0, missing: 0, emptyRanking: 0 },
      formatFailure: false,
      callIds: [],
    });
  });

  it('mostpop: popularity desc then id, history excluded, length kEff', async () => {
    expect(mostPopular(train, [], 8)).toEqual([2, 1, 3, 4, 7, 5, 8, 9]);
    expect(mostPopular(train, [2], 5)).toEqual([1, 3, 4, 7, 5]);
    const ctx = buildUserContext(train, itemById, { userKey: 'k', history: [2] }, { k: 'all', K: 5 });
    expect((await createMostPopArm(train).rank(ctx)).order).toEqual([1, 3, 4, 7, 5]);
  });
});
