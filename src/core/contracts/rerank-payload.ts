// RerankPayload: the only thing a client sends to the `rerank` function and the only thing a provider (incl. the mock)
// is given (PLAN §4, M3 acceptance (a)). Vendorable: imports only contracts/, util/ and zod.
//
// Deliberately ABSENT: any target / held-out item, any free-text prompt, system prompt, model, URL, temperature or token
// parameter (those are fixed server-side by promptVersion and prices.json), ratings, timestamps. The object schemas are
// .strict(), so a payload carrying any extra field is rejected (422).
// Candidate and history arrays are in PRESENTATION order for this variant; the server assigns labels C<pos>/H<pos> (and
// Jev keys c_<pos>) from that order and needs no PRNG.
import { z } from 'zod';
import { utf8ByteLength } from './bound.ts';
import { mappingHash, requestKey } from './keys.ts';
import { GENRES } from './types.ts';

export const MODEL_ARMS = ['llm-list', 'jev-point'] as const;
export type ModelArmId = (typeof MODEL_ARMS)[number];

export const VARIANTS = ['base', 'hist_shuffle', 'cand_reversed', 'cand_shuffled', 'masked', 'repeat', 'q_shuffle'] as const;
export type Variant = (typeof VARIANTS)[number];

/** Variants each model arm accepts: llm-list base + 5 probes, jev-point base + the question-order probe (PLAN §4). */
export const ARM_VARIANTS: Readonly<Record<ModelArmId, readonly Variant[]>> = {
  'llm-list': ['base', 'hist_shuffle', 'cand_reversed', 'cand_shuffled', 'masked', 'repeat'],
  'jev-point': ['base', 'q_shuffle'],
};

export const PROMPT_VERSIONS = ['llm-list.v1', 'llm-list.v2', 'jev-point.v1'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

export const PAYLOAD_LIMITS = {
  maxHistory: 30,
  maxCandidates: 30,
  /** Titles are sanitised to <= 120 characters before they are put in a payload (prompts/labels.ts sanitizeTitle). */
  maxTitleChars: 120,
  maxGenres: GENRES.length,
  /** UTF-8 bytes of the JSON request body; larger bodies are rejected with 413 before parsing. */
  maxBytes: 32_768,
} as const;

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = z.string().regex(HEX64, 'must be 64 lowercase hex characters');
const posInt = z.number().int().positive().max(1_000_000_000);
const year = z.number().int().min(1800).max(2100).nullable();

export const PayloadHistoryItemSchema = z
  .object({
    itemId: posInt,
    title: z.string().max(PAYLOAD_LIMITS.maxTitleChars),
    year,
    genres: z.array(z.enum(GENRES)).max(PAYLOAD_LIMITS.maxGenres),
  })
  .strict();

export const PayloadCandidateSchema = z
  .object({
    itemId: posInt,
    title: z.string().max(PAYLOAD_LIMITS.maxTitleChars),
    year,
    genres: z.array(z.enum(GENRES)).max(PAYLOAD_LIMITS.maxGenres),
    /** 1-based position in the item-kNN list: the canonical fallback order. Never rendered into prompt text. */
    knnRank: posInt,
  })
  .strict();

/** The object shape without cross-field rules (exported so tests can inspect `.shape`). */
export const RerankPayloadObject = z
  .object({
    schemaVersion: z.literal(1),
    op: z.literal('rank'),
    runId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, 'runId: 1-64 characters [A-Za-z0-9._:-]'),
    arm: z.enum(MODEL_ARMS),
    variant: z.enum(VARIANTS),
    repeatIndex: z.union([z.literal(0), z.literal(1)]),
    promptVersion: z.enum(PROMPT_VERSIONS),
    userKey: z.string().regex(/^[0-9a-f]{16}$/, 'userKey must be 16 lowercase hex characters'),
    configHash: hex64,
    datasetHash: hex64,
    requestKey: hex64,
    mappingHash: hex64,
    history: z.array(PayloadHistoryItemSchema).max(PAYLOAD_LIMITS.maxHistory),
    candidates: z.array(PayloadCandidateSchema).min(1).max(PAYLOAD_LIMITS.maxCandidates),
  })
  .strict();

