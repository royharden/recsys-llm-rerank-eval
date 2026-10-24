import { useMemo } from 'react';
import { formatMetric } from '../../core/metrics/ranking.ts';
import { formatMde } from '../../core/stats/mde.ts';
import type { BootstrapOutcome } from '../../core/stats/bootstrap.ts';
import { MOCK_STAMP } from '../../core/report/results-md.ts';
import { reconstructLocalInspection, type LocalInspection } from '../../core/report/local-inspection.ts';
import type { FailureCase } from '../../core/report/failure-list.ts';
import { formatMicro } from '../../core/budget/estimate.ts';
import type { ConsoleState } from '../state.ts';
import { downloadText } from '../workflow.ts';
import { completedResultsMarkdown } from '../results-export.ts';
import { Header, Empty, Table, numeric } from '../components/common.tsx';

const ci = (value: BootstrapOutcome | null): string => !value ? '—' : value.ok
  ? `${numeric(value.result.meanDiff)} [${numeric(value.result.ciLow)}, ${numeric(value.result.ciHigh)}] (n=${value.result.n})`
  : `unavailable: ${value.reason}`;

export function Results({ app }: { app: ConsoleState }) {
  const out = app.output; const report = out?.complete ? out.report : null;
  const manifest = app.run?.config.manifest ?? app.plan?.config.manifest;
  const dataset = app.data?.dataset;
  const local = useMemo(() => reconstructLocalInspection(dataset, manifest, out?.identity), [dataset, manifest, out?.identity]);
  function exportResults(format: 'md' | 'jsonl') {
    if (!out?.complete || !report) return;
    const stamp = out.identity.mode === 'mock' ? MOCK_STAMP : out.identity.split === 'dev' ? 'DEV LIVE: exploratory selection, not held-out evidence' : 'HELD-OUT LIVE';
    const name = `${out.identity.mode === 'mock' ? 'MOCK-' : ''}${out.identity.split}-${out.identity.runId}`;
    if (format === 'md') {
      const text = completedResultsMarkdown(out);
      downloadText(`${name}.md`, text, 'text/markdown;charset=utf-8');
    } else {
      const records = [{ type: 'meta', value: { ...out.identity, stamp, complete: out.complete, frozen: out.frozen } },
        ...out.calls.map((value) => ({ type: 'call', value })), ...out.rows.map((value) => ({ type: 'result', value }))];
      downloadText(`${name}.jsonl`, records.map((row) => JSON.stringify(row)).join('\n') + '\n', 'application/x-ndjson');
    }
  }
  return <><Header eyebrow="03 / Results" title="What changed on the same users?">Every metric comes from stored per-user rankings and per-attempt calls. Paired intervals resample users 10,000 times. Failures remain in the comparison.</Header>
    {!report || !out ? <Empty>{out ? `Incomplete run: ${out.rows.length} rows and ${out.calls.length} attempts retained. Resume the frozen run to compute the final report.` : 'No computed report yet. Complete a run or load a finished persisted run.'}<button className="secondary" onClick={() => app.setPage('Run')}>Open Run</button></Empty> : <>
      {out.identity.mode === 'mock' && <p className="notice warning"><strong>{MOCK_STAMP}</strong></p>}
      {out.identity.mode === 'live' && out.identity.split === 'dev' && <p className="notice warning">DEV LIVE: exploratory selection. This is not held-out evidence; the primary shown here was provisional. Compare dev trials before dating the preregistration.</p>}
      <section className="card"><h2>{report.verdict.verdict}</h2><p>Primary: <strong>{report.primaryArm}</strong> versus itemknn.</p>{report.verdict.notes.map((s) => <p key={s}>{s}</p>)}{report.verdict.warnings.map((s) => <p className="notice warning" key={s}>{s}</p>)}
        {(app.run?.config.manifest ?? app.data?.manifest)?.insufficientPrecision && <p className="notice warning">The split did not reach 150 held-out users. Read small-data results with the reported n and uncertainty.</p>}
        <p>{formatMde(report.mde)}</p><p>Jev usefulness (exploratory): <strong>{report.jevAnnotation}</strong>.</p><p className="muted">A confidence interval spanning zero is not equivalence. A null or negative result is a valid outcome. Masking does not remove memorisation.</p><div className="actions"><button onClick={() => exportResults('md')}>Download computed Markdown</button><button className="secondary" onClick={() => exportResults('jsonl')}>Download JSONL rows + ledger</button></div>
      </section>
      <section className="card"><h2>All arms and probe variants</h2><Table caption={`${out.identity.mode.toUpperCase()} ${out.identity.split}: computed evaluation table`} headings={['Arm / variant', 'HR@10', 'NDCG@10', 'Δ vs itemknn [95% CI]', 'Δ vs tuned-rerank [95% CI]', 'MRR@K', 'Shared ceiling', 'Own top-K share', 'Coverage@10', 'Novelty', 'Head share@10', 'Cost / user', 'Latency ms / user', 'Format failure rate', 'Repairs unknown / repeat / missing / empty', 'n']}>
        {report.table.map((r) => <tr key={`${r.arm}/${r.variant}`}><th scope="row">{r.arm} / {r.variant}</th><td>{formatMetric(r.metrics.hr10)}</td><td>{formatMetric(r.metrics.ndcg10)}</td><td>{ci(r.vsItemknn)}</td><td>{ci(r.vsTuned)}</td><td>{formatMetric(r.metrics.mrrK)}</td><td>{formatMetric(r.metrics.ceiling)}</td><td>{formatMetric(r.metrics.ownPoolShare)}</td><td>{formatMetric(r.metrics.coverage10)}</td><td>{formatMetric(r.metrics.novelty10)}</td><td>{formatMetric(r.metrics.headShare10)}</td><td>{formatMicro(r.costPerUserMicro)}</td><td>{numeric(r.meanLatencyMs)}</td><td>{numeric(r.formatFailureRate)}</td><td>{numeric(r.repairsPerUser.unknown)} / {numeric(r.repairsPerUser.repeat)} / {numeric(r.repairsPerUser.missing)} / {numeric(r.repairsPerUser.emptyRanking)}</td><td>{r.metrics.n}</td></tr>)}
      </Table><p className="muted">Novelty and head share pool recommended top-10 user/item pairs, including short lists. Latency sums attempted latency per user, including failures and zero-call users.</p></section>
      <section className="card"><h2>Exploratory probes</h2><Table caption="Each probe compared with its matched base subset" headings={['Arm / probe', 'ΔNDCG@10 [95% CI]', 'n']}>{report.table.filter((r) => r.variant !== 'base').map((r) => <tr key={`${r.arm}/${r.variant}`}><td>{r.arm} / {r.variant}{r.variant === 'masked' ? ' (masked − unmasked)' : ''}</td><td>{ci(r.vsBase)}</td><td>{r.metrics.n}</td></tr>)}</Table>
        <p>Position-bias index: {report.positionBias.kind === 'value' ? `${numeric(report.positionBias.mean)} [${numeric(report.positionBias.ciLow)}, ${numeric(report.positionBias.ciHigh)}]; n=${report.positionBias.n}; flagged=${report.positionBias.flagged}` : `unavailable: ${report.positionBias.reason}`}.</p><p>Repeat top-1 agreement {numeric(report.repeat.top1Agreement)} (n={report.repeat.n}); Kendall τ {numeric(report.repeat.meanKendallTau)} (n={report.repeat.tauN}).</p>
      </section>
      <section className="card"><h2>Conditional on target in kNN top-K</h2><Table caption="Exploratory conditional metrics, with their own denominators" headings={['Arm', 'HR@10', 'NDCG@10', 'MRR@K', 'n']}>{report.table.filter((r) => r.variant === 'base').map((r) => <tr key={r.arm}><td>{r.arm}</td><td>{formatMetric(r.metrics.conditional.hr10)}</td><td>{formatMetric(r.metrics.conditional.ndcg10)}</td><td>{formatMetric(r.metrics.conditional.mrrK)}</td><td>{r.metrics.conditional.n}</td></tr>)}</Table></section>
      <section className="card"><h2>Target popularity terciles</h2><Table caption="Exploratory slices by pre-cutoff target popularity" headings={['Arm', 'Tercile', 'NDCG@10', 'HR@10', 'n']}>{report.table.filter((r) => r.variant === 'base').flatMap((r) => r.metrics.terciles.map((t) => <tr key={`${r.arm}/${t.tercile}`}><td>{r.arm}</td><td>{t.tercile}</td><td>{formatMetric(t.ndcg10)}</td><td>{formatMetric(t.hr10)}</td><td>{t.n}</td></tr>))}</Table></section>
      <FailureList failures={report.failures} local={local} setPage={app.setPage} />
    </>}
  </>;
}

