import { MOCK_STAMP, resultsMarkdown } from '../core/report/results-md.ts';
import type { EvaluationReport } from '../core/report/table.ts';
import type { RunIdentity } from '../core/runner/store.ts';

/** Export computed completed output only; no local target/title reconstruction or private manifest enters the artifact. */
export function completedResultsMarkdown(out: { identity: RunIdentity; complete: boolean; report: EvaluationReport | null }): string {
  if (!out.complete || !out.report) throw new Error('Complete the frozen run before exporting a final report.');
  const { identity, report } = out;
  if (identity.mode !== report.mode) throw new Error('Report mode differs from the frozen run identity.');
  const stamp = identity.mode === 'mock' ? MOCK_STAMP : identity.split === 'dev'
    ? 'DEV LIVE: exploratory selection, not held-out evidence' : 'HELD-OUT LIVE';
  const provenance = ['## Run provenance', '', `- Run ID: \`${identity.runId}\``, `- Split: ${identity.split}`,
    `- Mode: ${identity.mode}`, '- Complete: true', `- Dataset hash: \`${identity.datasetHash}\``,
    `- Manifest hash: \`${identity.manifestHash}\``, `- Config hash: \`${identity.configHash}\``,
    `- Preregistration hash: ${identity.preregHash ? `\`${identity.preregHash}\`` : 'none (not preregistered)'}`, ''];
  return resultsMarkdown(report).replace('Held-out live evaluation', stamp) + '\n' + provenance.join('\n');
}
