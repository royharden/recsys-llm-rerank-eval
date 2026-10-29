// jev-point arm (PLAN §4): one Jev request with K independent questions keyed c_<pos>; question order shuffled by seed
// in core before sending; sorted by probability desc, ties → knnRank; any missing/non-finite answer → kNN fallback.
// Variants: base + probe q_shuffle (an independent question order).
import type { RerankClient } from '../providers/types.ts';
import { createModelArm, type ModelArm, type ModelArmConfig } from './model-arm.ts';

export const JEV_PROMPT = 'jev-point.v1';

export function createJevPointArm(client: RerankClient, cfg: ModelArmConfig): ModelArm {
  if (cfg.promptVersion !== 'jev-point.v1') throw new Error(`jev-point: unknown prompt version ${cfg.promptVersion}`);
  return createModelArm('jev-point', client, cfg);
}
