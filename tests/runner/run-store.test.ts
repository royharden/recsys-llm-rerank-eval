import { describe, expect, it, vi } from 'vitest';
import { createMemoryResultStore, type RunIdentity } from '../../src/core/runner/store.ts';
import { expectedResults, runEvaluation } from '../../src/core/runner/run.ts';
import { createMemoryCache, createMemoryLedger } from '../../src/core/ledger/memory.ts';
import { createMockProvider, createMockRerankClient, mockParams } from '../../src/core/providers/mock.ts';
import { createLlmListArm } from '../../src/core/arms/llm-list.ts';
import { createJevPointArm } from '../../src/core/arms/jev-point.ts';
import { createItemKnnArm } from '../../src/core/arms/itemknn.ts';
import { createMostPopArm } from '../../src/core/arms/mostpop.ts';
import { createRandomRerankArm } from '../../src/core/arms/random-rerank.ts';
import { createTunedRerankArm } from '../../src/core/arms/tuned-rerank.ts';
import { buildUserContext } from '../../src/core/arms/candidates.ts';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import { evaluateUser } from '../../src/core/metrics/ranking.ts';
import type { UserRanking } from '../../src/core/metrics/ranking.ts';
import { MODEL_CFG } from '../helpers/model.ts';
import { toyRows, toyItems, toyItemById, T } from '../helpers/toy.ts';

const identity: RunIdentity = { schemaVersion: 1, runId: MODEL_CFG.runId, mode: 'mock', split: 'heldout',
  datasetHash: MODEL_CFG.datasetHash, manifestHash: 'c'.repeat(64), configHash: MODEL_CFG.configHash, preregHash: null };
function setup() {
  const train = buildTrainingData(toyRows(), T, toyItems());
  const contexts = [buildUserContext(train, toyItemById(), { userKey: '0'.repeat(15) + '1', history: [1, 2] }, { k: 20, K: 20 }),
    buildUserContext(train, toyItemById(), { userKey: '0'.repeat(15) + '2', history: train.catalogue }, { k: 20, K: 20 })];
  const ledger = createMemoryLedger();
  const adapter = createMockProvider(mockParams('unbiased', 38, { formatErrorRate: 0 }));
  const spy = vi.spyOn(adapter, 'call');
  const client = createMockRerankClient({ adapter, ledger, cache: createMemoryCache() });
  const arms = [createMostPopArm(train), createItemKnnArm(), createRandomRerankArm(38),
    createTunedRerankArm(train, 20, { knn: 1, recency: 0, genre: 0 }), createLlmListArm(client, MODEL_CFG),
    createJevPointArm(client, { ...MODEL_CFG, promptVersion: 'jev-point.v1' })];
  const scorer = { targets: new Map(contexts.map((c): [string, number] => [c.userKey, 4])) };
  return { identity, contexts, arms, store: createMemoryResultStore(), ledger, spy,
    probeUserKeys: new Set(contexts.map((c) => c.userKey)), evaluate: (r: UserRanking) => evaluateUser(scorer, train, r, 20) };
}

describe('bounded scheduler and immutable resume', () => {
  it('runs six arms plus every probe, retaining zero-candidate denominators, then resumes without calls', async () => {
    const input = setup(); const expected = expectedResults(input);
    expect(expected).toHaveLength(24);
    const rows = await runEvaluation(input);
    expect(rows).toHaveLength(expected.length);
    expect(rows.filter((r) => r.kEff === 0)).toHaveLength(12);
    expect(rows.filter((r) => r.kEff === 0).every((r) => r.targetRank === null && r.callIds.length === 0)).toBe(true);
    const calls = input.spy.mock.calls.length;
    expect(await runEvaluation(input)).toEqual(rows);
    expect(input.spy).toHaveBeenCalledTimes(calls);
    expect((await input.store.calls()).length).toBe(input.ledger.rows().length);
    await expect(runEvaluation({ ...input, identity: { ...identity, configHash: 'f'.repeat(64) } })).rejects.toThrow('identity mismatch');
  });
  it('emits incomplete lifecycle on cancellation and cannot rewrite a completed result', async () => {
    const input = setup();
    const rows = await runEvaluation(input);
    await expect(input.store.put({ ...rows[0], targetRank: rows[0].targetRank === null ? 1 : null })).rejects.toThrow('immutable');
    const controller = new AbortController(); controller.abort();
    const lifecycle = { start: vi.fn(async () => {}), incomplete: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
    await expect(runEvaluation({ ...setup(), signal: controller.signal, lifecycle })).rejects.toThrow('cancelled');
    expect(lifecycle.incomplete).toHaveBeenCalledWith('cancelled'); expect(lifecycle.complete).not.toHaveBeenCalled();
  });
});
