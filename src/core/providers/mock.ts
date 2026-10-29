// Mock provider + local mock rank client (PLAN §4 mock provider [CX]; the guard runs locally on the mock path).
//
// The mock adapter sees exactly what a live provider would: the validated RerankPayload and the serialized request.
// Its "skill" signal is computed from HISTORY-ONLY features carried in the payload — genre affinity of each candidate to
// the history profile, affinity to the last 5 history items, and a franchise cue (title stem shared with one of the last
// three history titles). It never sees a target: payloads have no target field and this module cannot import the split
// or the Scorer. Item ids are used only to seed per-item noise (so noise does not depend on presentation order).
//
//   score(c) = skill·affinity(c) + noise·(u_c − ½) + repeatJitter·(v_c,repeat − ½) + positionBias·(1 − pos/(n−1))
//
// positionBias applies to llm-list only (Jev questions are independent). Presets: `unbiased` (positionBias 0) and
// `planted-bias` (0.8, the synthetic `planted-position-bias` trap). formatErrorRate (seeded) and per-user forced modes
// (the synthetic `format-chaos` trap) emit malformed outputs. Usage is reported with the shared chars/4 estimator,
// output tokens never exceed the cap sent, and the price table charges the mock 0 µ$.
import { completePrice, PRICE_TABLE, priceFor, type PriceTable } from '../contracts/prices.ts';
import { costMicroOf, estimateTokens, hardBound, usageWithinBound } from '../contracts/bound.ts';
import { cacheKey } from '../contracts/keys.ts';
import { validatePayload, type PromptVersion, type RerankPayload } from '../contracts/rerank-payload.ts';
import { RerankResponseSchema, type RerankResponse, type Usage } from '../contracts/rerank-response.ts';
import { GENRES } from '../contracts/types.ts';
import { FORMAT_CHAOS_MODES, type FormatChaosMode } from '../data/synthetic.ts';
import type { CallRow, CallStatus, Ledger, ResponseCache } from '../ledger/types.ts';
import { labelMap, sanitizeTitle } from '../prompts/labels.ts';
import { buildProviderRequest } from '../prompts/request.ts';
import { guardLlmList, validateJevAnswers, type GuardRepairs } from '../rerankguard/validate.ts';
import { randInt, rngFor } from '../stats/prng.ts';
import { truncHex } from '../util/hash.ts';
import { ProviderError, type ProviderAdapter, type ProviderCall, type ProviderReply, type RerankClient } from './types.ts';

export const MOCK_MODEL = 'mock-1';
export const MOCK_PRESETS_LIST = ['unbiased', 'planted-bias'] as const;
export type MockPreset = (typeof MOCK_PRESETS_LIST)[number];

export interface MockParams {
  seed: number;
  /** Weight of the history-only affinity signal. */
  skill: number;
  /** Per (user, item) noise amplitude, identical across presentation variants. */
  noise: number;
  /** Extra per (user, item, repeatIndex) noise: makes the repeat probe imperfect. */
  repeatJitter: number;
  /** llm-list only: bonus for being shown early. */
  positionBias: number;
  /** Probability (seeded per request) of emitting a random format-chaos output. */
  formatErrorRate: number;
  /** userKey → forced chaos mode for every call of that user (synthetic format-chaos trap). */
  forcedModes?: ReadonlyMap<string, FormatChaosMode>;
  /** Test hook: attempts 1..n of every request fail with a retryable, provably-unsent 529. */
  failFirstAttempts?: number;
  latencyBaseMs: number;
  latencySpreadMs: number;
}

export const MOCK_PRESETS: Readonly<Record<MockPreset, Omit<MockParams, 'seed'>>> = {
  unbiased: { skill: 1, noise: 0.5, repeatJitter: 0.05, positionBias: 0, formatErrorRate: 0.02, latencyBaseMs: 40, latencySpreadMs: 80 },
  'planted-bias': { skill: 1, noise: 0.5, repeatJitter: 0.05, positionBias: 0.8, formatErrorRate: 0.02, latencyBaseMs: 40, latencySpreadMs: 80 },
};

export function mockParams(preset: MockPreset, seed: number, overrides: Partial<Omit<MockParams, 'seed'>> = {}): MockParams {
  return { ...MOCK_PRESETS[preset], ...overrides, seed };
}

