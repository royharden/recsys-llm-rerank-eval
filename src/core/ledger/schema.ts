import { z } from 'zod';
import { CALL_STATUSES, rowViolation } from './types.ts';
import { MODEL_ARMS, PROMPT_VERSIONS, VARIANTS } from '../contracts/rerank-payload.ts';
import { UsageSchema } from '../contracts/rerank-response.ts';
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const CallRowSchema = z.object({
  id: z.string().min(1).max(80), requestKey: hash, runId: z.string().min(1).max(64), attemptNo: count.min(1),
  arm: z.enum(MODEL_ARMS), variant: z.enum(VARIANTS), repeatIndex: z.union([z.literal(0), z.literal(1)]),
  userKey: z.string().regex(/^[0-9a-f]{16}$/), provider: z.string().min(1).max(32), model: z.string().min(1).max(64),
  promptVersion: z.enum(PROMPT_VERSIONS), promptHash: hash, cacheKey: hash, mappingHash: hash,
  inputTokens: count.nullable(), outputTokens: count.nullable(), cachedTokens: count.nullable(), reportedUsage: UsageSchema.nullable(),
  priceTableDate: z.string().nullable(), boundMicro: count, costMicro: count, latencyMs: count, status: z.enum(CALL_STATUSES),
  provenance: z.discriminatedUnion('kind', [z.object({ kind: z.literal('provider') }).strict(),
    z.object({ kind: z.literal('cache'), sourceCallId: z.string().min(1) }).strict()]), createdAt: z.string().datetime(),
}).strict().superRefine((row, ctx) => {
  const issue = rowViolation(row);
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
});
