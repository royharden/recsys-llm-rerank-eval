// llm-list arm (PLAN §4): one generative list-ranking call over the K candidates (labels C1..CK by presentation
// position), guarded into a permutation. Variants: base + probes hist_shuffle, cand_reversed, cand_shuffled, masked, repeat.
import type { RerankClient } from '../providers/types.ts';
import { createModelArm, type ModelArm, type ModelArmConfig } from './model-arm.ts';

export const LLM_LIST_DEFAULT_PROMPT = 'llm-list.v1';

export function createLlmListArm(client: RerankClient, cfg: ModelArmConfig): ModelArm {
  if (cfg.promptVersion !== 'llm-list.v1' && cfg.promptVersion !== 'llm-list.v2') {
    throw new Error(`llm-list: unknown prompt version ${cfg.promptVersion}`);
  }
  return createModelArm('llm-list', client, cfg);
}
