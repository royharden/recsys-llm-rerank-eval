import { z } from 'zod';
import { ARM_IDS } from '../arms/types.ts';
import { RepairCountsSchema } from '../contracts/rerank-response.ts';
import { VARIANTS } from '../contracts/rerank-payload.ts';
import type { CallRow } from '../ledger/types.ts';
import { CallRowSchema } from '../ledger/schema.ts';
import type { UserEval } from '../metrics/ranking.ts';
import { hashCanonical } from '../util/hash.ts';

const hex = z.string().regex(/^[0-9a-f]{64}$/);
export const RunIdentitySchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1).max(64), mode: z.enum(['mock', 'live']),
  split: z.enum(['dev', 'heldout']), datasetHash: hex, manifestHash: hex, configHash: hex,
  preregHash: hex.nullable(),
}).strict().superRefine((run, ctx) => {
  if (run.mode === 'live' && run.split === 'heldout' && run.preregHash === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'held-out live runs require a dated preregistration hash' });
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

export const ResultRowSchema = z.object({
  runId: z.string(), arm: z.enum(ARM_IDS), variant: z.enum(VARIANTS), repeatIndex: z.union([z.literal(0), z.literal(1)]),
  userKey: z.string().regex(/^[0-9a-f]{16}$/), candidateIds: z.array(z.number().int().positive()).max(30),
  rankedIds: z.array(z.number().int().positive()).max(30), presentedIds: z.array(z.number().int().positive()).max(30),
  kEff: z.number().int().min(0).max(30), flags: z.array(z.enum(['short_list', 'no_candidates'])),
  targetRank: z.number().int().positive().nullable(), inCandidates: z.boolean(), targetPopularity: z.number().int().nonnegative(),
  coldTarget: z.boolean(), repairs: RepairCountsSchema, formatFailure: z.boolean(), callIds: z.array(z.string()),
}).strict();
export type ResultRow = z.infer<typeof ResultRowSchema>;
export type ResultKey = Pick<ResultRow, 'runId' | 'arm' | 'variant' | 'repeatIndex' | 'userKey'>;
export function resultKey(row: ResultKey): string {
  return [row.runId, row.arm, row.variant, row.repeatIndex, row.userKey].join('|');
}

// Target ids, raw ratings, titles, prompts and manifest salt are deliberately absent from result storage.
export function evalOf(row: ResultRow): UserEval {
  const rank = row.targetRank;
  return {
    userKey: row.userKey, rank, hit10: rank !== null && rank <= 10 ? 1 : 0,
    ndcg10: rank !== null && rank <= 10 ? 1 / Math.log2(rank + 1) : 0,
    rrK: rank === null ? 0 : 1 / rank, targetInCandidates: row.inCandidates,
    targetInOwnList: rank !== null, targetPopularity: row.targetPopularity, coldTarget: row.coldTarget,
    top10: row.rankedIds.slice(0, 10), kEff: row.kEff, flags: row.flags,
  };
}

export interface ResultStore {
  /** Bind once; resume must match every identity field, including frozen config/prereg hashes. */
  bind(identity: RunIdentity): Promise<void>;
  get(key: ResultKey): Promise<ResultRow | null>;
  put(row: ResultRow): Promise<void>;
  rows(): Promise<ResultRow[]>;
  appendCall(row: CallRow): Promise<void>;
  calls(): Promise<CallRow[]>;
}

export function createMemoryResultStore(): ResultStore {
  let bound: RunIdentity | null = null;
  const rows = new Map<string, ResultRow>();
  const calls = new Map<string, CallRow>();
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    async bind(identity) {
      const parsed = RunIdentitySchema.parse(identity);
      if (bound && hashCanonical(bound) !== hashCanonical(parsed)) throw new Error('resume identity mismatch');
      bound = parsed;
    },
    async get(key) { const row = rows.get(resultKey(key)); return row ? copy(row) : null; },
    async put(input) {
      const row = ResultRowSchema.parse(input);
      if (!bound || row.runId !== bound.runId) throw new Error('result store must be bound to this run');
      if (new Set(row.candidateIds).size !== row.candidateIds.length || row.kEff !== row.candidateIds.length || row.rankedIds.length !== row.kEff ||
          new Set(row.rankedIds).size !== row.rankedIds.length || (row.targetRank !== null && row.targetRank > row.rankedIds.length)) {
        throw new Error('invalid result cardinality/rank');
      }
      const key = resultKey(row);
      const old = rows.get(key);
      if (old && hashCanonical(old) !== hashCanonical(row)) throw new Error(`immutable result conflict: ${key}`);
      rows.set(key, copy(row));
    },
    async rows() { return [...rows.values()].map(copy); },
    async appendCall(input) {
      const row = CallRowSchema.parse(input);
      if (!bound || row.runId !== bound.runId) throw new Error('call belongs to a different run');
      const old = calls.get(row.id);
      if (old && hashCanonical(old) !== hashCanonical(row)) throw new Error(`immutable call conflict: ${row.id}`);
      calls.set(row.id, copy(row));
    },
    async calls() { return [...calls.values()].map(copy); },
  };
}
