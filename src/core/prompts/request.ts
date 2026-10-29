// One entry point from a validated RerankPayload to the exact provider request (body, prompt hash, sampling params,
// output cap, billed units, label map). Used by the local mock client, the dry run and (vendored) the function, so all
// three bound and cache the same bytes. Vendorable: imports only prompts/ and contracts/.
import type { PromptVersion, RerankPayload } from '../contracts/rerank-payload.ts';
import { templateHash } from './hash.ts';
import { isJevVersion, JEV_TEMPLATES, jevPromptHash, renderJev, serializeJevRequest } from './jev-point.ts';
import { labelMap, type LabelMap } from './labels.ts';
import {
  isLlmListVersion,
  LLM_LIST_SYSTEM_PROMPT,
  LLM_LIST_TEMPLATES,
  llmListParams,
  llmListPromptHash,
  renderLlmList,
  serializeLlmListRequest,
} from './llm-list.ts';

export interface ProviderRequest {
  arm: RerankPayload['arm'];
  promptVersion: PromptVersion;
  model: string;
  /** Full serialized request body (bound input). */
  body: string;
  promptHash: string;
  /** Sampling params that enter the cacheKey ({} for Jev). */
  params: { [key: string]: number };
  /** The output cap actually sent (llm-list 16 + 6·K); 0 for Jev. */
  maxOutputTokens: number;
  /** Billed units: number of questions for Jev, 0 for llm-list. */
  units: number;
  labels: LabelMap;
}

export function buildProviderRequest(p: RerankPayload, model: string): ProviderRequest {
  const labels = labelMap(p);
  if (p.arm === 'llm-list') {
    const r = renderLlmList(p);
    return {
      arm: p.arm,
      promptVersion: p.promptVersion,
      model,
      body: serializeLlmListRequest(model, r),
      promptHash: llmListPromptHash(r),
      params: llmListParams(r),
      maxOutputTokens: r.maxTokens,
      units: 0,
      labels,
    };
  }
  const r = renderJev(p);
  return {
    arm: p.arm,
    promptVersion: p.promptVersion,
    model,
    body: serializeJevRequest(model, r),
    promptHash: jevPromptHash(r),
    params: {},
    maxOutputTokens: 0,
    units: r.questions.length,
    labels,
  };
}

/** Hash of a template version (llm-list templates include the fixed system prompt). */
export function templateHashOf(v: PromptVersion): string {
  if (isLlmListVersion(v)) return templateHash({ system: LLM_LIST_SYSTEM_PROMPT, template: LLM_LIST_TEMPLATES[v] });
  if (isJevVersion(v)) return templateHash({ template: JEV_TEMPLATES[v] });
  throw new Error(`templateHashOf: unknown prompt version ${String(v)}`);
}
