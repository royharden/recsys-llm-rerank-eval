// Repeat probe (PLAN §4): identical prompt, repeatIndex = 1, same params. Reported as top-1 agreement and Kendall τ
// between the base and repeat orders (both permutations of the same candidates). No target needed.

/** Kendall τ-a between two permutations of the same set; null when n < 2. Throws if the sets differ. */
export function kendallTau(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) throw new Error('kendallTau: lengths differ');
  const n = a.length;
  if (n < 2) return null;
  const posB = new Map(b.map((id, i): [number, number] => [id, i]));
  if (posB.size !== n) throw new Error('kendallTau: repeated ids');
  const pb = a.map((id) => {
    const p = posB.get(id);
    if (p === undefined) throw new Error(`kendallTau: id ${id} missing from the second order`);
    return p;
  });
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s += pb[i] < pb[j] ? 1 : -1;
  return s / ((n * (n - 1)) / 2);
}

export function top1Agrees(a: readonly number[], b: readonly number[]): boolean | null {
  if (a.length === 0 || b.length === 0) return null;
  return a[0] === b[0];
}

export interface RepeatSummary {
  /** Pairs with a non-empty order. */
  n: number;
  /** Share of pairs whose first item agrees; null when n = 0. */
  top1Agreement: number | null;
  /** Mean Kendall τ over pairs with ≥ 2 candidates; null when none. */
  meanKendallTau: number | null;
  tauN: number;
}

export function summarizeRepeat(pairs: readonly { base: readonly number[]; repeat: readonly number[] }[]): RepeatSummary {
  let n = 0;
  let agree = 0;
  let tauN = 0;
  let tauSum = 0;
  for (const p of pairs) {
    const t1 = top1Agrees(p.base, p.repeat);
    if (t1 === null) continue;
    n++;
    if (t1) agree++;
    const tau = kendallTau(p.base, p.repeat);
    if (tau !== null) {
      tauN++;
      tauSum += tau;
    }
  }
  return { n, top1Agreement: n ? agree / n : null, meanKendallTau: tauN ? tauSum / tauN : null, tauN };
}