export type PayloadHistoryItem = z.infer<typeof PayloadHistoryItemSchema>;
export type PayloadCandidate = z.infer<typeof PayloadCandidateSchema>;
export type RerankPayload = z.infer<typeof RerankPayloadObject>;

/** Cross-field rules. Returned as messages so both zod and callers can use them. */
export function payloadRuleViolations(p: RerankPayload): string[] {
  const out: string[] = [];
  if (!ARM_VARIANTS[p.arm].includes(p.variant)) out.push(`variant ${p.variant} is not valid for arm ${p.arm}`);
  if (!p.promptVersion.startsWith(`${p.arm}.`)) out.push(`promptVersion ${p.promptVersion} does not belong to arm ${p.arm}`);
  const wantRepeat = p.variant === 'repeat' ? 1 : 0;
  if (p.repeatIndex !== wantRepeat) out.push(`repeatIndex must be ${wantRepeat} for variant ${p.variant}`);
  const masked = p.variant === 'masked';
  const items = [...p.history, ...p.candidates];
  if (masked && items.some((it) => it.title !== '')) out.push('masked variant: every title must be empty');
  if (!masked && items.some((it) => it.title.trim() === '')) out.push('titles must be non-empty outside the masked variant');
  const candIds = new Set(p.candidates.map((c) => c.itemId));
  if (candIds.size !== p.candidates.length) out.push('candidate item ids must be distinct');
  const ranks = p.candidates.map((c) => c.knnRank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) out.push('candidate knnRank values must be a permutation of 1..n');
  const histIds = new Set(p.history.map((h) => h.itemId));
  if (histIds.size !== p.history.length) out.push('history item ids must be distinct');
  if (p.history.some((h) => candIds.has(h.itemId))) out.push('a candidate also appears in the history');
  return out;
}

/** Full schema: object shape + cross-field rules. */
export const RerankPayloadSchema = RerankPayloadObject.superRefine((p, ctx) => {
  for (const message of payloadRuleViolations(p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
});

/** Keys a payload must carry, recomputed from its own fields (the function rejects a mismatch). */
export function expectedKeys(p: RerankPayload): { requestKey: string; mappingHash: string } {
  return {
    requestKey: requestKey(p),
    mappingHash: mappingHash({ datasetHash: p.datasetHash, candidates: p.candidates, history: p.history }),
  };
}

export type PayloadCheck =
  | { ok: true; payload: RerankPayload }
  | { ok: false; status: 413 | 422; error: string };

function check(p: RerankPayload): PayloadCheck {
  const keys = expectedKeys(p);
  if (keys.requestKey !== p.requestKey) return { ok: false, status: 422, error: 'requestKey does not match the payload' };
  if (keys.mappingHash !== p.mappingHash) return { ok: false, status: 422, error: 'mappingHash does not match the payload' };
  return { ok: true, payload: p };
}

/** Validate an already-parsed value: schema, cross-field rules, recomputed keys, byte cap. */
export function validatePayload(input: unknown): PayloadCheck {
  const parsed = RerankPayloadSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, status: 422, error: `invalid payload at ${i.path.join('.') || '$'}: ${i.message}` };
  }
  if (payloadByteLength(parsed.data) > PAYLOAD_LIMITS.maxBytes) {
    return { ok: false, status: 413, error: `payload exceeds ${PAYLOAD_LIMITS.maxBytes} bytes` };
  }
  return check(parsed.data);
}

/** Validate a raw request body: byte cap first (413), then JSON (422), then validatePayload. */
export function parsePayloadText(text: string): PayloadCheck {
  if (utf8ByteLength(text) > PAYLOAD_LIMITS.maxBytes) {
    return { ok: false, status: 413, error: `payload exceeds ${PAYLOAD_LIMITS.maxBytes} bytes` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, status: 422, error: 'payload is not valid JSON' };
  }
  return validatePayload(value);
}

export function payloadByteLength(p: RerankPayload): number {
  return utf8ByteLength(JSON.stringify(p));
}
