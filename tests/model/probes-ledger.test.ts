import { describe, expect, it, vi } from 'vitest';
import { createLlmListArm } from '../../src/core/arms/llm-list.ts';
import { buildRerankPayload } from '../../src/core/arms/model-arm.ts';
import { dryRun } from '../../src/core/budget/estimate.ts';
import { PRICE_TABLE } from '../../src/core/contracts/prices.ts';
import { createMemoryCache, createMemoryLedger } from '../../src/core/ledger/memory.ts';
import { createMockProvider, createMockRerankClient, mockParams } from '../../src/core/providers/mock.ts';
import { positionBiasIndex } from '../../src/core/probes/position-bias.ts';
import { summarizeRepeat } from '../../src/core/probes/repeat.ts';
import { MODEL_CFG, modelContext } from '../helpers/model.ts';

describe('mock probes, accounting and call-free estimates', () => {
  it('flags planted position bias and does not flag a seeded unbiased control', async () => {
    // what_bug_this_catches: label maps tied to canonical rather than presented order hide planted bias.
    for (const preset of ['unbiased', 'planted-bias'] as const) {
      const ledger = createMemoryLedger();
      const arm = createLlmListArm(createMockRerankClient({ adapter: createMockProvider(mockParams(preset, 38,
        { skill: 0, noise: preset === 'planted-bias' ? 0 : 1, repeatJitter: 0, formatErrorRate: 0 })), ledger, cache: createMemoryCache() }), MODEL_CFG);
      const pairs = [];
      for (let i = 1; i <= 400; i++) {
        const detail = await arm.rankDetailed(modelContext(i), { variant: 'cand_shuffled' });
        pairs.push({ presented: detail.presentedIds, output: detail.result.order });
      }
      const index = positionBiasIndex(pairs, { seed: 38 });
      expect(index.kind).toBe('value');
      if (index.kind === 'value') expect(index.flagged).toBe(preset === 'planted-bias');
    }
  });
  it('records each retry, sums rows, and records cache provenance at zero microdollars', async () => {
    const ledger = createMemoryLedger();
    const adapter = createMockProvider(mockParams('unbiased', 38, { failFirstAttempts: 1, formatErrorRate: 0 }));
    const spy = vi.spyOn(adapter, 'call');
    const client = createMockRerankClient({ adapter, ledger, cache: createMemoryCache() });
    const payload = buildRerankPayload(modelContext(), 'llm-list', 'base', MODEL_CFG);
    const first = await client.rerank(payload);
    expect(first.callIds).toHaveLength(2);
    const cached = await client.rerank(payload);
    expect(cached.cacheHit).toBe(true); expect(spy).toHaveBeenCalledTimes(2);
    expect(ledger.rows().map((r) => r.attemptNo)).toEqual([1, 2, 3]);
    expect(ledger.rows()[2]).toMatchObject({ status: 'cache_hit', costMicro: 0, provenance: { kind: 'cache', sourceCallId: first.callIds[1] } });
    expect(ledger.totals().costMicro).toBe(ledger.rows().reduce((sum, row) => sum + row.costMicro, 0));
    expect(ledger.totals().attempts).toBe(ledger.rows().length);
  });
  it('dry run never invokes an adapter and includes three-attempt worst-case calls', () => {
    const adapter = createMockProvider(mockParams('unbiased', 38));
    const spy = vi.spyOn(adapter, 'call');
    const ctx = modelContext();
    const plan = dryRun({ contexts: [ctx, modelContext(2, 0)], probeUserKeys: new Set([ctx.userKey]), arms: ['llm-list'],
      configs: { 'llm-list': MODEL_CFG }, pricing: { 'llm-list': { provider: 'mock', model: 'mock-1' } }, prices: PRICE_TABLE });
    expect(spy).not.toHaveBeenCalled(); expect(plan.network).toBe('none');
    expect(plan.totals.calls).toBe(6); expect(plan.attemptsWorstCase).toBe(3); expect(plan.totals.worstCaseMicro).toBe(0);
  });
  it('no-candidate users skip all model calls; repeat statistics handle short vectors', async () => {
    const adapter = createMockProvider(mockParams('unbiased', 38)); const spy = vi.spyOn(adapter, 'call');
    const arm = createLlmListArm(createMockRerankClient({ adapter, ledger: createMemoryLedger(), cache: createMemoryCache() }), MODEL_CFG);
    expect((await arm.rank(modelContext(1, 0))).order).toEqual([]); expect(spy).not.toHaveBeenCalled();
    expect(summarizeRepeat([{ base: [1, 2], repeat: [2, 1] }])).toMatchObject({ top1Agreement: 0, meanKendallTau: -1 });
    expect(positionBiasIndex([{ presented: [1], output: [1] }], { seed: 38 }).kind).toBe('unavailable');
  });
});
