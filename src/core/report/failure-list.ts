import type { ResultRow } from '../runner/store.ts';
export interface FailureCase { userKey: string; arm: 'llm-list' | 'jev-point'; knnRank: number; modelRank: number | null; formatFailure: boolean }
/** Exactly kNN target rank <=10 and LLM rank >10 (absent counts as >10). No success-only filtering. */
export function failureList(rows: readonly ResultRow[]): FailureCase[] {
  const base = rows.filter((r) => r.variant === 'base');
  const knn = new Map(base.filter((r) => r.arm === 'itemknn').map((r) => [r.userKey, r]));
  const out: FailureCase[] = [];
  for (const r of base) {
    if (r.arm !== 'llm-list' && r.arm !== 'jev-point') continue;
    const rank = knn.get(r.userKey)?.targetRank;
    if (rank !== null && rank !== undefined && rank <= 10 && (r.targetRank === null || r.targetRank > 10)) {
      out.push({ userKey: r.userKey, arm: r.arm, knnRank: rank, modelRank: r.targetRank, formatFailure: r.formatFailure });
    }
  }
  return out.sort((a, b) => a.userKey.localeCompare(b.userKey) || a.arm.localeCompare(b.arm));
}
