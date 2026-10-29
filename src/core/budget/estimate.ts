// Dry run (PLAN §8, M3 acceptance (g)): planned model calls per arm/variant, a DISPLAY $ estimate (chars/4 tokens,
// clearly labelled) and the WORST-CASE bound $ (contracts/bound.ts hard bound × 3 attempts), with ZERO network:
// it builds the same payloads and provider requests the run would send, and never touches a provider or client.
// Prices come from prices.json; a missing price makes that line "unavailable: price_missing" (never a guess).
import { buildRerankPayload, type ModelArmConfig } from '../arms/model-arm.ts';
import {
  BOUND_LABEL,
  DISPLAY_ESTIMATE_LABEL,
  estimateTokens,
  hardBound,
  microdollars,
  tokenBound,
  WORST_CASE_ATTEMPTS,
  type TokenBound,
} from '../contracts/bound.ts';
import { completePrice, priceFor, type PriceTable } from '../contracts/prices.ts';
import type { ModelArmId, RerankPayload, Variant } from '../contracts/rerank-payload.ts';
import { candidateLabel } from '../prompts/labels.ts';
import { buildProviderRequest, type ProviderRequest } from '../prompts/request.ts';
import { PROBES_BY_ARM } from '../probes/orderprobe.ts';
import type { UserContext } from '../split/context.ts';

export interface PricingTarget {
  provider: string;
  model: string;
}

export interface DryRunInput {
  contexts: readonly UserContext[];
  /** userKeys that receive probe variants; null/empty = no probes. */
  probeUserKeys: ReadonlySet<string> | null;
  arms: readonly ModelArmId[];
  /** Per-arm payload config (runId, configHash, datasetHash, promptVersion, seed). */
  configs: Readonly<Partial<Record<ModelArmId, ModelArmConfig>>>;
  /** Which provider/model each arm would be billed as (mock → 0 µ$; live → prices.json). */
  pricing: Readonly<Partial<Record<ModelArmId, PricingTarget>>>;
  prices: PriceTable;
  attempts?: number;
}

export interface PlannedCall {
  arm: ModelArmId;
  variant: Variant;
  payload: RerankPayload;
  request: ProviderRequest;
  /** Token bound for one attempt (prices not needed). */
  tokens: TokenBound;
}

export interface DryRunLine {
  arm: ModelArmId;
  variant: Variant;
  provider: string;
  model: string;
  calls: number;
  displayInputTokens: number;
  displayOutputTokens: number;
  /** Display estimate in µ$ (chars/4), or null when the price is unavailable. */
  displayMicro: number | null;
  /** Σ over calls of hard bound × attempts, in µ$, or null when the price is unavailable. */
  worstCaseMicro: number | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  unavailable: string | null;
}

export interface DryRunTotals {
  calls: number;
  displayMicro: number | null;
  worstCaseMicro: number | null;
}

export interface DryRun {
  lines: DryRunLine[];
  byArm: Record<string, DryRunTotals>;
  totals: DryRunTotals;
  attemptsWorstCase: number;
  displayLabel: string;
  boundLabel: string;
  network: 'none';
}

/** Variants each arm runs: base for everyone, probes for the probe sample. */
export function plannedVariants(arm: ModelArmId, withProbes: boolean): Variant[] {
  return withProbes ? ['base', ...PROBES_BY_ARM[arm]] : ['base'];
}

/** Every call the run would make (users with kEff = 0 make none). Pure; no client, no provider, no network. */
export function plannedCalls(input: Omit<DryRunInput, 'pricing' | 'prices' | 'attempts'> & { overheadTokens?: (arm: ModelArmId) => number }): PlannedCall[] {
  const out: PlannedCall[] = [];
  const probes = input.probeUserKeys && input.probeUserKeys.size > 0 ? input.probeUserKeys : null;
  for (const arm of input.arms) {
    const cfg = input.configs[arm];
    if (!cfg) throw new Error(`plannedCalls: no config for ${arm}`);
    for (const variant of plannedVariants(arm, probes !== null)) {
      for (const ctx of input.contexts) {
        if (ctx.kEff === 0 || ctx.candidates.length === 0) continue;
        if (variant !== 'base' && !probes?.has(ctx.userKey)) continue;
        const payload = buildRerankPayload(ctx, arm, variant, cfg);
        const request = buildProviderRequest(payload, 'dry-run-model');
        out.push({ arm, variant, payload, request, tokens: tokenBound(request.body, request.maxOutputTokens, input.overheadTokens?.(arm) ?? 0, request.units) });
      }
    }
  }
  return out;
}

