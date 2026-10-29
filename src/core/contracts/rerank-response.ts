// RerankResponse: what the rank path (the function for live, the local mock client for mock) returns for one payload.
// Vendorable: imports only contracts/ and zod. No prompt text and no raw model prose are carried back.
import { z } from 'zod';
import { MODEL_ARMS, PROMPT_VERSIONS, VARIANTS } from './rerank-payload.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

export const RepairCountsSchema = z
  .object({ unknown: count, repeat: count, missing: count, emptyRanking: count })
  .strict();

export const UsageSchema = z
  .object({ inputTokens: count, outputTokens: count, cachedTokens: count })
  .strict();

export type Usage = z.infer<typeof UsageSchema>;

export const FAILURE_REASONS = [
  'no_reply',
  'not_json',
  'wrong_type',
  'empty_ranking',
  'missing_answer',
  'non_finite',
  'out_of_range',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const RerankResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: hex64,
    mappingHash: hex64,
    cacheKey: hex64,
    arm: z.enum(MODEL_ARMS),
    variant: z.enum(VARIANTS),
    repeatIndex: z.union([z.literal(0), z.literal(1)]),
    provider: z.string().min(1).max(32),
    model: z.string().min(1).max(64),
    promptVersion: z.enum(PROMPT_VERSIONS),
    promptHash: hex64,
    /** Final permutation of the candidate item ids (after the guard). */
    finalOrder: z.array(z.number().int().positive()).max(30),
    /** Label strings as the model returned them (truncated), llm-list only; null for Jev / unusable replies. */
    rawLabelOrder: z.array(z.string().max(16)).max(64).nullable(),
    /** Jev probabilities keyed c_<pos>; null for llm-list / format failures. */
    probabilities: z.record(z.string().max(8), z.number().min(0).max(1)).nullable(),
    repairs: RepairCountsSchema,
    formatFailure: z.boolean(),
    failureReason: z.enum(FAILURE_REASONS).nullable(),
    cacheHit: z.boolean(),
    usage: UsageSchema.nullable(),
    costMicro: count,
    /** Per-attempt hard bound of the successful attempt (0 for a cache hit). */
    boundMicro: count,
    latencyMs: count,
    /** Ledger row ids of every attempt for this request (one per attempt, incl. failed ones). */
    callIds: z.array(z.string().min(1).max(80)).min(1).max(8),
  })
  .strict();

export type RerankResponse = z.infer<typeof RerankResponseSchema>;