/** Titles stay in this local view; report failure records and result exports remain unchanged. */
export function FailureList({ failures, local, setPage }: {
  failures: readonly FailureCase[]; local: LocalInspection | null; setPage: ConsoleState['setPage'];
}) {
  const missingTitles = failures.some((r) => !local?.targetTitles.has(r.userKey));
  return <section className="card"><h2>Failure list ({failures.length})</h2><p>Cases where itemknn placed the target in its top 10 and the model moved it below 10 or out of the list. Titles are resolved only from matching local source files.</p>
    {missingTitles && <p className="notice warning" role="status">Target titles unavailable. Reselect the original source files with matching hashes in Data. <button className="secondary" onClick={() => setPage('Data')}>Reselect matching files</button></p>}
    {failures.length ? <Table caption="Failure cases (first 100)" headings={['User key', 'Demoted target title (local)', 'Model arm', 'kNN target rank', 'Model target rank', 'Format failure']}>{failures.slice(0, 100).map((r) => <tr key={`${r.userKey}/${r.arm}`}><td className="mono">{r.userKey}</td><td>{local?.targetTitles.get(r.userKey) ?? 'Unavailable — reselect matching files in Data'}</td><td>{r.arm}</td><td>{r.knnRank}</td><td>{r.modelRank ?? 'absent'}</td><td>{String(r.formatFailure)}</td></tr>)}</Table> : <p>No failures under this definition.</p>}
    <button className="secondary" onClick={() => setPage('Inspector')}>Inspect users and rankings</button>
  </section>;
}
