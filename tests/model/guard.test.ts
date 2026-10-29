import { describe, expect, it } from 'vitest';
import { FORMAT_CHAOS_MODES } from '../../src/core/data/synthetic.ts';
import { chaosText } from '../../src/core/providers/mock.ts';
import { guardLlmList, validateJevAnswers } from '../../src/core/rerankguard/validate.ts';
import { labelMap } from '../../src/core/prompts/labels.ts';
import { isPermutationOf } from '../../src/core/arms/types.ts';

const candidates = labelMap({ history: [], candidates: [
  { itemId: 30, knnRank: 3 }, { itemId: 10, knnRank: 1 }, { itemId: 20, knnRank: 2 },
] }).candidates;
describe('guard chaos and exact repairs', () => {
  for (const mode of FORMAT_CHAOS_MODES) it(`always returns a permutation for ${mode}`, () => {
    const r = guardLlmList(chaosText(mode, ['C1', 'C2', 'C3']), candidates);
    expect(isPermutationOf(r.order, [10, 20, 30])).toBe(true);
    const expected = { unknown: 0, repeat: 0, missing: 0, emptyRanking: 0 };
    if (mode === 'unknown-label') expected.unknown = 1;
    if (mode === 'repeated-label') expected.repeat = 1;
    if (mode === 'missing-labels') expected.missing = 2;
    if (mode === 'empty-ranking') expected.emptyRanking = 1;
    expect(r.repairs).toEqual(expected);
    expect(r.formatFailure).toBe(['empty-ranking', 'not-json', 'wrong-type', 'no-reply'].includes(mode));
    if (r.formatFailure) expect(r.order).toEqual([10, 20, 30]);
  });
  it('counts unknowns and repeats separately, appending omissions in kNN order', () => {
    const r = guardLlmList('prefix ```json\n{"ranking":["C1","C1","bad",9]}\n```', candidates);
    expect(r.order).toEqual([30, 10, 20]);
    expect(r.repairs).toEqual({ unknown: 2, repeat: 1, missing: 2, emptyRanking: 0 });
  });
  for (const bad of [NaN, Infinity, -0.1, 1.1, '0.5', null]) it(`rejects a Jev answer ${String(bad)} as whole-list failure`, () => {
    expect(validateJevAnswers({ c_1: 0.8, c_2: bad, c_3: 0.2 }, candidates)).toMatchObject({ formatFailure: true, order: [10, 20, 30] });
  });
  it('missing answers fail; exact probability ties use kNN rank', () => {
    expect(validateJevAnswers({ c_1: 0.8 }, candidates).formatFailure).toBe(true);
    expect(validateJevAnswers({ c_1: 0.5, c_2: 0.5, c_3: 0.5 }, candidates).order).toEqual([10, 20, 30]);
  });
});
