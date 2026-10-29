import { describe, expect, it } from 'vitest';
import { assertPreregistered, configHashOf, preregHashOf, type FrozenConfig } from '../../src/core/prereg/schema.ts';
const config: FrozenConfig = { schemaVersion: 1, seed: 38, knnK: 20, K: 20, tunedWeights: { knn: 1, recency: 0, genre: 0 },
  llmListPromptVersion: 'llm-list.v1', jevPromptVersion: 'jev-point.v1', primaryArm: 'llm-list', bootstrapResamples: 10000,
  practicalMarginNdcg: 0.01, probeSampleSeed: 38, probeSampleMax: 150,
  models: { 'llm-list': { provider: 'anthropic', model: 'unverified-pin' }, 'jev-point': { provider: 'typesafe', model: 'jev-1.13.0' } }, mock: null };
const expected = { datasetHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), configHash: configHashOf(config), startedAt: '2026-10-24T13:00:00.000Z' };
const prereg = { schemaVersion: 1 as const, datedAt: '2026-10-24T12:00:00.000Z', datasetHash: expected.datasetHash,
  manifestHash: expected.manifestHash, configHash: expected.configHash, config,
  probes: { 'llm-list': ['hist_shuffle', 'cand_reversed', 'cand_shuffled', 'masked', 'repeat'] as const, 'jev-point': ['q_shuffle'] as const } };
describe('frozen preregistration', () => {
  it('rejects undated/late, wrong dataset/config and post-freeze choices', () => {
    expect(() => assertPreregistered({ ...prereg, datedAt: null }, expected)).toThrow();
    expect(() => assertPreregistered({ ...prereg, datedAt: expected.startedAt }, expected)).toThrow('before');
    expect(() => assertPreregistered(prereg, { ...expected, datasetHash: 'c'.repeat(64) })).toThrow('datasetHash');
    expect(() => assertPreregistered({ ...prereg, config: { ...config, K: 30 } }, expected)).toThrow('configHash');
    const parsed = assertPreregistered(prereg, expected);
    expect(preregHashOf(parsed)).toHaveLength(64);
    expect(configHashOf({ ...config, primaryArm: 'jev-point' })).not.toBe(expected.configHash);
  });
});
