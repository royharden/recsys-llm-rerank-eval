// Explicit local MOCK or an existing console-approved persisted run. This CLI cannot approve runs.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createItemKnnArm } from '../src/core/arms/itemknn.ts';
import { createMostPopArm } from '../src/core/arms/mostpop.ts';
import { createRandomRerankArm } from '../src/core/arms/random-rerank.ts';
import { createTunedRerankArm } from '../src/core/arms/tuned-rerank.ts';
import { createLlmListArm } from '../src/core/arms/llm-list.ts';
import { createJevPointArm } from '../src/core/arms/jev-point.ts';
import { dryRun } from '../src/core/budget/estimate.ts';
import { PRICE_TABLE } from '../src/core/contracts/prices.ts';
import { loadDataset } from '../src/core/data/movielens.ts';
import { generateSynthetic, type FormatChaosMode } from '../src/core/data/synthetic.ts';
import { createMemoryCache, createMemoryLedger } from '../src/core/ledger/memory.ts';
import { loadOrFreezeManifest, readMovieLensBytes, readManifestLock } from '../src/core/node/fs-data.ts';
import { checkpointCliSession, cliPublicConfig, createCliSupabase, loginCli, logoutCli, restoreCliSession } from '../src/core/node/session.ts';
import { openJsonlStore } from '../src/core/node/jsonl-store.ts';
import { configHashOf, FrozenConfigSchema } from '../src/core/prereg/schema.ts';
import { sampleProbeUsers } from '../src/core/probes/orderprobe.ts';
import { createMockProvider, createMockRerankClient, mockParams, MOCK_MODEL, type MockPreset } from '../src/core/providers/mock.ts';
import { prepareEvaluation, selectMockModels } from '../src/core/report/prepare.ts';
import { buildReport } from '../src/core/report/table.ts';
import { MOCK_STAMP, resultsMarkdown } from '../src/core/report/results-md.ts';
import { runEvaluation } from '../src/core/runner/run.ts';
import { userKeyOf } from '../src/core/split/manifest.ts';
import { hashCanonical } from '../src/core/util/hash.ts';
import { loadManifest } from '../src/core/split/manifest.ts';
import { runPersistedEvaluation } from '../src/lib/evaluation.ts';
import { loadPersistedRun } from '../src/lib/supabase-store.ts';

interface Args { seed: number; seedExplicit: boolean; preset: MockPreset; presetExplicit: boolean; dataDir: string | null;
  outputDir: string; manifestLock: string | null; dry: boolean; runId: string | null; live: boolean; mock: boolean }
