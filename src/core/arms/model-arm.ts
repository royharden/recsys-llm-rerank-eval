// Shared machinery of the two model arms (llm-list, jev-point): UserContext → RerankPayload (presentation order per
// variant, sanitised titles, masked titles, keys) → RerankClient → RankResult. Sees only the UserContext (no target);
// never imports split/temporal or split/scorer. kEff = 0 → no model call, empty order (kept as a miss by the runner).
import { mappingHash, requestKey } from '../contracts/keys.ts';
import {
  RerankPayloadSchema,
  type ModelArmId,
  type PayloadCandidate,
  type PayloadHistoryItem,
  type PromptVersion,
  type RerankPayload,
  type Variant,
} from '../contracts/rerank-payload.ts';
import { RerankResponseSchema, type RerankResponse } from '../contracts/rerank-response.ts';
import type { PromptItem } from '../contracts/types.ts';
import { sanitizeTitle, UNTITLED } from '../prompts/labels.ts';
import { maskTitles } from '../probes/masked.ts';
import { checkVariant, presentation, repeatIndexFor } from '../probes/orderprobe.ts';
import type { RerankClient } from '../providers/types.ts';
import type { UserContext } from '../split/context.ts';
import { isPermutationOf, localResult, type RankOptions, type RankResult, type Reranker } from './types.ts';

export interface ModelArmConfig {
  runId: string;
  configHash: string;
  datasetHash: string;
  promptVersion: PromptVersion;
  /** Seed for presentation shuffles (hist_shuffle, cand_shuffled, Jev question order). */
  seed: number;
}

function payloadItem(it: PromptItem): PayloadHistoryItem {
  return { itemId: it.itemId, title: sanitizeTitle(it.title) || UNTITLED, year: it.year, genres: it.genres.slice() };
}

/** The payload for one (user, arm, variant). Validated with the same schema the function uses. */
export function buildRerankPayload(ctx: UserContext, arm: ModelArmId, variant: Variant, cfg: ModelArmConfig): RerankPayload {
  if (!cfg.promptVersion.startsWith(`${arm}.`)) throw new Error(`buildRerankPayload: ${cfg.promptVersion} is not a ${arm} prompt`);
  const pres = presentation(ctx, arm, variant, cfg.seed);
  let history: PayloadHistoryItem[] = pres.history.map(payloadItem);
  let candidates: PayloadCandidate[] = pres.candidates.map((c) => ({ ...payloadItem(c), knnRank: c.knnRank }));
  if (variant === 'masked') {
    history = maskTitles(history);
    candidates = maskTitles(candidates);
  }
  const head = {
    schemaVersion: 1 as const,
    op: 'rank' as const,
    runId: cfg.runId,
    arm,
    variant,
    repeatIndex: repeatIndexFor(variant),
    promptVersion: cfg.promptVersion,
    userKey: ctx.userKey,
    configHash: cfg.configHash,
    datasetHash: cfg.datasetHash,
  };
  const payload = {
    ...head,
    requestKey: requestKey(head),
    mappingHash: mappingHash({ datasetHash: cfg.datasetHash, candidates, history }),
    history,
    candidates,
  };
  return RerankPayloadSchema.parse(payload);
}

export interface ModelRankDetail {
  result: RankResult;
  /** null when kEff = 0 (no call). */
  payload: RerankPayload | null;
  response: RerankResponse | null;
  /** Candidate ids in presentation order ([] when no call). */
  presentedIds: number[];
}

export interface ModelArm extends Reranker {
  readonly id: ModelArmId;
  readonly config: Readonly<ModelArmConfig>;
  rankDetailed(ctx: UserContext, opts?: RankOptions): Promise<ModelRankDetail>;
}

export function isModelArm(a: { id: string }): a is ModelArm {
  return typeof (a as Partial<ModelArm>).rankDetailed === 'function';
}

export function createModelArm(arm: ModelArmId, client: RerankClient, cfg: ModelArmConfig): ModelArm {
  if (!cfg.promptVersion.startsWith(`${arm}.`)) throw new Error(`${arm}: prompt version ${cfg.promptVersion} belongs to another arm`);
  const config = { ...cfg };
  const rankDetailed = async (ctx: UserContext, opts?: RankOptions): Promise<ModelRankDetail> => {
    const variant = checkVariant(arm, opts?.variant ?? 'base');
    if (opts?.repeatIndex !== undefined && opts.repeatIndex !== repeatIndexFor(variant)) {
      throw new Error(`${arm}: repeatIndex ${opts.repeatIndex} does not match variant ${variant}`);
    }
    if (opts?.runId !== undefined && opts.runId !== config.runId) throw new Error(`${arm}: runId ${opts.runId} differs from the arm's ${config.runId}`);
    if (ctx.kEff === 0 || ctx.candidates.length === 0) {
      return { result: localResult([]), payload: null, response: null, presentedIds: [] };
    }
    const payload = buildRerankPayload(ctx, arm, variant, config);
    const response = RerankResponseSchema.parse(await client.rerank(payload, opts?.signal));
    for (const key of ['requestKey', 'mappingHash', 'arm', 'variant', 'repeatIndex', 'promptVersion'] as const) {
      if (response[key] !== payload[key]) throw new Error(`${arm}: response ${key} differs from request`);
    }
    if (response.provider !== client.provider || response.model !== client.model) throw new Error(`${arm}: response provider/model differs from pin`);
    const ids = ctx.candidates.map((c) => c.itemId);
    if (!isPermutationOf(response.finalOrder, ids)) throw new Error(`${arm}: response order is not a permutation of the candidates`);
    return {
      result: {
        order: response.finalOrder.slice(),
        repairs: { ...response.repairs },
        formatFailure: response.formatFailure,
        callIds: response.callIds.slice(),
      },
      payload,
      response,
      presentedIds: payload.candidates.map((c) => c.itemId),
    };
  };
  return {
    id: arm,
    kind: 'reranker',
    config,
    rankDetailed,
    rank: (ctx, opts) => rankDetailed(ctx, opts).then((d) => d.result),
  };
}
