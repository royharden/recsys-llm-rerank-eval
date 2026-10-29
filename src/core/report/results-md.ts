import { formatMetric } from '../metrics/ranking.ts';
import type { BootstrapOutcome } from '../stats/bootstrap.ts';
import { formatMde } from '../stats/mde.ts';
import type { EvaluationReport } from './table.ts';

export const MOCK_STAMP = 'MOCK: simulated, not a measurement';
const num = (n: number | null): string => n === null ? 'unavailable' : n.toFixed(4);
const ci = (b: BootstrapOutcome | null): string => !b ? '—' : b.ok
  ? `${num(b.result.meanDiff)} [${num(b.result.ciLow)}, ${num(b.result.ciHigh)}]` : `unavailable: ${b.reason}`;

/** Every value in the table is derived by buildReport from per-user and per-attempt rows. */
export function resultsMarkdown(report: EvaluationReport): string {
  const stamp = report.mode === 'mock' ? MOCK_STAMP : 'Held-out live evaluation';
  const out = ['# Recommender offline evaluation', '', `**${stamp}**`, '',
    `Primary: ${report.primaryArm}. Verdict: **${report.verdict.verdict}**.`,
    ...report.verdict.notes, ...report.verdict.warnings, '', formatMde(report.mde), '',
    '| Arm / variant | HR@10 | NDCG@10 | Δ vs itemknn (95% CI) | Δ vs tuned-rerank (95% CI) | MRR@K | Ceiling | Own top-K share | Coverage@10 | Novelty | Head share@10 | Cost/user USD | Mean latency ms | Format failures/user | Repairs/user unknown/repeat/missing/empty | n |',
    '|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|'];
  for (const r of report.table) {
    const m = r.metrics;
    out.push(`| ${r.arm} / ${r.variant} | ${formatMetric(m.hr10)} | ${formatMetric(m.ndcg10)} | ${ci(r.vsItemknn)} | ${ci(r.vsTuned)} | ${formatMetric(m.mrrK)} | ${formatMetric(m.ceiling)} | ${formatMetric(m.ownPoolShare)} | ${formatMetric(m.coverage10)} | ${formatMetric(m.novelty10)} | ${formatMetric(m.headShare10)} | ${r.costPerUserMicro === null ? 'unavailable' : (r.costPerUserMicro / 1e6).toFixed(6)} | ${num(r.meanLatencyMs)} | ${num(r.formatFailureRate)} | ${num(r.repairsPerUser.unknown)}/${num(r.repairsPerUser.repeat)}/${num(r.repairsPerUser.missing)}/${num(r.repairsPerUser.emptyRanking)} | ${m.n} |`);
  }
  out.push('', 'Novelty and head share pool all recommended top-10 (user,item) pairs, including short lists; they are not means of user means.', '',
    '## Exploratory probes', '', '| Arm / probe | ΔNDCG@10 vs matched base subset (95% CI) | n |', '|---|---|---:|');
  for (const r of report.table) if (r.variant !== 'base') out.push(`| ${r.arm} / ${r.variant}${r.variant === 'masked' ? ' (masked − unmasked)' : ''} | ${ci(r.vsBase)} | ${r.metrics.n} |`);
  const b = report.positionBias;
  out.push('', b.kind === 'value' ? `Position-bias index: ${num(b.mean)} [${num(b.ciLow)}, ${num(b.ciHigh)}]; n=${b.n}; flagged=${b.flagged}.`
    : `Position-bias index unavailable: ${b.reason}.`,
    `Repeat top-1 agreement: ${num(report.repeat.top1Agreement)} (n=${report.repeat.n}); Kendall τ: ${num(report.repeat.meanKendallTau)} (n=${report.repeat.tauN}).`,
    `Jev usefulness (exploratory): ${report.jevAnnotation}.`, '', '## Conditional on target in kNN top-K (exploratory)', '',
    '| Arm | HR@10 | NDCG@10 | MRR@K | n |', '|---|---:|---:|---:|---:|');
  for (const r of report.table.filter((r) => r.variant === 'base')) {
    const c = r.metrics.conditional; out.push(`| ${r.arm} | ${formatMetric(c.hr10)} | ${formatMetric(c.ndcg10)} | ${formatMetric(c.mrrK)} | ${c.n} |`);
  }
  out.push('', '## Target popularity terciles (exploratory)', '', '| Arm | Tercile | NDCG@10 | HR@10 | n |', '|---|---|---:|---:|---:|');
  for (const r of report.table.filter((r) => r.variant === 'base')) for (const t of r.metrics.terciles) out.push(`| ${r.arm} | ${t.tercile} | ${formatMetric(t.ndcg10)} | ${formatMetric(t.hr10)} | ${t.n} |`);
  out.push('', '## Failure list', '', `Total: ${report.failures.length}; excerpt capped at 20 pseudonymous users/cases.`, '',
    '| User key | Model arm | kNN target rank | Model target rank | Format failure |', '|---|---|---:|---:|---|');
  for (const r of report.failures.slice(0, 20)) out.push(`| ${r.userKey} | ${r.arm} | ${r.knnRank} | ${r.modelRank ?? 'absent'} | ${r.formatFailure} |`);
  out.push('', '## Ledger', '', `Attempts: ${report.ledger.attempts}; cache hits: ${report.ledger.cacheHits}; total cost: $${(report.ledger.costMicro / 1e6).toFixed(6)} (Σ attempt rows).`, '',
    '| Arm | Attempts | Cost USD | Cache hits |', '|---|---:|---:|---:|');
  for (const [arm, t] of Object.entries(report.ledger.byArm)) out.push(`| ${arm} | ${t.attempts} | ${(t.costMicro / 1e6).toFixed(6)} | ${t.cacheHits} |`);
  out.push('', 'Failure and repair rows remain in every denominator. A CI spanning zero is not equivalence. Masking does not remove memorisation.', '');
  return out.join('\n');
}
