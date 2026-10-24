import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { reconstructFrozenEvaluation, createFrozenArms, assertFrozenExpectations } from '../../src/core/report/resume.ts';
import { validatePersistedRun } from '../../src/lib/run-config.ts';
import { persistedFixture } from './fixture.ts';

describe('persisted frozen reconstruction', () => {
  it('reuses selected K, neighbors, weights, prompt, primary, T and salt, with no dev selection', () => {
    // Regression: using prepareEvaluation on resume would re-tune rather than honor these stored selections.
    const { dataset, manifest, frozen, identity, mock, run } = persistedFixture();
    const p = reconstructFrozenEvaluation(dataset, manifest, frozen, 'heldout');
    const arms = createFrozenArms(p, identity, frozen, { 'llm-list': mock, 'jev-point': mock });
    expect(p.train.T).toBe(manifest.T);
    expect(p.contexts.every((ctx) => ctx.kEff <= frozen.K)).toBe(true);
    expect(arms.find((arm) => arm.id === 'llm-list')).toMatchObject({ config: { promptVersion: 'llm-list.v2', seed: manifest.seed } });
    expect(() => assertFrozenExpectations(run.config.expectedResults, run.config.candidateCounts, { identity, contexts: p.contexts,
      arms, probeUserKeys: p.probeUserKeys })).not.toThrow();
    const source = readFileSync(new URL('../../src/core/report/resume.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*(?:tuning|report\/prepare)/);
    expect(run.config.frozen.primaryArm).toBe('jev-point');
  });
  it('rejects dataset, salt/config/prereg tampering and a substituted expected key of equal count', () => {
    const { dataset, run, identity, manifest, frozen, mock } = persistedFixture();
    expect(() => reconstructFrozenEvaluation({ ...dataset, hashes: { ...dataset.hashes, datasetHash: '0'.repeat(64) } },
      manifest, frozen, 'heldout')).toThrow(/dataset/);
    expect(() => validatePersistedRun({ ...run, config: { ...run.config,
      manifest: { ...manifest, salt: '1'.repeat(32) } } })).toThrow(/manifestHash/);
    expect(() => validatePersistedRun({ ...run, config: { ...run.config,
      frozen: { ...frozen, K: 20 } } })).toThrow(/hash/);
    expect(() => validatePersistedRun({ ...run, prereg_hash: 'a'.repeat(64) })).toThrow(/prereg/);
    const p = reconstructFrozenEvaluation(dataset, manifest, frozen, 'heldout');
    const arms = createFrozenArms(p, identity, frozen, { 'llm-list': mock, 'jev-point': mock });
    const changed = run.config.expectedResults.map((key, index) => index === 0 ? { ...key, userKey: 'f'.repeat(16) } : key);
    expect(() => assertFrozenExpectations(changed, run.config.candidateCounts, { identity, contexts: p.contexts, arms, probeUserKeys: p.probeUserKeys })).toThrow(/result keys/);
    const falseZero = run.config.candidateCounts.map((c, index) => index === 0 ? { ...c, kEff: c.kEff === 0 ? 1 : 0 } : c);
    expect(() => assertFrozenExpectations(run.config.expectedResults, falseZero,
      { identity, contexts: p.contexts, arms, probeUserKeys: p.probeUserKeys })).toThrow(/candidate counts/);
    expect(() => validatePersistedRun({ ...run, config: { ...run.config, candidateCounts: [] } })).toThrow();
    expect(() => validatePersistedRun({ ...run, config: { ...run.config,
      candidateCounts: [...run.config.candidateCounts, run.config.candidateCounts[0]] } })).toThrow(/candidate counts/);
  });
  it('constructing the frozen schedule makes no rank calls', () => {
    const { dataset, manifest, frozen, identity, mock } = persistedFixture();
    const rerank = vi.spyOn(mock, 'rerank');
    const p = reconstructFrozenEvaluation(dataset, manifest, frozen, identity.split);
    createFrozenArms(p, identity, frozen, { 'llm-list': mock, 'jev-point': mock });
    expect(rerank).not.toHaveBeenCalled();
  });
});