function parseArgs(argv: string[]): Args {
  const out: Args = { seed: 38, seedExplicit: false, preset: 'unbiased', presetExplicit: false, dataDir: null,
    outputDir: 'results', manifestLock: null, dry: false, runId: null, live: false, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') { out.dry = true; continue; }
    if (flag === '--mock') { out.mock = true; continue; }
    if (flag === '--live') { out.live = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag}: value required`);
    if (flag === '--seed') { out.seed = Number(value); out.seedExplicit = true; if (!Number.isInteger(out.seed)) throw new Error('seed must be an integer'); }
    else if (flag === '--preset') { if (value !== 'unbiased' && value !== 'planted-bias') throw new Error('unknown mock preset'); out.preset = value; out.presetExplicit = true; }
    else if (flag === '--data-dir') out.dataDir = value;
    else if (flag === '--output-dir') out.outputDir = value;
    else if (flag === '--manifest-lock') out.manifestLock = value;
    else if (flag === '--run-id') out.runId = value;
    else throw new Error(`unsupported option ${flag}`);
  }
  if (out.live && out.mock) throw new Error('Choose --mock or --live.');
  if (out.live && !out.runId) throw new Error('--live requires --run-id of an existing console-approved run.');
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'logout') {
    if (argv.length !== 1) throw new Error('Usage: npm run eval -- logout');
    await logoutCli(); console.log('Local CLI session removed.'); return;
  }
  if (argv[0] === 'login') {
    if (argv.length !== 1) throw new Error('Usage: npm run eval -- login');
    await loginCli(createCliSupabase(cliPublicConfig())); console.log('Signed in; local session saved with restricted access.'); return;
  }
  const args = parseArgs(argv);
  if (args.runId) { await persistedMain(args); return; }
  await localMockMain(args);
}

async function persistedMain(args: Args): Promise<void> {
  const publicConfig = cliPublicConfig();
  const client = createCliSupabase(publicConfig);
  await restoreCliSession(client);
  try {
    const run = await loadPersistedRun(client, args.runId!);
    if (run.state === 'draft') throw new Error('Approve this run in the console before using --run-id.');
    if ((args.live && run.mode !== 'live') || (args.mock && run.mode !== 'mock')) throw new Error('Requested mode differs from persisted run.');
    const manifest = run.config.manifest;
    if (args.seedExplicit && args.seed !== manifest.seed) throw new Error('--seed differs from the frozen run.');
    if (args.presetExplicit && args.preset !== run.config.frozen.mock?.preset) throw new Error('--preset differs from the frozen run.');
    // The run's manifest wins. A local lock is checked if present, never frozen/replaced on this path.
    const lock = await readManifestLock(args.manifestLock ?? (args.dataDir ? 'config/manifest.lock.json' : 'fixtures/synthetic/manifest.lock.json'));
    if (lock !== null) {
      const checked = loadManifest(lock, { datasetHash: manifest.datasetHash });
      if (!checked.ok) throw new Error(checked.error);
      if (checked.manifest.salt !== manifest.salt || checked.manifest.manifestHash !== manifest.manifestHash)
        throw new Error('Local manifest lock differs from the authoritative persisted run.');
    }
    const fixture = args.dataDir ? null : generateSynthetic(manifest.seed);
    const files = fixture ? { uData: new TextEncoder().encode(fixture.uData), uItem: fixture.uItem } : await readMovieLensBytes(args.dataDir!);
    const loaded = loadDataset(files);
    if (!loaded.ok) throw new Error(loaded.error);
    if (loaded.report.rejectCount > 0) throw new Error('Refusing rejected input lines.');
    const forcedModes = new Map<string, FormatChaosMode>();
    for (const trap of fixture?.traps ?? []) if (trap.kind === 'format-chaos') for (const a of trap.assignments)
      forcedModes.set(userKeyOf(manifest.salt, a.userId), a.mode);
    const output = await runPersistedEvaluation(client, publicConfig, run, loaded.dataset, { forcedModes, dryRun: args.dry });
    if (args.dry) { console.log(JSON.stringify({ runId: run.id, mode: run.mode, expected: output.expected,
      storedRows: output.rows.length, estimate: output.estimate }, null, 2)); return; }
    if (!output.report) throw new Error('Missing computed report.');
    await mkdir(args.outputDir, { recursive: true });
    await writeFile(path.join(args.outputDir, 'results.md'), resultsMarkdown(output.report), 'utf8');
    const records = [{ type: 'meta', value: output.identity }, ...output.calls.map((value) => ({ type: 'call', value })),
      ...output.rows.map((value) => ({ type: 'result', value }))];
    await writeFile(path.join(args.outputDir, 'results.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'config.json'), `${JSON.stringify({ identity: output.identity,
      config: output.config, devDiffs: run.config.devDiffs }, null, 2)}\n`, 'utf8');
    console.log(`${run.mode === 'mock' ? `${MOCK_STAMP}\n` : ''}${output.rows.length} persisted result rows → ${args.outputDir}/results.md + results.jsonl`);
  } finally { await checkpointCliSession(client); }
}

async function localMockMain(args: Args): Promise<void> {
  const fixture = args.dataDir ? null : generateSynthetic(args.seed);
  const files = fixture ? { uData: new TextEncoder().encode(fixture.uData), uItem: fixture.uItem }
    : await readMovieLensBytes(args.dataDir!);
  const loaded = loadDataset(files);
  if (!loaded.ok) throw new Error(loaded.error);
  const { dataset, report } = loaded;
  if (report.rejectCount > 0) throw new Error(`refusing evaluation with ${report.rejectCount} rejected input lines`);
  const locked = await loadOrFreezeManifest(dataset, report, { seed: args.seed,
    file: args.manifestLock ?? (fixture ? 'fixtures/synthetic/manifest.lock.json' : 'config/manifest.lock.json') });
  if (locked.manifest.seed !== args.seed) throw new Error('seed differs from frozen manifest; use its seed or an explicit separate manifest lock');
  const prepared = prepareEvaluation(dataset, locked.manifest, locked.split);
  const forcedModes = new Map<string, FormatChaosMode>();
  for (const trap of fixture?.traps ?? []) if (trap.kind === 'format-chaos') for (const a of trap.assignments)
    forcedModes.set(userKeyOf(locked.manifest.salt, a.userId), a.mode);
  const provisionalHash = hashCanonical({ params: prepared.params, weights: prepared.tuning.weights.weights,
    datasetHash: dataset.hashes.datasetHash, seed: args.seed, preset: args.preset });
  const probeUserKeys = new Set(sampleProbeUsers(prepared.heldoutContexts.map((c) => c.userKey), args.seed));
  const dryConfig = { runId: 'dry-run', configHash: provisionalHash, datasetHash: dataset.hashes.datasetHash, seed: args.seed };
  if (args.dry) {
    // No adapter/client is constructed or invoked on this path; model-version/primary selection has not yet run.
    const estimate = dryRun({ contexts: prepared.heldoutContexts, probeUserKeys, arms: ['llm-list', 'jev-point'],
      configs: { 'llm-list': { ...dryConfig, promptVersion: 'llm-list.v1' }, 'jev-point': { ...dryConfig, promptVersion: 'jev-point.v1' } },
      pricing: { 'llm-list': { provider: 'mock', model: MOCK_MODEL }, 'jev-point': { provider: 'mock', model: MOCK_MODEL } }, prices: PRICE_TABLE });
    console.log(MOCK_STAMP, '\nDry-run planning only: llm-list.v1 placeholder, no dev model selection or provider calls.\n', JSON.stringify(estimate, null, 2));
    return;
  }
  const params = mockParams(args.preset, args.seed, { forcedModes });
  const devClient = createMockRerankClient({ adapter: createMockProvider(params), ledger: createMemoryLedger(), cache: createMemoryCache() });
  const selection = await selectMockModels(prepared, devClient, { ...dryConfig, runId: 'mock-dev' });
  const config = FrozenConfigSchema.parse({ schemaVersion: 1, seed: args.seed, knnK: prepared.params.k, K: prepared.params.K,
    tunedWeights: prepared.tuning.weights.weights, llmListPromptVersion: selection.llmListPromptVersion, jevPromptVersion: 'jev-point.v1',
    primaryArm: selection.primaryArm, bootstrapResamples: 10000, practicalMarginNdcg: 0.01, probeSampleSeed: args.seed, probeSampleMax: 150,
    models: { 'llm-list': { provider: 'mock', model: MOCK_MODEL }, 'jev-point': { provider: 'mock', model: MOCK_MODEL } },
    mock: { preset: args.preset, seed: args.seed, forcedModesHash: hashCanonical([...forcedModes.entries()].sort()) } });
  const configHash = configHashOf(config);
  const runId = args.runId ?? `mock-${configHash.slice(0, 16)}`;
  const identity = { schemaVersion: 1 as const, runId, mode: 'mock' as const, split: 'heldout' as const,
    datasetHash: dataset.hashes.datasetHash, manifestHash: locked.manifest.manifestHash, configHash, preregHash: null };
  const store = await openJsonlStore(path.join(args.outputDir, 'results.jsonl'), identity);
  const ledger = createMemoryLedger(await store.calls());
  const client = createMockRerankClient({ adapter: createMockProvider(params), ledger, cache: createMemoryCache() });
  const armConfig = { runId, configHash, datasetHash: identity.datasetHash, seed: args.seed };
  const rows = await runEvaluation({ identity, contexts: prepared.heldoutContexts, probeUserKeys, store, ledger,
    evaluate: prepared.evaluateHeldout, arms: [createMostPopArm(prepared.train), createItemKnnArm(), createRandomRerankArm(args.seed),
      createTunedRerankArm(prepared.train, prepared.params.k, config.tunedWeights),
      createLlmListArm(client, { ...armConfig, promptVersion: config.llmListPromptVersion }),
      createJevPointArm(client, { ...armConfig, promptVersion: 'jev-point.v1' })] });
  const computed = buildReport({ rows, calls: await store.calls(), train: prepared.train, mode: 'mock',
    primaryArm: config.primaryArm, seed: args.seed, devDiffs: selection.devDiffs });
  await mkdir(args.outputDir, { recursive: true });
  await writeFile(path.join(args.outputDir, 'results.md'), resultsMarkdown(computed), 'utf8');
  // Reproducible public config contains no manifest salt or source user ids.
  await writeFile(path.join(args.outputDir, 'config.json'), `${JSON.stringify({ identity, config, selection }, null, 2)}\n`, 'utf8');
  console.log(`${MOCK_STAMP}\n${rows.length} result rows → ${args.outputDir}/results.md + results.jsonl`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
