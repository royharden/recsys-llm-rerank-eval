import type { UserContext } from '../../src/core/split/context.ts';
import type { ModelArmConfig } from '../../src/core/arms/model-arm.ts';
export const MODEL_CFG: ModelArmConfig = { runId: 'test-mock', configHash: 'a'.repeat(64), datasetHash: 'b'.repeat(64), seed: 38, promptVersion: 'llm-list.v1' };
export function modelContext(index = 1, size = 20): UserContext {
  return { userKey: index.toString(16).padStart(16, '0'), history: [9001, 9002],
    promptHistory: [{ itemId: 9001, title: 'Northern Signal', year: 1990, genres: ['Drama'] },
      { itemId: 9002, title: 'Last Frontier', year: 1992, genres: ['Action'] }],
    candidates: Array.from({ length: size }, (_, i) => ({ itemId: 10001 + i, title: `Candidate ${String.fromCharCode(65 + i)}`,
      year: 1995, genres: ['Action'] as ['Action'], knnRank: i + 1 })), kEff: size,
    flags: size === 0 ? ['short_list', 'no_candidates'] : size < 20 ? ['short_list'] : [] };
}
