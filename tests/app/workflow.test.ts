import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { designIssues } from '../../src/app/workflow.ts';
import type { DryRun } from '../../src/core/budget/estimate.ts';
import type { FrozenConfig } from '../../src/core/prereg/schema.ts';
import { createPublicSupabase, supabase } from '../../src/lib/supabase.ts';

const frozen: FrozenConfig = { schemaVersion: 1, seed: 38, knnK: 20, K: 20,
  tunedWeights: { knn: 1, recency: 0, genre: 0 }, llmListPromptVersion: 'llm-list.v1', jevPromptVersion: 'jev-point.v1',
  primaryArm: 'llm-list', bootstrapResamples: 10000, practicalMarginNdcg: 0.01, probeSampleSeed: 38, probeSampleMax: 150,
  models: { 'llm-list': { provider: 'mock', model: 'mock-1' }, 'jev-point': { provider: 'mock', model: 'mock-1' } },
  mock: { preset: 'unbiased', seed: 38, forcedModesHash: '0'.repeat(64) } };
const estimate = (probeBound: number | null): DryRun => ({ lines: ['llm-list', 'jev-point'].map((arm) => ({
  arm: arm as 'llm-list' | 'jev-point', variant: arm === 'llm-list' ? 'masked' : 'q_shuffle',
  provider: 'mock', model: 'mock-1', calls: 1, displayInputTokens: 1, displayOutputTokens: 1,
  displayMicro: 1, worstCaseMicro: probeBound, maxInputTokens: 1, maxOutputTokens: 1, unavailable: null })),
  byArm: { 'llm-list': { calls: 1, displayMicro: 1, worstCaseMicro: probeBound }, 'jev-point': { calls: 1, displayMicro: 1, worstCaseMicro: probeBound } },
  totals: { calls: 2, displayMicro: 2, worstCaseMicro: probeBound === null ? null : probeBound * 2 },
  attemptsWorstCase: 3, displayLabel: 'display', boundLabel: 'bound', network: 'none' });
const caps = { total: 100, 'llm-list': 100, 'jev-point': 100, probe: 15 };

describe('console admission and local branch boundaries', () => {
  it('refuses overlapping probes even when the total and each arm fit', () => {
    // what_bug_this_catches: checking only total/arm caps admitted a combined probe liability above its overlapping cap.
    expect(designIssues(estimate(10), frozen, 'mock', caps)).toEqual([expect.stringMatching(/Overlapping probe/)]);
    expect(designIssues(estimate(5), frozen, 'mock', caps)).toEqual([]);
  });
  it('fails closed on unknown bounds and unsafe cap integers', () => {
    // what_bug_this_catches: null coerced to zero or NaN caps bypassed live-start comparison guards.
    expect(designIssues(estimate(null), frozen, 'mock', caps).join(' ')).toMatch(/unavailable/);
    expect(designIssues(estimate(1), frozen, 'mock', { ...caps, total: NaN }).join(' ')).toMatch(/integer microdollars/);
  });
  it('refuses current unverified live pins even with large caps', () => {
    // what_bug_this_catches: displaying prices was mistaken for verification and permitted live approval.
    const live = { ...frozen, mock: null, models: { 'llm-list': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'jev-point': { provider: 'typesafe', model: 'jev-1.13.0' } } };
    expect(designIssues(estimate(1), live, 'live', { ...caps, probe: 100 }).length).toBeGreaterThan(0);
  });
  it('does not construct the browser auth singleton merely by importing its module', () => {
    // what_bug_this_catches: configured local mock auto-refreshed an expired auth session on startup.
    expect(supabase).toBeNull(); expect(createPublicSupabase(null)).toBeNull();
    const state = readFileSync(new URL('../../src/app/state.ts', import.meta.url), 'utf8');
    expect(state).toContain("if (branch !== 'persisted') return;");
    expect(state).toContain("if (next === 'persisted')");
    expect(state).toContain('activateBrowserSupabase()');
    expect(state).not.toContain('SERVICE_ROLE');
    expect(state).not.toContain('ANTHROPIC_API_KEY');
  });
});
