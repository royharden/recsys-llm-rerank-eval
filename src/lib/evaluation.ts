// Browser/CLI persisted composition. Targets stop in core/report; runner receives only a scoring closure.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Dataset } from '../core/data/types.ts';
import { dryRun } from '../core/budget/estimate.ts';
import { PRICE_TABLE } from '../core/contracts/prices.ts';
import type { FormatChaosMode } from '../core/data/synthetic.ts';
import { createMemoryCache, createMemoryLedger } from '../core/ledger/memory.ts';
import type { FrozenConfig, Prereg } from '../core/prereg/schema.ts';
import { createEdgeRerankClient } from '../core/providers/edge.ts';
import { createMockProvider, createMockRerankClient, mockParams } from '../core/providers/mock.ts';
import { createFrozenArms, reconstructFrozenEvaluation, assertFrozenExpectations } from '../core/report/resume.ts';
import { buildReport } from '../core/report/table.ts';
import { expectedResults, runEvaluation, type RunInput } from '../core/runner/run.ts';
import type { RunIdentity } from '../core/runner/store.ts';
import type { Manifest } from '../core/split/manifest.ts';
import { hashCanonical } from '../core/util/hash.ts';
import { configHashOf } from '../core/prereg/schema.ts';
import { PersistedConfigSchema, identityOfRun, validatePersistedRun, type PersistedConfig, type PersistedRun } from './run-config.ts';
import { createRunLifecycle, createSupabaseStore } from './supabase-store.ts';
import type { PublicSupabaseConfig } from './supabase.ts';

function frozenMockClient(config: FrozenConfig, forcedModes: ReadonlyMap<string, FormatChaosMode>, ledger = createMemoryLedger()) {
  if (!config.mock || config.mock.forcedModesHash !== hashCanonical([...forcedModes.entries()].sort()))
    throw new Error('mock behavior differs from frozen config; reselect the original synthetic fixture/traps');
  return createMockRerankClient({ adapter: createMockProvider(mockParams(config.mock.preset, config.mock.seed, { forcedModes })),
    ledger, cache: createMemoryCache() });
}
export function preparePersistedConfig(input: {
  identity: RunIdentity; dataset: Dataset; manifest: Manifest; frozen: FrozenConfig; prereg: Prereg | null;
  devDiffs: number[]; clients: Parameters<typeof createFrozenArms>[3];
}): PersistedConfig {
  if (configHashOf(input.frozen) !== input.identity.configHash || input.manifest.manifestHash !== input.identity.manifestHash ||
    input.manifest.datasetHash !== input.identity.datasetHash) throw new Error('freeze identity mismatch');
  const prepared = reconstructFrozenEvaluation(input.dataset, input.manifest, input.frozen, input.identity.split);
  const arms = createFrozenArms(prepared, input.identity, input.frozen, input.clients);
  return PersistedConfigSchema.parse({ schemaVersion: 1, manifest: input.manifest, frozen: input.frozen,
    expectedResults: expectedResults({ identity: input.identity, contexts: prepared.contexts, arms, probeUserKeys: prepared.probeUserKeys }),
    candidateCounts: prepared.candidateCounts,
    probeUserKeys: [...prepared.probeUserKeys].sort(), devDiffs: input.devDiffs, prereg: input.prereg });
}
export async function runPersistedEvaluation(client: SupabaseClient, publicConfig: PublicSupabaseConfig, input: PersistedRun,
  dataset: Dataset, options: { forcedModes?: ReadonlyMap<string, FormatChaosMode>; signal?: AbortSignal;
    onProgress?: RunInput['onProgress']; dryRun?: boolean } = {}) {
  const run = validatePersistedRun(input);
  const identity = identityOfRun(run); const config = run.config.frozen;
  const prepared = reconstructFrozenEvaluation(dataset, run.config.manifest, config, identity.split);
  if (hashCanonical([...prepared.probeUserKeys].sort()) !== hashCanonical([...run.config.probeUserKeys].sort()))
    throw new Error('reconstructed probe sample differs from frozen run');
  const store = createSupabaseStore(client, run);
  await store.bind(identity);
  const ledger = createMemoryLedger(await store.calls());
  const mock = run.mode === 'mock' ? frozenMockClient(config, options.forcedModes ?? new Map(), ledger) : null;
  const clients = mock ? { 'llm-list': mock, 'jev-point': mock } : {
    'llm-list': createEdgeRerankClient({ client, ...publicConfig, provider: 'anthropic', model: config.models['llm-list'].model }),
    'jev-point': createEdgeRerankClient({ client, ...publicConfig, provider: 'typesafe', model: config.models['jev-point'].model }),
  };
  const arms = createFrozenArms(prepared, identity, config, clients);
  const schedule = { identity, contexts: prepared.contexts, arms, probeUserKeys: prepared.probeUserKeys };
  assertFrozenExpectations(run.config.expectedResults, run.config.candidateCounts, schedule);
  if (options.dryRun) {
    const armConfig = { runId: run.id, configHash: run.config_hash, datasetHash: run.dataset_hash, seed: config.seed };
    const estimate = dryRun({ contexts: prepared.contexts, probeUserKeys: prepared.probeUserKeys, arms: ['llm-list', 'jev-point'],
      configs: { 'llm-list': { ...armConfig, promptVersion: config.llmListPromptVersion },
        'jev-point': { ...armConfig, promptVersion: config.jevPromptVersion } }, pricing: config.models, prices: PRICE_TABLE });
    return { identity, config, expected: run.config.expectedResults.length, rows: await store.rows(),
      calls: await store.calls(), report: null, estimate };
  }
  // Completed runs are exported as-is: no lifecycle transition, rank call or re-tuning.
  const rows = run.state === 'complete' ? await store.rows() : await runEvaluation({ ...schedule, store, ledger,
    evaluate: prepared.evaluate, lifecycle: createRunLifecycle(client, run), signal: options.signal, onProgress: options.onProgress });
  if (run.state === 'complete') {
    const actual = new Set(rows.map((r) => [r.runId, r.arm, r.variant, r.repeatIndex, r.userKey].join('|')));
    if (actual.size !== run.config.expectedResults.length || run.config.expectedResults.some((k) =>
      !actual.has([k.runId, k.arm, k.variant, k.repeatIndex, k.userKey].join('|')))) throw new Error('complete run has incomplete frozen result set');
  }
  const calls = await store.calls();
  return { identity, config, expected: run.config.expectedResults.length, rows, calls, estimate: null,
    report: buildReport({ rows, calls, train: prepared.train, mode: run.mode, primaryArm: config.primaryArm,
      seed: config.seed, devDiffs: run.config.devDiffs, practicalMarginNdcg: config.practicalMarginNdcg }) };
}