// ---------------------------------------------------------------- history-only affinity

interface AffinityWeights {
  genre: number;
  recent: number;
  franchise: number;
}

/** v2 is recency-focused, so the mock weights recent history more when it sees that prompt version. */
const WEIGHTS: Readonly<Record<PromptVersion, AffinityWeights>> = {
  'llm-list.v1': { genre: 0.45, recent: 0.25, franchise: 0.3 },
  'llm-list.v2': { genre: 0.25, recent: 0.4, franchise: 0.35 },
  'jev-point.v1': { genre: 0.4, recent: 0.3, franchise: 0.3 },
};

const RECENT = 5;
const FRANCHISE_WINDOW = 3;
const ARTICLES = new Set(['the', 'a', 'an']);
const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|\d+|part)$/;

function genreVector(genres: readonly string[]): Float64Array {
  const v = new Float64Array(GENRES.length);
  for (const g of genres) {
    const i = (GENRES as readonly string[]).indexOf(g);
    if (i >= 0) v[i] = 1;
  }
  return v;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/** First two significant words of a title, ignoring a leading article, a "(1995)" year and sequel numbering. */
export function titleStem(title: string): string {
  const words = sanitizeTitle(title)
    .toLowerCase()
    .replace(/\(\d{4}\)/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
  while (words.length > 0 && ARTICLES.has(words[0])) words.shift();
  while (words.length > 1 && ROMAN.test(words[words.length - 1])) words.pop();
  return words.slice(0, 2).join(' ');
}

/** Affinity in [0, 1] of every payload candidate (payload order), from the payload's history only. */
export function historyAffinity(p: RerankPayload): number[] {
  const w = WEIGHTS[p.promptVersion];
  const profile = new Float64Array(GENRES.length);
  for (const h of p.history) genreVector(h.genres).forEach((x, i) => (profile[i] += x));
  const recentProfile = new Float64Array(GENRES.length);
  for (const h of p.history.slice(-RECENT)) genreVector(h.genres).forEach((x, i) => (recentProfile[i] += x));
  const lastTitles = p.history.slice(-FRANCHISE_WINDOW).map((h) => ({ stem: titleStem(h.title), title: sanitizeTitle(h.title) }));
  return p.candidates.map((c) => {
    const v = genreVector(c.genres);
    const stem = titleStem(c.title);
    const title = sanitizeTitle(c.title);
    const franchise = stem !== '' && lastTitles.some((h) => h.stem === stem && h.title !== title) ? 1 : 0;
    return w.genre * cosine(v, profile) + w.recent * cosine(v, recentProfile) + w.franchise * franchise;
  });
}

/** Mock scores (payload order) and the resulting label order. */
export function mockScores(params: MockParams, p: RerankPayload): number[] {
  const aff = historyAffinity(p);
  const n = p.candidates.length;
  return p.candidates.map((c, pos) => {
    const u = rngFor(params.seed, 'mock-noise', p.arm, p.userKey, c.itemId)();
    const v = rngFor(params.seed, 'mock-jitter', p.arm, p.userKey, c.itemId, p.repeatIndex)();
    const bias = p.arm === 'llm-list' && n > 1 ? params.positionBias * (1 - pos / (n - 1)) : 0;
    return params.skill * aff[pos] + params.noise * (u - 0.5) + params.repeatJitter * (v - 0.5) + bias;
  });
}

// ---------------------------------------------------------------- format chaos

export function chaosModeFor(params: MockParams, p: RerankPayload): FormatChaosMode | null {
  const forced = params.forcedModes?.get(p.userKey);
  if (forced) return forced;
  if (!(params.formatErrorRate > 0)) return null;
  const rng = rngFor(params.seed, 'mock-chaos', p.arm, p.userKey, p.variant, p.repeatIndex);
  if (rng() >= params.formatErrorRate) return null;
  return FORMAT_CHAOS_MODES[randInt(rng, FORMAT_CHAOS_MODES.length)];
}

/** The llm-list reply text for a label order under a chaos mode (null = no reply). */
export function chaosText(mode: FormatChaosMode | null, labels: readonly string[]): string | null {
  const n = labels.length;
  const json = (ranking: unknown): string => JSON.stringify({ ranking });
  switch (mode) {
    case null:
      return json(labels);
    case 'prose-wrapped':
      return `Sure! Here is the ranking you asked for:\n${json(labels)}\nLet me know if you need anything else.`;
    case 'code-fenced':
      return `\`\`\`json\n${json(labels)}\n\`\`\``;
    case 'unknown-label': {
      const out = labels.slice();
      out.splice(Math.min(1, n), 0, `C${n + 1}`); // one invented label
      return json(out);
    }
    case 'repeated-label':
      return json(n > 0 ? [...labels, labels[0]] : []); // one repeat
    case 'missing-labels':
      return json(labels.slice(0, n - Math.min(3, Math.max(0, n - 1)))); // drops min(3, n−1) labels
    case 'empty-ranking':
      return json([]);
    case 'not-json':
      return `My ranking would be ${labels.slice(0, 3).join(', ')} and so on.`;
    case 'wrong-type':
      return json(labels.join(','));
    case 'no-reply':
      return null;
  }
}

/** Jev answers under a chaos mode. Structured APIs cannot be "prose-wrapped", so those modes leave answers valid. */
export function chaosAnswers(mode: FormatChaosMode | null, answers: Record<string, number>): unknown {
  const keys = Object.keys(answers);
  const first = keys[0];
  switch (mode) {
    case 'missing-labels': {
      const out: Record<string, number> = { ...answers };
      delete out[keys[keys.length - 1]];
      return out;
    }
    case 'empty-ranking':
      return {};
    case 'not-json':
      return first === undefined ? {} : { ...answers, [first]: Number.NaN };
    case 'wrong-type':
      return first === undefined ? {} : { ...answers, [first]: String(answers[first]) };
    case 'no-reply':
      return null;
    case 'unknown-label':
      return { ...answers, c_999: 0.5 };
    default:
      return answers;
  }
}

// ---------------------------------------------------------------- adapter

export function createMockProvider(params: MockParams): ProviderAdapter {
  return {
    id: 'mock',
    model: MOCK_MODEL,
    call(req: ProviderCall): Promise<ProviderReply> {
      if (params.failFirstAttempts !== undefined && req.attemptNo <= params.failFirstAttempts) {
        return Promise.reject(new ProviderError('mock: simulated 529 overloaded', { retryable: true, sent: false, httpStatus: 529 }));
      }
      const p = req.payload;
      const lm = labelMap(p);
      const scores = mockScores(params, p);
      const mode = chaosModeFor(params, p);
      const latencyMs = params.latencyBaseMs + Math.floor(rngFor(params.seed, 'mock-latency', p.requestKey, req.attemptNo)() * params.latencySpreadMs);
      const inputTokens = estimateTokens(req.body);
      if (req.kind === 'llm-list') {
        const labels = lm.candidates
          .map((c, i) => ({ label: c.label, s: scores[i], pos: c.pos }))
          .sort((a, b) => b.s - a.s || a.pos - b.pos)
          .map((x) => x.label);
        const text = chaosText(mode, labels);
        const usage: Usage = { inputTokens, outputTokens: Math.min(estimateTokens(text ?? ''), req.maxOutputTokens), cachedTokens: 0 };
        return Promise.resolve({ kind: 'text', text, model: MOCK_MODEL, usage, latencyMs });
      }
      const answers: Record<string, number> = {};
      lm.candidates.forEach((c, i) => {
        const prob = 1 / (1 + Math.exp(-6 * (scores[i] - 0.5)));
        answers[c.jevKey] = Math.round(Math.min(1, Math.max(0, prob)) * 1e6) / 1e6;
      });
      return Promise.resolve({
        kind: 'probabilities',
        answers: chaosAnswers(mode, answers),
        model: MOCK_MODEL,
        usage: { inputTokens, outputTokens: 0, cachedTokens: 0 },
        latencyMs,
      });
    },
  };
}

// ---------------------------------------------------------------- local mock rank client

/** Missing usage or usage above the bound: the run must stop making calls (PLAN §7 step 8). */
export class AccountingFailure extends Error {
  readonly callId: string;
  constructor(message: string, callId: string) {
    super(message);
    this.name = 'AccountingFailure';
    this.callId = callId;
  }
}

export interface MockClientOptions {
  adapter: ProviderAdapter;
  ledger: Ledger;
  cache: ResponseCache;
  prices?: PriceTable;
  /** ≤ 3 attempts; only retryable, provably-unsent failures are retried (no backoff sleeps on the mock path). */
  maxAttempts?: number;
  now?: () => string;
}

export function callIdOf(requestKey: string, attemptNo: number): string {
  return `${truncHex(requestKey, 16)}-${attemptNo}`;
}

interface Outcome {
  finalOrder: number[];
  rawLabelOrder: string[] | null;
  probabilities: Record<string, number> | null;
  repairs: GuardRepairs;
  formatFailure: boolean;
  failureReason: RerankResponse['failureReason'];
}

/**
 * The mock path end to end: validate payload + keys → build request → cacheKey → cache hit (0 µ$ row) or attempts
 * (one ledger row each) → bound check on reported usage → guard → cache put → RerankResponse. Refuses non-mock
 * adapters: live calls go through the `rerank` function, never through this local pipeline.
 */
export function createMockRerankClient(opts: MockClientOptions): RerankClient {
  const { adapter, ledger, cache } = opts;
  if (adapter.id !== 'mock') throw new Error('createMockRerankClient: only the mock provider runs locally; live calls go through the rerank function');
  const prices = opts.prices ?? PRICE_TABLE;
  const maxAttempts = Math.min(3, Math.max(1, opts.maxAttempts ?? 3));
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    mode: 'mock',
    provider: adapter.id,
    model: adapter.model,
    async rerank(input, signal) {
      const v = validatePayload(input);
      if (!v.ok) throw new Error(`mock rerank: ${v.status} ${v.error}`);
      const payload = v.payload;
      const req = buildProviderRequest(payload, adapter.model);
      const ck = cacheKey({
        provider: adapter.id,
        model: adapter.model,
        promptVersion: payload.promptVersion,
        promptHash: req.promptHash,
        params: req.params,
        repeatIndex: payload.repeatIndex,
        mappingHash: payload.mappingHash,
      });
      const rowBase = {
        requestKey: payload.requestKey,
        runId: payload.runId,
        arm: payload.arm,
        variant: payload.variant,
        repeatIndex: payload.repeatIndex,
        userKey: payload.userKey,
        provider: adapter.id,
        model: adapter.model,
        promptVersion: payload.promptVersion,
        promptHash: req.promptHash,
        cacheKey: ck,
        mappingHash: payload.mappingHash,
      };
      const respond = (o: Outcome, extra: { cacheHit: boolean; usage: Usage | null; costMicro: number; boundMicro: number; latencyMs: number; callIds: string[] }): RerankResponse =>
        RerankResponseSchema.parse({
          schemaVersion: 1,
          requestKey: payload.requestKey,
          mappingHash: payload.mappingHash,
          cacheKey: ck,
          arm: payload.arm,
          variant: payload.variant,
          repeatIndex: payload.repeatIndex,
          provider: adapter.id,
          model: adapter.model,
          promptVersion: payload.promptVersion,
          promptHash: req.promptHash,
          ...o,
          ...extra,
        });

      const hit = await cache.get(ck);
      if (hit) {
        const attemptNo = ledger.nextAttemptNo(payload.requestKey);
        const row = ledger.append({
          ...rowBase,
          id: callIdOf(payload.requestKey, attemptNo),
          attemptNo,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          reportedUsage: null,
          priceTableDate: null,
          boundMicro: 0,
          costMicro: 0,
          latencyMs: 0,
          status: 'cache_hit',
          provenance: { kind: 'cache', sourceCallId: hit.sourceCallId },
          createdAt: now(),
        });
        return respond(
          { finalOrder: hit.finalOrder, rawLabelOrder: hit.rawLabelOrder, probabilities: hit.probabilities, repairs: hit.repairs, formatFailure: hit.formatFailure, failureReason: hit.failureReason },
          { cacheHit: true, usage: null, costMicro: 0, boundMicro: 0, latencyMs: 0, callIds: [row.id] },
        );
      }

      const pc = completePrice(prices, priceFor(prices, adapter.id, adapter.model));
      if (!pc.ok) throw new Error(`price_missing: ${pc.detail}`);
      const bound = hardBound(req.body, req.maxOutputTokens, pc.price, req.units);
      const callIds: string[] = [];
      const record = (
        attemptNo: number,
        status: CallStatus,
        f: { usage: Usage | null; costMicro: number; latencyMs: number },
      ): CallRow =>
        ledger.append({
          ...rowBase,
          id: callIdOf(payload.requestKey, attemptNo),
          attemptNo,
          inputTokens: f.usage?.inputTokens ?? null,
          outputTokens: f.usage?.outputTokens ?? null,
          cachedTokens: f.usage?.cachedTokens ?? null,
          reportedUsage: f.usage,
          priceTableDate: pc.price.priceTableDate,
          boundMicro: bound.boundMicro,
          costMicro: f.costMicro,
          latencyMs: f.latencyMs,
          status,
          provenance: { kind: 'provider' },
          createdAt: now(),
        });

      for (let i = 0; i < maxAttempts; i++) {
        const attemptNo = ledger.nextAttemptNo(payload.requestKey);
        const call: ProviderCall =
          payload.arm === 'llm-list'
            ? { kind: 'llm-list', payload, body: req.body, attemptNo, maxOutputTokens: req.maxOutputTokens }
            : { kind: 'jev-point', payload, body: req.body, attemptNo, maxOutputTokens: 0 };
        let reply: ProviderReply;
        try {
          reply = await adapter.call(call, signal);
        } catch (err) {
          const pe = err instanceof ProviderError ? err : null;
          const sent = pe ? pe.sent : true; // unknown failure: assume it may have been sent (uncertain, never retried)
          callIds.push(record(attemptNo, sent ? 'timeout_uncertain' : 'provider_error', { usage: null, costMicro: 0, latencyMs: 0 }).id);
          if (pe && pe.retryable && !pe.sent && i + 1 < maxAttempts) continue;
          throw err;
        }
        const latencyMs = Math.max(0, Math.round(reply.latencyMs));
        if (reply.model !== adapter.model) {
          callIds.push(record(attemptNo, 'provider_error', { usage: reply.usage, costMicro: 0, latencyMs }).id);
          throw new Error(`mock rerank: returned model ${reply.model} differs from the pin ${adapter.model}`);
        }
        const usage = reply.usage;
        if (!usage || !usageWithinBound(usage, bound)) {
          const liability = usage ? Math.max(costMicroOf(usage, req.units, pc.price), bound.boundMicro) : bound.boundMicro;
          const row = record(attemptNo, 'bound_violation', { usage, costMicro: liability, latencyMs });
          throw new AccountingFailure(usage ? 'reported usage exceeds the hard bound' : 'provider reported no usage', row.id);
        }
        let o: Outcome;
        if (reply.kind === 'text' && payload.arm === 'llm-list') {
          const g = guardLlmList(reply.text, req.labels.candidates);
          o = { finalOrder: g.order, rawLabelOrder: g.rawLabels, probabilities: null, repairs: g.repairs, formatFailure: g.formatFailure, failureReason: g.failure };
        } else if (reply.kind === 'probabilities' && payload.arm === 'jev-point') {
          const g = validateJevAnswers(reply.answers, req.labels.candidates);
          o = { finalOrder: g.order, rawLabelOrder: null, probabilities: g.probabilities, repairs: g.repairs, formatFailure: g.formatFailure, failureReason: g.failure };
        } else {
          callIds.push(record(attemptNo, 'provider_error', { usage, costMicro: costMicroOf(usage, req.units, pc.price), latencyMs }).id);
          throw new Error(`mock rerank: reply kind ${reply.kind} does not match arm ${payload.arm}`);
        }
        const costMicro = costMicroOf(usage, req.units, pc.price);
        const row = record(attemptNo, o.formatFailure ? 'format_failure' : 'ok', { usage, costMicro, latencyMs });
        callIds.push(row.id);
        await cache.put({
          cacheKey: ck,
          mappingHash: payload.mappingHash,
          provider: adapter.id,
          model: adapter.model,
          promptHash: req.promptHash,
          finalOrder: o.finalOrder,
          rawLabelOrder: o.rawLabelOrder,
          probabilities: o.probabilities,
          repairs: o.repairs,
          formatFailure: o.formatFailure,
          failureReason: o.failureReason,
          usage,
          sourceCallId: row.id,
        });
        return respond(o, { cacheHit: false, usage, costMicro, boundMicro: bound.boundMicro, latencyMs, callIds });
      }
      throw new Error('mock rerank: attempts exhausted');
    },
  };
}
