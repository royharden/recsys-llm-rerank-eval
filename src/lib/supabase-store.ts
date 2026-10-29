import type { SupabaseClient } from '@supabase/supabase-js';
import { requestKey } from '../core/contracts/keys.ts';
import { CallRowSchema } from '../core/ledger/schema.ts';
import type { CallRow } from '../core/ledger/types.ts';
import { ResultRowSchema, resultKey, type ResultRow, type ResultStore, type RunIdentity } from '../core/runner/store.ts';
import { hashCanonical } from '../core/util/hash.ts';
import { identityOfRun, validatePersistedRun, type PersistedConfig, type PersistedRun } from './run-config.ts';
import { requireUser } from './session.ts';
import { configHashOf, preregHashOf } from '../core/prereg/schema.ts';

export async function loadPersistedRun(client: SupabaseClient, runId: string): Promise<PersistedRun> {
  const owner = await requireUser(client);
  const { data, error } = await client.from('eval_runs').select('*').eq('id', runId).eq('owner_id', owner).single();
  if (error) throw error;
  return validatePersistedRun(data);
}
export async function createDraftRun(client: SupabaseClient, input: {
  id: string; mode: 'mock' | 'live'; split: 'dev' | 'heldout'; config: PersistedConfig;
  capMicro: number; armCaps: PersistedRun['arm_caps'];
}): Promise<PersistedRun> {
  const owner = await requireUser(client);
  const c = input.config;
  const row = { id: input.id, owner_id: owner, mode: input.mode, split: input.split,
    dataset_hash: c.manifest.datasetHash, manifest_hash: c.manifest.manifestHash, config_hash: configHashOf(c.frozen),
    prereg_hash: c.prereg ? preregHashOf(c.prereg) : null, prereg_dated_at: c.prereg?.datedAt ?? null,
    config: c, cap_micro: input.capMicro, arm_caps: input.armCaps, state: 'draft', started_at: null };
  validatePersistedRun(row);
  // The database owns transitions and timestamps; draft creation never approves a run.
  const { error } = await client.from('eval_runs').insert({ id: row.id, owner_id: owner, mode: row.mode, split: row.split,
    dataset_hash: row.dataset_hash, manifest_hash: row.manifest_hash, config_hash: row.config_hash,
    prereg_hash: row.prereg_hash, prereg_dated_at: row.prereg_dated_at, config: c,
    cap_micro: row.cap_micro, arm_caps: row.arm_caps });
  if (error) throw error;
  return loadPersistedRun(client, input.id);
}

/** Console-only explicit approval action. CLI never imports or invokes this function. */
export async function approveRun(client: SupabaseClient, input: PersistedRun,
  estimate: { hash: string; micro: number }): Promise<PersistedRun> {
  const run = validatePersistedRun(input);
  if (run.state !== 'draft') throw new Error('Only a draft can be approved.');
  if (!/^[0-9a-f]{64}$/.test(estimate.hash) || !Number.isSafeInteger(estimate.micro) || estimate.micro < 0)
    throw new Error('Invalid frozen estimate.');
  if (run.mode === 'mock' && estimate.micro !== 0) throw new Error('Mock approval estimate must be zero.');
  const owner = await requireUser(client);
  if (owner !== run.owner_id) throw new Error('Run belongs to another owner.');
  const { error } = await client.from('run_approvals').insert({ run_id: run.id, owner_id: owner,
    config_hash: run.config_hash, estimate_hash: estimate.hash, estimate_micro: estimate.micro,
    cap_micro: run.cap_micro, arm_caps: run.arm_caps });
  if (error) throw error;
  return loadPersistedRun(client, run.id);
}
export async function listPersistedRuns(client: SupabaseClient): Promise<PersistedRun[]> {
  const owner = await requireUser(client);
  const runs: PersistedRun[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('eval_runs').select('*').eq('owner_id', owner)
      .order('created_at', { ascending: false }).order('id').range(offset, offset + 999);
    if (error) throw error;
    runs.push(...(data ?? []).map(validatePersistedRun));
    if (!data || data.length < 1000) return runs;
  }
}
export async function listUncertainRequests(client: SupabaseClient, runId: string): Promise<{
  requestKey: string; reason: 'uncertain' | 'stale_uncertain';
}[]> {
  const run = await loadPersistedRun(client, runId);
  const requests: { requestKey: string; reason: 'uncertain' | 'stale_uncertain' }[] = [];
  const cutoff = new Date().toISOString();
  for (let offset = 0; ; offset += 1000) {
    // A worker may die after sent_at without changing claimed -> uncertain. Surface that liability for explicit review.
    // The RPC independently checks the server clock/lease and rejects acknowledgment of an active lease.
    const { data, error } = await client.from('llm_requests').select('request_key,state').eq('run_id', run.id)
      .eq('owner_id', run.owner_id).or(`state.eq.uncertain,and(state.eq.claimed,sent_at.not.is.null,lease_until.lt.${cutoff})`)
      .order('request_key').range(offset, offset + 999);
    if (error) throw error;
    for (const row of data ?? []) requests.push({ requestKey: row.request_key,
      reason: row.state === 'claimed' ? 'stale_uncertain' : 'uncertain' });
    if (!data || data.length < 1000) return requests;
  }
}
/** Explicit owner review consumes the full uncertain bound. It never releases spend or automatically retries. */
export async function acknowledgeUncertain(client: SupabaseClient, runId: string, key: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid request key.');
  await loadPersistedRun(client, runId);
  const { error } = await client.rpc('acknowledge_uncertain', { p_run_id: runId, p_request_key: key });
  if (error) throw error;
}

