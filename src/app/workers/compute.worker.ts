// This worker is a target-aware composition root. Arms receive only contexts, never the split/scorer.
import { loadDataset } from '../../core/data/movielens.ts';
import { generateSynthetic, type FormatChaosMode } from '../../core/data/synthetic.ts';
import { freezeManifest, loadManifest, splitFromManifest, userKeyOf } from '../../core/split/manifest.ts';
import { temporalSplit } from '../../core/split/temporal.ts';
import { buildTrainingData } from '../../core/arms/train.ts';
import { contextsForUsers } from '../../core/split/contexts.ts';
import { prepareBrowserDesign } from '../../core/report/browser-design.ts';
import { prepareEvaluation, selectMockModels } from '../../core/report/prepare.ts';
import { createMemoryCache, createMemoryLedger } from '../../core/ledger/memory.ts';
import { createMockProvider, createMockRerankClient, mockParams, MOCK_MODEL } from '../../core/providers/mock.ts';
import { FrozenConfigSchema } from '../../core/prereg/schema.ts';
import type { FrozenConfig } from '../../core/prereg/schema.ts';
import { hashCanonical } from '../../core/util/hash.ts';
import { designIssues, estimateDesign } from '../workflow.ts';
import type { WorkerRequest, WorkerResponse, LoadedData, Design } from './protocol.ts';

function load(request: Extract<WorkerRequest, { type: 'load' }>): LoadedData {
  const fixture = request.synthetic ? generateSynthetic(request.manifest?.seed ?? request.seed) : null;
  const files = fixture ? { uData: new TextEncoder().encode(fixture.uData), uItem: fixture.uItem } : request.files;
  if (!files) throw new Error('Select both u.data and u.item.');
  const loaded = loadDataset(files);
  if (!loaded.ok || loaded.report.rejectCount) {
    const message: WorkerResponse = { id: request.id, type: 'error', error: loaded.ok ? 'Rejected lines must be corrected before evaluation.' : loaded.error, report: loaded.report };
    postMessage(message); throw new Error('validation_report_posted');
  }
  const { dataset, report } = loaded;
  let manifest = request.manifest;
  if (manifest) {
    const checked = loadManifest(manifest, { datasetHash: dataset.hashes.datasetHash });
    if (!checked.ok) throw new Error(checked.error);
    const restored = splitFromManifest(dataset, manifest);
    if (!restored.ok) throw new Error(restored.error);
  } else {
    const { decision, split } = temporalSplit(dataset.interactions, { seed: request.seed });
    manifest = freezeManifest({ dataset, report, decision, split }, { randomSaltHex: request.salt, frozenAt: new Date().toISOString() });
  }
  const forcedModes: [string, FormatChaosMode][] = [];
  for (const trap of fixture?.traps ?? []) if (trap.kind === 'format-chaos') for (const a of trap.assignments)
    forcedModes.push([userKeyOf(manifest.salt, a.userId), a.mode]);
  return { dataset, report, manifest, forcedModes, synthetic: request.synthetic };
}

async function design(request: Extract<WorkerRequest, { type: 'design' }>): Promise<Design> {
  const { data, options: o } = request;
  const { dataset, manifest } = data;
  const derived = splitFromManifest(dataset, manifest);
  if (!derived.ok) throw new Error(derived.error);
  const split = derived.split;
  const ids = o.split === 'dev' ? split.devUserIds : split.heldoutUserIds;
  const train = buildTrainingData(dataset.interactions, manifest.T, dataset.items);
  let tuning: Design['tuning'] = null;
  let selected = false; let devDiffs = o.devDiffs;
  let frozen: FrozenConfig;
  if (o.mode === 'live' && o.split === 'heldout') {
    if (!o.prereg) throw new Error('Import a dated preregistration selected from live dev evidence.');
    if (o.prereg.datasetHash !== dataset.hashes.datasetHash || o.prereg.manifestHash !== manifest.manifestHash)
      throw new Error('Preregistration differs from the loaded files or frozen manifest. Import the matching manifest lock.');
    if (!(Date.parse(o.prereg.datedAt) < Date.now())) throw new Error('Preregistration must be dated before start.');
    frozen = o.prereg.config;
    if (frozen.mock !== null || Object.values(frozen.models).some((p) => p.provider === 'mock')) throw new Error('Mock choices cannot authorize held-out live evidence.');
    if (frozen.seed !== manifest.seed) throw new Error('Preregistered seed differs from the manifest.');
    selected = true;
  } else {
    const seed = manifest.seed;
    const base = {
      schemaVersion: 1 as const, seed, tunedWeights: { knn: 1, recency: 0, genre: 0 },
      llmListPromptVersion: o.prompt, jevPromptVersion: 'jev-point.v1' as const, primaryArm: o.primary,
      bootstrapResamples: 10000 as const, practicalMarginNdcg: 0.01 as const, probeSampleSeed: seed, probeSampleMax: 150 as const,
      models: o.mode === 'mock' ? { 'llm-list': { provider: 'mock', model: MOCK_MODEL }, 'jev-point': { provider: 'mock', model: MOCK_MODEL } }
        : { 'llm-list': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'jev-point': { provider: 'typesafe', model: 'jev-1.13.0' } },
      mock: o.mode === 'mock' ? { preset: o.preset, seed, forcedModesHash: hashCanonical([...data.forcedModes].sort()) } : null,
    };
    const preparedDesign = prepareBrowserDesign(dataset, manifest, o.split, (contexts, candidateK) => {
      if (o.mode === 'mock') return true;
      // k does not enter model prompt serialization; this is a bound-only temporary config.
      const cfg = FrozenConfigSchema.parse({ ...base, knnK: 20, K: candidateK });
      return designIssues(estimateDesign(contexts, cfg, dataset.hashes.datasetHash), cfg, o.mode, o.caps).length === 0;
    });
    tuning = preparedDesign.tuning;
    frozen = FrozenConfigSchema.parse({ ...base, knnK: preparedDesign.params.k, K: preparedDesign.params.K, tunedWeights: tuning.weights.weights });
    if (o.mode === 'mock' && o.selectMock) {
      const prepared = prepareEvaluation(dataset, manifest, split);
      const client = createMockRerankClient({ adapter: createMockProvider(mockParams(o.preset, seed, { forcedModes: new Map(data.forcedModes) })),
        cache: createMemoryCache(), ledger: createMemoryLedger() });
      const choices = await selectMockModels(prepared, client, { runId: 'mock-dev-selection', configHash: hashCanonical(frozen), datasetHash: dataset.hashes.datasetHash, seed });
      frozen = FrozenConfigSchema.parse({ ...frozen, llmListPromptVersion: choices.llmListPromptVersion, primaryArm: choices.primaryArm });
      devDiffs = choices.devDiffs; selected = true;
    }
  }
  const contexts = contextsForUsers(split, ids, manifest.salt, train, dataset.itemById, { k: frozen.knnK, K: frozen.K });
  const estimate = estimateDesign(contexts, frozen, dataset.hashes.datasetHash);
  const issues = designIssues(estimate, frozen, o.mode, o.caps);
  if (!contexts.length) issues.push('No eligible users in this split.');
  return { frozen, tuning, estimate, devDiffs, selected, issues };
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const request = event.data;
  void (async () => {
    try {
      const response: WorkerResponse = request.type === 'load'
        ? { id: request.id, type: 'loaded', data: load(request) }
        : { id: request.id, type: 'designed', design: await design(request) };
      postMessage(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Computation failed.';
      if (message !== 'validation_report_posted') postMessage({ id: request.id, type: 'error', error: message } satisfies WorkerResponse);
    }
  })();
};
