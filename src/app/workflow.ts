import { dryRun, type DryRun } from '../core/budget/estimate.ts';
import { PRICE_TABLE, liveGate, priceFor } from '../core/contracts/prices.ts';
import type { FrozenConfig } from '../core/prereg/schema.ts';
import type { UserContext } from '../core/split/context.ts';
import { sampleProbeUsers } from '../core/probes/orderprobe.ts';
import { configHashOf } from '../core/prereg/schema.ts';
import type { Caps } from './workers/protocol.ts';

export function estimateDesign(contexts: readonly UserContext[], frozen: FrozenConfig, datasetHash: string): DryRun {
  const common = { runId: 'dry-run', configHash: configHashOf(frozen), datasetHash, seed: frozen.seed };
  return dryRun({ contexts, probeUserKeys: new Set(sampleProbeUsers(contexts.map((c) => c.userKey), frozen.probeSampleSeed, frozen.probeSampleMax)),
    arms: ['llm-list', 'jev-point'], configs: {
      'llm-list': { ...common, promptVersion: frozen.llmListPromptVersion },
      'jev-point': { ...common, promptVersion: frozen.jevPromptVersion },
    }, pricing: frozen.models, prices: PRICE_TABLE });
}

/** Both arms include their probes; the probe cap also overlaps both arms. Never reduce the schedule to fit. */
export function designIssues(estimate: DryRun, frozen: FrozenConfig, mode: 'mock' | 'live', caps: Caps): string[] {
  const issues: string[] = [];
  if (Object.values(caps).some((n) => !Number.isSafeInteger(n) || n < 0)) issues.push('Caps must be non-negative integer microdollars.');
  for (const line of estimate.lines) if (line.unavailable) issues.push(`${line.arm}/${line.variant}: ${line.unavailable}`);
  if (mode === 'live') for (const pin of Object.values(frozen.models)) {
    const gate = liveGate(PRICE_TABLE, pin.provider, pin.model);
    if (!gate.ok) issues.push(gate.detail);
    if (!priceFor(PRICE_TABLE, pin.provider, pin.model)?.priceVerified) issues.push(`${pin.provider}/${pin.model}: price is unverified.`);
  }
  const total = estimate.totals.worstCaseMicro;
  if (total === null || total > caps.total) issues.push('Worst-case total is unavailable or exceeds the run cap.');
  for (const arm of ['llm-list', 'jev-point'] as const) {
    const bound = estimate.byArm[arm]?.worstCaseMicro;
    if (bound === null || bound === undefined || bound > caps[arm]) issues.push(`${arm}: worst-case total is unavailable or exceeds its arm cap.`);
  }
  const probes = estimate.lines.filter((l) => l.variant !== 'base');
  if (probes.some((l) => l.worstCaseMicro === null) || probes.reduce((sum, l) => sum + (l.worstCaseMicro ?? 0), 0) > caps.probe)
    issues.push('Overlapping probe worst-case total is unavailable or exceeds the probe cap.');
  return [...new Set(issues)];
}

export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
