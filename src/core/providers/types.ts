// Provider and rank-client interfaces. A provider adapter receives ONLY the validated RerankPayload plus the exact
// serialized request built from it (never a UserContext, SplitResult or Scorer). Arms talk to a RerankClient, which is
// the local mock pipeline (providers/mock.ts) or, from M4, the `rerank` function (providers/edge.ts).
import type { RerankPayload } from '../contracts/rerank-payload.ts';
import type { RerankResponse, Usage } from '../contracts/rerank-response.ts';

export type { Usage } from '../contracts/rerank-response.ts';

export type ProviderId = 'mock' | 'anthropic' | 'typesafe';

interface CallBase {
  payload: RerankPayload;
  /** Full serialized request body (prompts/request.ts); the bound is computed on these bytes. */
  body: string;
  /** 1-based attempt number for this request. */
  attemptNo: number;
}

export interface LlmListCall extends CallBase {
  kind: 'llm-list';
  /** max_tokens sent (16 + 6·K). A provider never reports more output tokens than this. */
  maxOutputTokens: number;
}

export interface JevCall extends CallBase {
  kind: 'jev-point';
  maxOutputTokens: 0;
}

export type ProviderCall = LlmListCall | JevCall;

export interface TextReply {
  kind: 'text';
  /** Raw model text (never stored); null = no reply. */
  text: string | null;
  /** Model id the provider reports; must equal the pin. */
  model: string;
  /** null = usage missing → bound_violation / accounting failure. */
  usage: Usage | null;
  latencyMs: number;
}

export interface ProbabilityReply {
  kind: 'probabilities';
  /** Raw answers object keyed c_<pos> (validated by rerankguard). */
  answers: unknown;
  model: string;
  usage: Usage | null;
  latencyMs: number;
}

export type ProviderReply = TextReply | ProbabilityReply;

/** A provider failure. `sent` = the request may have reached the provider (never retried; uncertain). */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly sent: boolean;
  readonly httpStatus: number | null;
  constructor(message: string, opts: { retryable: boolean; sent: boolean; httpStatus?: number | null }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.sent = opts.sent;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly model: string;
  call(req: ProviderCall, signal?: AbortSignal): Promise<ProviderReply>;
}

/** What the model arms use. */
export interface RerankClient {
  readonly mode: 'mock' | 'live';
  readonly provider: ProviderId;
  readonly model: string;
  rerank(payload: RerankPayload, signal?: AbortSignal): Promise<RerankResponse>;
}
