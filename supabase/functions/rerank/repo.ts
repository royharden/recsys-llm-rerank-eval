// Durable boundary. The user client proves ownership through RLS; only the service client mutates paid attempts.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import type { RerankPayload } from './_vendor/src/core/contracts/rerank-payload.ts';
import type { RerankResponse, Usage } from './_vendor/src/core/contracts/rerank-response.ts';

export interface RunRecord {
  id: string; owner_id: string; mode: 'live' | 'mock'; split: 'dev' | 'heldout'; state: string;
  config_hash: string; dataset_hash: string; manifest_hash: string; prereg_hash: string | null;
  prereg_dated_at: string | null; started_at: string | null; cap_micro: number; arm_caps: Record<string, number>;
  config: { schemaVersion: number; manifest: Record<string, unknown>; frozen: Record<string, unknown>;
    expectedResults: { runId: string; arm: string; variant: string; repeatIndex: number; userKey: string }[];
    candidateCounts: { userKey: string; kEff: number }[];
    probeUserKeys: string[]; prereg: Record<string, unknown> | null };
  approval: { config_hash: string; cap_micro: number; arm_caps: Record<string, number> } | null;
}
export interface CallRow {
  id: string; requestKey: string; runId: string; attemptNo: number; arm: RerankPayload['arm']; variant: RerankPayload['variant'];
  repeatIndex: number; userKey: string; provider: string; model: string; promptVersion: RerankPayload['promptVersion'];
  promptHash: string; cacheKey: string; mappingHash: string; inputTokens: number | null; outputTokens: number | null;
  cachedTokens: number | null; reportedUsage: Usage | null; priceTableDate: string | null; boundMicro: number;
  costMicro: number; latencyMs: number;
  status: 'ok' | 'format_failure' | 'provider_error' | 'timeout_uncertain' | 'stale_uncertain' | 'bound_violation' | 'cache_hit' | 'budget_refused';
  provenance: { kind: 'provider' } | { kind: 'cache'; sourceCallId: string }; createdAt: string;
}
export interface CachedOutcome {
  cacheKey: string; mappingHash: string; provider: string; model: string; promptHash: string;
  finalOrder: number[]; rawLabelOrder: string[] | null; probabilities: Record<string, number> | null;
  repairs: RerankResponse['repairs']; formatFailure: boolean; failureReason: RerankResponse['failureReason'];
  usage: Usage | null; sourceCallId: string;
}
export type Claim = { kind: 'claimed'; leaseToken: string; nextAttemptNo: number } | { kind: 'done'; response: RerankResponse }
  | { kind: 'in_flight' | 'uncertain' | 'stale_uncertain' | 'exhausted' };
export interface Repo {
  getRun(runId: string): Promise<RunRecord | null>;
  claim(payload: RerankPayload): Promise<Claim>;
  cache(cacheKey: string): Promise<CachedOutcome | null>;
  callIds(requestKey: string): Promise<string[]>;
  reserve(requestKey: string, lease: string, attemptNo: number, boundMicro: number, context: CallRow): Promise<boolean>;
  complete(requestKey: string, lease: string, call: CallRow, response: RerankResponse, cache: CachedOutcome | null): Promise<RerankResponse>;
  release(requestKey: string, lease: string, call: CallRow, retry: boolean): Promise<void>;
  uncertain(requestKey: string, lease: string, call: CallRow): Promise<void>;
  failure(requestKey: string, lease: string, call: CallRow): Promise<void>;
}
export function createRepo(user: SupabaseClient, service: SupabaseClient, ownerId: string): Repo {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await service.rpc(name, { p_owner_id: ownerId, ...args });
    if (error) throw new Error(`repository:${name}`); // Never echo raw SQL/provider text to a client or log.
    return data as T;
  }
  return {
    async getRun(runId) {
      const { data, error } = await user.from('eval_runs').select('*').eq('id', runId).eq('owner_id', ownerId).maybeSingle();
      if (error) throw new Error('repository:run');
      if (!data) return null;
      const approval = await user.from('run_approvals').select('config_hash,cap_micro,arm_caps').eq('run_id', runId).eq('owner_id',ownerId).maybeSingle();
      if (approval.error) throw new Error('repository:approval');
      return { ...data, approval: approval.data } as RunRecord;
    },
    claim: (payload) => rpc<Claim>('claim_request', { p_payload: payload }),
    async cache(key) {
      const { data,error } = await service.from('response_cache').select('entry').eq('owner_id',ownerId).eq('cache_key',key).maybeSingle();
      if (error) throw new Error('repository:cache');
      return (data?.entry ?? null) as CachedOutcome | null;
    },
    async callIds(key) {
      const { data,error } = await service.from('llm_calls').select('id').eq('owner_id',ownerId).eq('request_key',key).order('attempt_no');
      if (error) throw new Error('repository:calls');
      return (data ?? []).map((r: { id: string }) => r.id);
    },
    reserve: (key,lease,n,bound,context) => rpc<boolean>('reserve_and_mark_sent', { p_request_key:key,p_lease_token:lease,p_attempt_no:n,p_bound_micro:bound,p_context:context }),
    complete: (key,lease,call,response,cache) => rpc<RerankResponse>('complete_attempt', { p_request_key:key,p_lease_token:lease,p_call:call,p_response:response,p_cache:cache }),
    release: (key,lease,call,retry) => rpc<void>('release_attempt', { p_request_key:key,p_lease_token:lease,p_call:call,p_retry:retry }),
    uncertain: (key,lease,call) => rpc<void>('hold_uncertain', { p_request_key:key,p_lease_token:lease,p_call:call }),
    failure: (key,lease,call) => rpc<void>('record_failure', { p_request_key:key,p_lease_token:lease,p_call:call }),
  };
}
