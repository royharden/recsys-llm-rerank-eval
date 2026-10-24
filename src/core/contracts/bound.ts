// Hard per-attempt cost bound (PLAN §7 step 6) and the display estimate. Vendorable: imports only util/ and contracts/.
// The SAME functions are used by the dry-run worst case (budget/estimate.ts) and by the function's reservations (M4).
//
//   maxInputTokens  = UTF-8 bytes of the full serialized request body + perRequestOverheadTokens × max(1, units)
//                     (a construction assumption: a token is never shorter than one byte; boundVerified gates live use)
//   maxOutputTokens = the cap actually sent (llm-list: 16 + 6·K) / 0 for Jev (output free)
//   boundMicro      = ceil(maxIn · inUsdPerMTok + maxOut · outUsdPerMTok + 1e6 · (perCallUsd + units · perUnitUsd))
//
// The display estimate (tokens ≈ characters / 4) is NOT a bound and is always labelled as such.
import { utf8Encode } from '../util/sha256.ts';
import type { CompletePrice } from './prices.ts';

export const WORST_CASE_ATTEMPTS = 3;
export const DISPLAY_ESTIMATE_LABEL = 'display estimate: tokens ≈ characters / 4 (not a bound)';
export const BOUND_LABEL = 'hard bound: UTF-8 bytes of the full request + per-request overhead; output = the cap sent';

export function utf8ByteLength(s: string): number {
  return utf8Encode(s).length;
}

/** The display/mock token estimator: ceil(UTF-16 length / 4). Also used by the mock provider to report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenBound {
  requestBytes: number;
  overheadTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  units: number;
}

export function tokenBound(body: string, maxOutputTokens: number, perRequestOverheadTokens: number, units = 0): TokenBound {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0) throw new Error(`tokenBound: bad maxOutputTokens ${maxOutputTokens}`);
  if (!Number.isInteger(units) || units < 0) throw new Error(`tokenBound: bad units ${units}`);
  const requestBytes = utf8ByteLength(body);
  const overheadTokens = perRequestOverheadTokens * Math.max(1, units);
  return { requestBytes, overheadTokens, maxInputTokens: requestBytes + overheadTokens, maxOutputTokens, units };
}

/** Microdollars, rounded UP (ceil) so a bound can only over-estimate. */
export function microdollars(inputTokens: number, outputTokens: number, units: number, price: CompletePrice): number {
  const raw =
    inputTokens * price.inputUsdPerMTok +
    outputTokens * price.outputUsdPerMTok +
    1_000_000 * (price.perCallUsd + units * price.perUnitUsd);
  if (!Number.isFinite(raw) || raw < 0) throw new Error('microdollars: non-finite or negative amount');
  return Math.ceil(raw);
}

export interface HardBound extends TokenBound {
  boundMicro: number;
}

export function hardBound(body: string, maxOutputTokens: number, price: CompletePrice, units = 0): HardBound {
  const t = tokenBound(body, maxOutputTokens, price.perRequestOverheadTokens, units);
  return { ...t, boundMicro: microdollars(t.maxInputTokens, t.maxOutputTokens, units, price) };
}

export interface UsageLike {
  inputTokens: number;
  outputTokens: number;
}

/** Reported usage must be present, finite, non-negative and within the token bound; otherwise → bound_violation. */
export function usageWithinBound(usage: UsageLike | null | undefined, bound: TokenBound): boolean {
  if (!usage) return false;
  const { inputTokens: i, outputTokens: o } = usage;
  if (!Number.isInteger(i) || !Number.isInteger(o) || i < 0 || o < 0) return false;
  return i <= bound.maxInputTokens && o <= bound.maxOutputTokens;
}

/** Actual cost of an attempt from reported usage. */
export function costMicroOf(usage: UsageLike, units: number, price: CompletePrice): number {
  return microdollars(usage.inputTokens, usage.outputTokens, units, price);
}
