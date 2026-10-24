// Call ledger (PLAN §6 llm_calls): one row per attempt, integer microdollars, totals always = Σ rows.
// A cache hit is its own row with 0 µ$ and provenance pointing at the call that produced the cached result.
import type { ModelArmId, PromptVersion, Variant } from '../contracts/rerank-payload.ts';
import type { FailureReason, Usage } from '../contracts/rerank-response.ts';

export const CALL_STATUSES = [
  'ok',
  'format_failure',
  'provider_error',
  'timeout_uncertain',
  'stale_uncertain',
  'bound_violation',
  'cache_hit',
  'budget_refused',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export type Provenance = { kind: 'provider' } | { kind: 'cache'; sourceCallId: string };

export interface CallRow {
  /** `<requestKey[0..16]>-<attemptNo>`. */
  id: string;
  requestKey: string;
  runId: string;
  attemptNo: number;
  arm: ModelArmId;
  variant: Variant;
  repeatIndex: number;
  userKey: string;
  provider: string;
  model: string;
  promptVersion: PromptVersion;
  promptHash: string;
  cacheKey: string;
  mappingHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reportedUsage: Usage | null;
  priceTableDate: string | null;
  boundMicro: number;
  costMicro: number;
  latencyMs: number;
  status: CallStatus;
  provenance: Provenance;
  createdAt: string;
}

export interface Totals {
  attempts: number;
  costMicro: number;
  boundMicro: number;
  cacheHits: number;
}

export interface LedgerTotals extends Totals {
  byStatus: Record<CallStatus, number>;
  byArm: Record<string, Totals>;
  byRun: Record<string, Totals>;
}

export interface RowFilter {
  runId?: string;
  arm?: ModelArmId;
}

export interface Ledger {
  /** Validates and stores one attempt row; throws on a duplicate id or (requestKey, attemptNo). */
  append(row: CallRow): CallRow;
  rows(filter?: RowFilter): CallRow[];
  totals(filter?: RowFilter): LedgerTotals;
  /** 1 + the highest attemptNo already recorded for this request. */
  nextAttemptNo(requestKey: string): number;
}

function emptyTotals(): Totals {
  return { attempts: 0, costMicro: 0, boundMicro: 0, cacheHits: 0 };
}

function add(t: Totals, r: CallRow): void {
  t.attempts++;
  t.costMicro += r.costMicro;
  t.boundMicro += r.boundMicro;
  if (r.status === 'cache_hit') t.cacheHits++;
}

/** Pure Σ over rows (the only way totals are computed). */
export function totalsOf(rows: readonly CallRow[]): LedgerTotals {
  const byStatus = Object.fromEntries(CALL_STATUSES.map((s) => [s, 0])) as Record<CallStatus, number>;
  const all = emptyTotals();
  const byArm: Record<string, Totals> = {};
  const byRun: Record<string, Totals> = {};
  for (const r of rows) {
    add(all, r);
    byStatus[r.status]++;
    add((byArm[r.arm] ??= emptyTotals()), r);
    add((byRun[r.runId] ??= emptyTotals()), r);
  }
  return { ...all, byStatus, byArm, byRun };
}

/** Row invariants shared by every ledger implementation. Returns the first violation or null. */
export function rowViolation(r: CallRow): string | null {
  if (!Number.isInteger(r.attemptNo) || r.attemptNo < 1) return `attemptNo ${r.attemptNo} must be a positive integer`;
  if (!Number.isInteger(r.costMicro) || r.costMicro < 0) return `costMicro ${r.costMicro} must be a non-negative integer`;
  if (!Number.isInteger(r.boundMicro) || r.boundMicro < 0) return `boundMicro ${r.boundMicro} must be a non-negative integer`;
  if (r.status === 'cache_hit') {
    if (r.costMicro !== 0) return 'cache_hit rows cost 0 µ$';
    if (r.provenance.kind !== 'cache') return 'cache_hit rows carry cache provenance';
  } else if (r.provenance.kind !== 'provider') return 'only cache_hit rows carry cache provenance';
  return null;
}

// ---------------------------------------------------------------- response cache (PLAN §6 response_cache)

export interface CacheEntry {
  cacheKey: string;
  mappingHash: string;
  provider: string;
  model: string;
  promptHash: string;
  finalOrder: number[];
  rawLabelOrder: string[] | null;
  probabilities: Record<string, number> | null;
  repairs: { unknown: number; repeat: number; missing: number; emptyRanking: number };
  formatFailure: boolean;
  failureReason: FailureReason | null;
  usage: Usage | null;
  /** Ledger row id of the call that produced this result. */
  sourceCallId: string;
}

export interface ResponseCache {
  get(cacheKey: string): Promise<CacheEntry | null>;
  /** First write wins (a cache entry is never overwritten). */
  put(entry: CacheEntry): Promise<void>;
}
