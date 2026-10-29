import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createRunLifecycle, createSupabaseStore, listUncertainRequests } from '../../src/lib/supabase-store.ts';
import { identityOfRun, type PersistedRun } from '../../src/lib/run-config.ts';
import { requestKey } from '../../src/core/contracts/keys.ts';
import type { CallRow } from '../../src/core/ledger/types.ts';
import type { ResultRow } from '../../src/core/runner/store.ts';
import { persistedFixture } from './fixture.ts';
import { runPersistedEvaluation } from '../../src/lib/evaluation.ts';
import { configHashOf } from '../../src/core/prereg/schema.ts';

function fakeDatabase(initial: PersistedRun, calls: CallRow[] = [], requests: Record<string, unknown>[] = []) {
  let run = initial;
  const results: Record<string, unknown>[] = [];
  const writes: { table: string; row: Record<string, unknown> }[] = [];
  const ranges: number[] = [];
  const expressions: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'append_mock_call') calls.push(args.p_call as CallRow);
    if (name === 'start_run' || name === 'resume_run') run = { ...run, state: 'running', started_at: run.started_at ?? '2026-10-25T00:00:00.000Z' };
    if (name === 'mark_incomplete') run = { ...run, state: 'incomplete' };
    if (name === 'complete_run') run = { ...run, state: 'complete' };
    return { data: null, error: null };
  });
  function from(table: string) {
    const filters = new Map<string, unknown>();
    let start = 0; let end = Number.MAX_SAFE_INTEGER;
    const rows = (): Record<string, unknown>[] => {
      const source: Record<string, unknown>[] = table === 'eval_runs' ? [run] : table === 'run_user_results' ? results :
        table === 'llm_requests' ? requests : calls.map((call) =>
        ({ id: call.id, run_id: call.runId, owner_id: run.owner_id, call_row: call, created_at: call.createdAt }));
      return source.filter((row) => [...filters].every(([key, value]) => row[key] === value));
    };
    const query = {
      select() { return query; }, eq(key: string, value: unknown) { filters.set(key, value); return query; },
      or(expression: string) { expressions.push(expression); return query; },
      order() { return query; }, range(a: number, b: number) { start = a; end = b; ranges.push(a); return query; },
      async single() { return { data: rows()[0] ?? null, error: null }; },
      async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
      async insert(row: Record<string, unknown>) { writes.push({ table, row }); if (table === 'run_user_results') results.push(row); return { data: null, error: null }; },
      then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
        return Promise.resolve(resolve({ data: rows().slice(start, end + 1), error: null }));
      },
    };
    return query;
  }
  const client = { from, rpc, auth: { getUser: async () => ({ data: { user: { id: run.owner_id } }, error: null }) } } as unknown as SupabaseClient;
  return { client, writes, ranges, expressions, rpc, results, run: () => run };
}
function callFor(run: PersistedRun, index: number): CallRow {
  const key = run.config.expectedResults.find((key) => key.arm === 'llm-list')!;
  return { id: `call-${index}`, runId: run.id, requestKey: requestKey({ ...key, configHash: run.config_hash }), attemptNo: index + 1,
    arm: 'llm-list', variant: 'base', repeatIndex: 0, userKey: key.userKey, provider: run.mode === 'mock' ? 'mock' : 'anthropic',
    model: run.config.frozen.models['llm-list'].model, promptVersion: 'llm-list.v2', promptHash: '1'.repeat(64),
    cacheKey: '2'.repeat(64), mappingHash: '3'.repeat(64), inputTokens: 1, outputTokens: 1, cachedTokens: 0,
    reportedUsage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, priceTableDate: '2026-10-24', boundMicro: 0,
    costMicro: 0, latencyMs: 1, status: 'ok', provenance: { kind: 'provider' }, createdAt: '2026-10-25T00:00:00.000Z' };
}
describe('persisted store and lifecycle contract', () => {
  it('maps every reporting field and rejects identity/immutable result rewrites', async () => {
    const { run, identity } = persistedFixture(); const db = fakeDatabase(run);
    const store = createSupabaseStore(db.client, run);
    await expect(store.bind({ ...identity, configHash: 'f'.repeat(64) })).rejects.toThrow(/identity/);
    await store.bind(identity);
    const row: ResultRow = { ...run.config.expectedResults[0], candidateIds: [1], rankedIds: [1], presentedIds: [], kEff: 1,
      flags: ['short_list'], targetRank: 1, inCandidates: true, targetPopularity: 7, coldTarget: false,
      repairs: { unknown: 0, repeat: 0, missing: 0, emptyRanking: 0 }, formatFailure: false, callIds: [] };
    await store.put(row);
    expect(await store.get(row)).toEqual(row);
    expect(await store.rows()).toEqual([row]);
    expect(db.writes[0].row).toMatchObject({ owner_id: run.owner_id, target_popularity: 7, cold_target: false, call_ids: [], request_key: null });
    await expect(store.put({ ...row, targetRank: null })).rejects.toThrow(/immutable/);
  });
  it('reads all ledger pages beyond 1000 rows and never inserts a browser live call', async () => {
    const { run: mock } = persistedFixture();
    // A live dev run needs no prereg; model pins and configHash change together.
    const frozen = { ...mock.config.frozen, mock: null, models: {
      'llm-list': { provider: 'anthropic', model: 'claude-haiku-5-5' }, 'jev-point': { provider: 'typesafe', model: 'jev-1.13.0' } } };
    const run: PersistedRun = { ...mock, mode: 'live', split: 'dev', config_hash: configHashOf(frozen), config: { ...mock.config, frozen } };
    const calls = Array.from({ length: 1001 }, (_, index) => callFor(run, index));
    const db = fakeDatabase(run, calls); const store = createSupabaseStore(db.client, run);
    await store.bind(identityOfRun(run));
    expect(await store.calls()).toHaveLength(1001);
    expect(db.ranges).toEqual([0, 1000]);
    await store.appendCall(calls[0]);
    expect(db.writes).toHaveLength(0); expect(db.rpc).not.toHaveBeenCalled();
    await expect(store.appendCall({ ...calls[0], latencyMs: 50 })).rejects.toThrow(/differs from server/);
  });
  it('uses approved start vs incomplete resume and leaves complete readable with no transition', async () => {
    const { run } = persistedFixture();
    for (const [state, wanted] of [['approved', 'start_run'], ['incomplete', 'resume_run']] as const) {
      const db = fakeDatabase({ ...run, state }); const lifecycle = createRunLifecycle(db.client, { ...run, state });
      await lifecycle.start();
      expect(db.rpc).toHaveBeenCalledWith(wanted, { p_run_id: run.id, p_config_hash: run.config_hash });
      await lifecycle.incomplete('secret prompt must never be persisted');
      expect(db.rpc).toHaveBeenCalledWith('mark_incomplete', { p_run_id: run.id, p_reason: 'client_interrupted' });
    }
    const complete = { ...run, state: 'complete' as const };
    const db = fakeDatabase(complete); const lifecycle = createRunLifecycle(db.client, complete);
    await lifecycle.start(); await lifecycle.complete(); await lifecycle.incomplete('ignored');
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('surfaces sent claimed leases that expired alongside explicitly uncertain requests', async () => {
    // Regression: a crashed worker cannot change its state, and incomplete resume cannot claim it for the owner.
    const { run } = persistedFixture();
    const requests = ['uncertain', 'claimed'].map((state, index) => ({ run_id: run.id, owner_id: run.owner_id,
      request_key: String(index + 1).repeat(64), state }));
    const db = fakeDatabase(run, [], requests);
    expect(await listUncertainRequests(db.client, run.id)).toEqual([
      { requestKey: '1'.repeat(64), reason: 'uncertain' }, { requestKey: '2'.repeat(64), reason: 'stale_uncertain' }]);
    expect(db.expressions[0]).toMatch(/^state.eq.uncertain,and\(state.eq.claimed,sent_at.not.is.null,lease_until.lt./);
  });
  it('resumes persisted mock after cancellation and exports complete computed rows without restarting', async () => {
    // Regression: result and call checkpoints share the actual runner; held-out resume cannot reselect models.
    const { run, dataset } = persistedFixture(); const db = fakeDatabase(run);
    const controller = new AbortController();
    await expect(runPersistedEvaluation(db.client, { url: 'https://unused.example', anonKey: 'public' }, run, dataset,
      { signal: controller.signal, onProgress: ({ completed }) => { if (completed === 3) controller.abort(); } })).rejects.toThrow('cancelled');
    expect(db.run().state).toBe('incomplete');
    expect(db.results).toHaveLength(3);
    const complete = await runPersistedEvaluation(db.client, { url: 'https://unused.example', anonKey: 'public' }, db.run(), dataset);
    expect(complete.rows).toHaveLength(run.config.expectedResults.length);
    expect(complete.report?.mode).toBe('mock');
    expect(complete.report?.ledger.attempts).toBe(complete.calls.length);
    expect(db.run().state).toBe('complete');
    const writes = db.writes.length; const transitions = db.rpc.mock.calls.length;
    const exported = await runPersistedEvaluation(db.client, { url: 'https://unused.example', anonKey: 'public' }, db.run(), dataset);
    expect(exported.rows).toEqual(complete.rows);
    expect(exported.report).toEqual(complete.report);
    expect(db.writes).toHaveLength(writes); expect(db.rpc).toHaveBeenCalledTimes(transitions);
  });
});