function resultFromDb(value: Record<string, unknown>): ResultRow {
  return ResultRowSchema.parse({ runId: value.run_id, arm: value.arm, variant: value.variant, repeatIndex: value.repeat_index,
    userKey: value.user_key, candidateIds: value.candidate_ids, rankedIds: value.ranked_ids, presentedIds: value.presented_ids,
    kEff: value.k_eff, flags: value.flags, targetRank: value.target_rank, inCandidates: value.in_candidates,
    targetPopularity: value.target_popularity, coldTarget: value.cold_target, repairs: value.repairs,
    formatFailure: value.format_failure, callIds: value.call_ids });
}
function resultToDb(row: ResultRow, run: PersistedRun): Record<string, unknown> {
  const model = row.arm === 'llm-list' || row.arm === 'jev-point';
  return { run_id: row.runId, owner_id: run.owner_id, arm: row.arm, variant: row.variant, repeat_index: row.repeatIndex,
    user_key: row.userKey, candidate_ids: row.candidateIds, ranked_ids: row.rankedIds, presented_ids: row.presentedIds,
    k_eff: row.kEff, flags: row.flags, target_rank: row.targetRank, in_candidates: row.inCandidates,
    target_popularity: row.targetPopularity, cold_target: row.coldTarget, repairs: row.repairs,
    format_failure: row.formatFailure, call_ids: row.callIds,
    request_key: run.mode === 'live' && model && row.kEff > 0 ? requestKey({ ...row, configHash: run.config_hash }) : null };
}
/** Queries page explicitly: PostgREST's default 1000-row limit must never truncate a resumed report. */
async function paged(client: SupabaseClient, table: 'run_user_results' | 'llm_calls', run: PersistedRun): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = client.from(table).select('*').eq('run_id', run.id).eq('owner_id', run.owner_id);
    query = table === 'llm_calls' ? query.order('created_at').order('id') :
      query.order('arm').order('variant').order('repeat_index').order('user_key');
    const { data, error } = await query.range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}
