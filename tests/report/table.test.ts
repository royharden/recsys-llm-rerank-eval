import { describe, expect, it } from 'vitest';
import { ARM_IDS, zeroRepairs } from '../../src/core/arms/types.ts';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import type { ResultRow } from '../../src/core/runner/store.ts';
import { buildReport } from '../../src/core/report/table.ts';
import { failureList } from '../../src/core/report/failure-list.ts';
import { resultsMarkdown, MOCK_STAMP } from '../../src/core/report/results-md.ts';
import { toyRows, toyItems, T } from '../helpers/toy.ts';

function row(arm: ResultRow['arm'], user: number, ids: number[]): ResultRow {
  return { runId: 'mock-report', arm, variant: 'base', repeatIndex: 0, userKey: user.toString(16).padStart(16, '0'),
    candidateIds: ids, rankedIds: ids, presentedIds: [], kEff: ids.length, flags: ['short_list'],
    targetRank: 1, inCandidates: true, targetPopularity: 2, coldTarget: false,
    repairs: zeroRepairs(), formatFailure: false, callIds: [] };
}
describe('computed report', () => {
  it('pools novelty and head share across recommendation pairs, not user means', () => {
    // what_bug_this_catches: a one-item short list getting the same aggregate weight as a ten-item list.
    const rows = ARM_IDS.flatMap((arm) => [row(arm, 1, [1]), row(arm, 2, [2, 3, 4])]);
    const report = buildReport({ rows, calls: [], train: buildTrainingData(toyRows(), T, toyItems()), mode: 'mock', primaryArm: 'llm-list', seed: 38 });
    const llm = report.table.find((r) => r.arm === 'llm-list')!;
    const expected = (-Math.log2(2 / 14) * 3 - Math.log2(3 / 14)) / 4;
    expect(llm.metrics.novelty10.kind).toBe('value');
    if (llm.metrics.novelty10.kind === 'value') expect(llm.metrics.novelty10.value).toBeCloseTo(expected, 12);
    expect(llm.metrics.headShare10).toEqual({ kind: 'value', value: 1 / 4 });
    expect(report.verdict.verdict).toBe('insufficient data');
    const markdown = resultsMarkdown(report);
    expect(markdown).toContain(MOCK_STAMP);
    for (const column of ['HR@10', 'NDCG@10', '95% CI', 'MRR@K', 'Ceiling', 'Coverage@10', 'Novelty', 'Head share@10',
      'Cost/user USD', 'Mean latency ms', 'Format failures/user', 'Repairs/user', '| n |']) expect(markdown).toContain(column);
    expect(markdown).not.toContain('NaN');
  });
  it('failure list contains only kNN<=10 and model>10/absent, preserving format failures', () => {
    const rows = [row('itemknn', 1, [1]), { ...row('llm-list', 1, [1]), targetRank: 11, formatFailure: true },
      { ...row('jev-point', 1, [1]), targetRank: null }, { ...row('itemknn', 2, [1]), targetRank: 11 },
      { ...row('llm-list', 2, [1]), targetRank: null }, row('jev-point', 3, [1])];
    expect(failureList(rows)).toEqual([
      { userKey: '0000000000000001', arm: 'jev-point', knnRank: 1, modelRank: null, formatFailure: false },
      { userKey: '0000000000000001', arm: 'llm-list', knnRank: 1, modelRank: 11, formatFailure: true },
    ]);
  });
});
