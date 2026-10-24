import type { TrainingData } from '../arms/train.ts';
import type { CallRow } from '../ledger/types.ts';
import { totalsOf } from '../ledger/types.ts';
import { pairedVectors, summarizeArm, type ArmMetrics } from '../metrics/ranking.ts';
import { positionBiasIndex } from '../probes/position-bias.ts';
import { summarizeRepeat } from '../probes/repeat.ts';
import { evalOf, type ResultRow } from '../runner/store.ts';
import { pairedBootstrap, type BootstrapOutcome } from '../stats/bootstrap.ts';
import { computeMde } from '../stats/mde.ts';
import { verdictFrom } from '../stats/verdict.ts';
import { failureList } from './failure-list.ts';

export interface ReportRow {
  arm: ResultRow['arm']; variant: ResultRow['variant']; metrics: ArmMetrics;
  vsItemknn: BootstrapOutcome; vsTuned: BootstrapOutcome | null; vsBase: BootstrapOutcome | null;
  costPerUserMicro: number | null; meanLatencyMs: number | null; formatFailureRate: number | null;
  repairsPerUser: { unknown: number | null; repeat: number | null; missing: number | null; emptyRanking: number | null };
}
const mean = (xs: readonly number[]): number | null => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

export function buildReport(input: { rows: readonly ResultRow[]; calls: readonly CallRow[]; train: TrainingData;
  mode: 'mock' | 'live'; primaryArm: 'llm-list' | 'jev-point'; seed: number; devDiffs?: readonly number[]; practicalMarginNdcg?: number }) {
  const { rows, calls, train } = input;
  const groups = new Map<string, ResultRow[]>();
  for (const r of rows) { const key = `${r.arm}|${r.variant}`; const group = groups.get(key) ?? []; group.push(r); groups.set(key, group); }
  const compare = (a: readonly ResultRow[], arm: ResultRow['arm']): BootstrapOutcome => {
    const users = new Set(a.map((r) => r.userKey));
    const control = rows.filter((r) => r.arm === arm && r.variant === 'base' && users.has(r.userKey));
    const pair = pairedVectors(a.map(evalOf), control.map(evalOf));
    return pairedBootstrap(pair.a, pair.b, { seed: input.seed });
  };
  const table: ReportRow[] = [];
  for (const group of groups.values()) {
    const { arm, variant } = group[0];
    const requestUsers = new Set(group.map((r) => `${r.runId}|${r.userKey}|${r.repeatIndex}`));
    // Include attempts persisted before a crash, even if a resumed response references only its latest attempt.
    const attempts = calls.filter((r) => r.arm === arm && r.variant === variant && requestUsers.has(`${r.runId}|${r.userKey}|${r.repeatIndex}`));
    const users = new Set(group.map((r) => r.userKey));
    const base = rows.filter((r) => r.arm === arm && r.variant === 'base' && users.has(r.userKey));
    const pair = pairedVectors(group.map(evalOf), base.map(evalOf));
    table.push({ arm, variant, metrics: summarizeArm(group.map(evalOf), train), vsItemknn: compare(group, 'itemknn'),
      vsTuned: arm === 'llm-list' || arm === 'jev-point' ? compare(group, 'tuned-rerank') : null,
      vsBase: variant === 'base' ? null : pairedBootstrap(pair.a, pair.b, { seed: input.seed }),
      costPerUserMicro: group.length ? attempts.reduce((s, r) => s + r.costMicro, 0) / group.length : null,
      // Latency is total attempted latency per user, including failures and zero-call users.
      meanLatencyMs: group.length ? attempts.reduce((s, r) => s + r.latencyMs, 0) / group.length : null,
      formatFailureRate: mean(group.map((r) => Number(r.formatFailure))),
      repairsPerUser: { unknown: mean(group.map((r) => r.repairs.unknown)), repeat: mean(group.map((r) => r.repairs.repeat)),
        missing: mean(group.map((r) => r.repairs.missing)), emptyRanking: mean(group.map((r) => r.repairs.emptyRanking)) },
    });
  }
  const primary = table.find((r) => r.arm === input.primaryArm && r.variant === 'base');
  const jev = table.find((r) => r.arm === 'jev-point' && r.variant === 'base');
  const llm = table.find((r) => r.arm === 'llm-list' && r.variant === 'base');
  let jevAnnotation = 'not recommended';
  if (jev?.vsItemknn.ok && jev.vsTuned?.ok && llm) {
    const a = jev.vsItemknn.result; const b = jev.vsTuned.result;
    if (a.ciLow > 0 && b.ciLow > 0) jevAnnotation = 'recommended';
    else if (a.ciLow <= 0 && a.ciHigh >= 0 && b.ciLow <= 0 && b.ciHigh >= 0 &&
      jev.costPerUserMicro !== null && llm.costPerUserMicro !== null && jev.costPerUserMicro <= llm.costPerUserMicro * 0.5 &&
      jev.metrics.ndcg10.kind === 'value' && llm.metrics.ndcg10.kind === 'value' &&
      jev.metrics.ndcg10.value >= llm.metrics.ndcg10.value - (input.practicalMarginNdcg ?? 0.01)) jevAnnotation = 'inconclusive quality, lower model cost';
  }
  const llmBase = new Map(rows.filter((r) => r.arm === 'llm-list' && r.variant === 'base').map((r) => [r.userKey, r]));
  const repeated = rows.filter((r) => r.arm === 'llm-list' && r.variant === 'repeat');
  const shuffled = rows.filter((r) => r.arm === 'llm-list' && r.variant === 'cand_shuffled');
  return { mode: input.mode, primaryArm: input.primaryArm, table,
    verdict: verdictFrom(primary?.vsItemknn ?? { ok: false, n: 0, reason: 'no primary rows' }), jevAnnotation,
    mde: computeMde(input.devDiffs ?? [], primary?.metrics.n ?? 0), failures: failureList(rows),
    repeat: summarizeRepeat(repeated.map((r) => ({ base: llmBase.get(r.userKey)?.rankedIds ?? [], repeat: r.rankedIds }))),
    positionBias: positionBiasIndex(shuffled.filter((r) => r.presentedIds.length > 0).map((r) => ({ presented: r.presentedIds, output: r.rankedIds })), { seed: input.seed }),
    ledger: totalsOf(calls),
  };
}
export type EvaluationReport = ReturnType<typeof buildReport>;