export function createSupabaseStore(client: SupabaseClient, input: PersistedRun): ResultStore {
  const run = validatePersistedRun(input);
  const identity = identityOfRun(run);
  const allowed = new Set(run.config.expectedResults.map(resultKey));
  let bound = false;
  const assertBound = (): void => { if (!bound) throw new Error('bind the persisted store before use'); };
  const store: ResultStore = {
    async bind(other: RunIdentity) {
      if (hashCanonical(identity) !== hashCanonical(other)) throw new Error('resume identity mismatch');
      bound = true;
    },
    async get(key) {
      assertBound();
      if (!allowed.has(resultKey(key))) throw new Error('result key is outside the frozen expected set');
      const { data, error } = await client.from('run_user_results').select('*').eq('run_id', run.id).eq('owner_id', run.owner_id)
        .eq('arm', key.arm).eq('variant', key.variant).eq('repeat_index', key.repeatIndex).eq('user_key', key.userKey).maybeSingle();
      if (error) throw error;
      return data ? resultFromDb(data) : null;
    },
    async put(value) {
      assertBound();
      const row = ResultRowSchema.parse(value);
      const old = await store.get(row);
      if (old) {
        if (hashCanonical(old) !== hashCanonical(row)) throw new Error(`immutable result conflict: ${resultKey(row)}`);
        return;
      }
      const { error } = await client.from('run_user_results').insert(resultToDb(row, run));
      if (error) {
        if (error.code !== '23505') throw error;
        const concurrent = await store.get(row);
        if (!concurrent || hashCanonical(concurrent) !== hashCanonical(row)) throw new Error('immutable concurrent result conflict');
      }
    },
    async rows() {
      assertBound();
      const rows = (await paged(client, 'run_user_results', run)).map(resultFromDb);
      if (rows.some((row) => !allowed.has(resultKey(row)))) throw new Error('stored result outside frozen expected set');
      return rows;
    },
    async appendCall(value) {
      assertBound();
      const row = CallRowSchema.parse(value);
      if (row.runId !== run.id) throw new Error('call belongs to a different run');
      if (run.mode === 'mock') {
        if (row.provider !== 'mock' || row.costMicro !== 0) throw new Error('persisted mock ledger must be mock and free');
        const { error } = await client.rpc('append_mock_call', { p_run_id: run.id, p_call: row });
        if (error) throw error;
      } else {
        // Paid ledger rows can ONLY be inserted by the function. Reconcile a caller's row against the server copy.
        const { data, error } = await client.from('llm_calls').select('call_row').eq('run_id', run.id)
          .eq('owner_id', run.owner_id).eq('id', row.id).single();
        if (error) throw error;
        if (hashCanonical(CallRowSchema.parse(data.call_row)) !== hashCanonical(row)) throw new Error('live ledger differs from server');
      }
    },
    async calls(): Promise<CallRow[]> {
      assertBound();
      return (await paged(client, 'llm_calls', run)).map((row) => {
        const call = CallRowSchema.parse(row.call_row);
        if (call.runId !== run.id || call.id !== row.id) throw new Error('persisted ledger identity mismatch');
        return call;
      });
    },
  };
  return store;
}

export function createRunLifecycle(client: SupabaseClient, initial: PersistedRun) {
  let run = validatePersistedRun(initial);
  const rpc = async (name: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const { error } = await client.rpc(name, { p_run_id: run.id, ...extra });
    if (error) throw error;
    const next = await loadPersistedRun(client, run.id);
    if (hashCanonical(identityOfRun(next)) !== hashCanonical(identityOfRun(run)) ||
      hashCanonical(next.config) !== hashCanonical(run.config)) throw new Error('run changed during lifecycle transition');
    run = next;
  };
  return {
    async start() {
      // Fresh reads permit a resumed CLI/tab; complete runs remain readable without a backward transition.
      const fresh = await loadPersistedRun(client, run.id);
      if (hashCanonical(fresh.config) !== hashCanonical(run.config) ||
        hashCanonical(identityOfRun(fresh)) !== hashCanonical(identityOfRun(run))) throw new Error('frozen run config changed');
      run = fresh;
      if (run.state === 'complete' || run.state === 'running') return;
      if (run.state === 'approved') await rpc('start_run', { p_config_hash: run.config_hash });
      else if (run.state === 'incomplete') await rpc('resume_run', { p_config_hash: run.config_hash });
      else throw new Error('Console approval is required before starting this run.');
    },
    async incomplete(_reason: string) {
      if (run.state === 'complete') return;
      // Persist a bounded code, never arbitrary errors that could contain local data or a server response.
      await rpc('mark_incomplete', { p_reason: 'client_interrupted' });
    },
    async complete() { if (run.state !== 'complete') await rpc('complete_run'); },
  };
}
