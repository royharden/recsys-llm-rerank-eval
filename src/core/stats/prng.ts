// Seeded randomness for every stochastic step (splits, shuffles, mock provider, bootstrap). Never Math.random in core.
import { sha256HexString } from '../util/sha256.ts';

/** A uniform generator on [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent 32-bit sub-seed from labelled parts: first 32 bits of sha256(parts.join('|')). */
export function deriveSeed(...parts: (string | number)[]): number {
  return parseInt(sha256HexString(parts.join('|')).slice(0, 8), 16) >>> 0;
}

/** mulberry32 seeded by deriveSeed(parts). */
export function rngFor(...parts: (string | number)[]): Rng {
  return mulberry32(deriveSeed(...parts));
}

/** Uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`randInt: n must be a positive integer, got ${n}`);
  return Math.floor(rng() * n);
}

/** In-place Fisher–Yates shuffle (i from n−1 down to 1, j uniform in [0, i]). Returns the same array. */
export function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Seeded Fisher–Yates shuffle of a copy. */
export function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  return shuffleInPlace(arr.slice(), rng);
}