/** Expected output text size for the display estimate: an ideal {"ranking":[...]} reply (llm-list), 0 for Jev. */
function displayOutputTokens(r: ProviderRequest): number {
  if (r.arm !== 'llm-list') return 0;
  const labels = r.labels.candidates.map((_, i) => candidateLabel(i + 1));
  return Math.min(r.maxOutputTokens, estimateTokens(JSON.stringify({ ranking: labels })));
}

function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function dryRun(input: DryRunInput): DryRun {
  const attempts = input.attempts ?? WORST_CASE_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > WORST_CASE_ATTEMPTS) throw new Error('dryRun: attempts must be an integer in 1..3');
  const lines = new Map<string, DryRunLine>();
  for (const arm of input.arms) {
    const target = input.pricing[arm];
    if (!target) throw new Error(`dryRun: no pricing target for ${arm}`);
    const entry = priceFor(input.prices, target.provider, target.model);
    const pc = completePrice(input.prices, entry);
    const overhead = entry?.perRequestOverheadTokens ?? 0;
    const calls = plannedCalls({ ...input, arms: [arm], overheadTokens: () => overhead });
    for (const variant of plannedVariants(arm, (input.probeUserKeys?.size ?? 0) > 0)) {
      lines.set(`${arm}|${variant}`, {
        arm,
        variant,
        provider: target.provider,
        model: target.model,
        calls: 0,
        displayInputTokens: 0,
        displayOutputTokens: 0,
        displayMicro: pc.ok ? 0 : null,
        worstCaseMicro: pc.ok ? 0 : null,
        maxInputTokens: 0,
        maxOutputTokens: 0,
        unavailable: pc.ok ? null : `unavailable: ${pc.code} (${pc.detail})`,
      });
    }
    for (const c of calls) {
      const line = lines.get(`${arm}|${c.variant}`);
      if (!line) continue;
      // Re-serialise with the billed model id so the bytes match what the run would send.
      const request = buildProviderRequest(c.payload, target.model);
      const dIn = estimateTokens(request.body);
      const dOut = displayOutputTokens(request);
      line.calls++;
      line.displayInputTokens += dIn;
      line.displayOutputTokens += dOut;
      const tb = tokenBound(request.body, request.maxOutputTokens, overhead, request.units);
      line.maxInputTokens += tb.maxInputTokens;
      line.maxOutputTokens += tb.maxOutputTokens;
      if (pc.ok && line.displayMicro !== null && line.worstCaseMicro !== null) {
        line.displayMicro += microdollars(dIn, dOut, request.units, pc.price);
        line.worstCaseMicro += attempts * hardBound(request.body, request.maxOutputTokens, pc.price, request.units).boundMicro;
      }
    }
  }
  const all = [...lines.values()];
  const byArm: Record<string, DryRunTotals> = {};
  const totals: DryRunTotals = { calls: 0, displayMicro: 0, worstCaseMicro: 0 };
  for (const l of all) {
    const a = (byArm[l.arm] ??= { calls: 0, displayMicro: 0, worstCaseMicro: 0 });
    a.calls += l.calls;
    a.displayMicro = sumOrNull(a.displayMicro, l.displayMicro);
    a.worstCaseMicro = sumOrNull(a.worstCaseMicro, l.worstCaseMicro);
    totals.calls += l.calls;
    totals.displayMicro = sumOrNull(totals.displayMicro, l.displayMicro);
    totals.worstCaseMicro = sumOrNull(totals.worstCaseMicro, l.worstCaseMicro);
  }
  return {
    lines: all,
    byArm,
    totals,
    attemptsWorstCase: attempts,
    displayLabel: DISPLAY_ESTIMATE_LABEL,
    boundLabel: `${BOUND_LABEL}; worst case = bound × ${attempts} attempts`,
    network: 'none',
  };
}

/** Does the worst case fit a cap (µ$)? null when any price is unavailable (live start must then refuse). */
export function worstCaseFits(d: DryRun, capMicro: number): boolean | null {
  return d.totals.worstCaseMicro === null ? null : d.totals.worstCaseMicro <= capMicro;
}

/** "$0.004321" from µ$, or the unavailable reason. */
export function formatMicro(micro: number | null, unavailable = 'unavailable'): string {
  return micro === null ? unavailable : `$${(micro / 1_000_000).toFixed(6)}`;
}
