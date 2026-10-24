// Pure rank orchestration with injected durable repository, fixed provider adapters, clock and sleep.
// No raw provider text, prompts, ratings or clear MovieLens user ids cross the persistence boundary.
import { parsePayloadText, type RerankPayload } from './_vendor/src/core/contracts/rerank-payload.ts';
import { RerankResponseSchema, type RerankResponse, type Usage } from './_vendor/src/core/contracts/rerank-response.ts';
import { hardBound, costMicroOf, usageWithinBound, type HardBound } from './_vendor/src/core/contracts/bound.ts';
import { liveGate, PRICE_TABLE, type PriceTable } from './_vendor/src/core/contracts/prices.ts';
import { cacheKey } from './_vendor/src/core/contracts/keys.ts';
import { buildProviderRequest } from './_vendor/src/core/prompts/request.ts';
import { guardLlmList, validateJevAnswers } from './_vendor/src/core/rerankguard/validate.ts';
import { hashCanonical } from './_vendor/src/core/util/hash.ts';
import { FrozenConfigSchema, CandidateCountsSchema, candidateScheduleError, frozenModeError } from './_vendor/src/core/contracts/frozen-config.ts';
import { AdapterError, type ProviderAdapter, type ProviderReply } from './adapters.ts';
import type { CachedOutcome, CallRow, Repo, RunRecord } from './repo.ts';

export type PipelineResult = { status: number; body: RerankResponse | { error: string } };
export interface PipelineDeps {
  repo: Repo; ownerId: string; adapters: readonly ProviderAdapter[]; prices?: PriceTable;
  now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number;
}
const fail = (status: number, error: string): PipelineResult => ({ status,body:{error} });
function expected(run: RunRecord, p: RerankPayload): boolean {
  return Array.isArray(run.config.expectedResults) && run.config.expectedResults.some((x) => x.runId === p.runId && x.arm === p.arm && x.variant === p.variant && x.repeatIndex === p.repeatIndex && x.userKey === p.userKey);
}
function bindingError(run: RunRecord, p: RerankPayload): string | null {
  const config = run.config;
  const parsed = FrozenConfigSchema.safeParse(config.frozen);
  const counts = CandidateCountsSchema.safeParse(config.candidateCounts);
  if (!parsed.success || !counts.success || config.schemaVersion !== 1 || !Array.isArray(config.expectedResults) ||
    !Array.isArray(config.probeUserKeys) || !config.manifest) return 'config_mismatch';
  const frozen = parsed.data;
  if (frozenModeError(frozen, run.mode) || config.manifest.seed !== frozen.seed ||
    candidateScheduleError(counts.data, config.expectedResults.map((x) => x.userKey), frozen.K)) return 'config_mismatch';
  if (run.config_hash !== p.configHash || run.dataset_hash !== p.datasetHash || hashCanonical(frozen) !== p.configHash ||
      config.manifest.datasetHash !== p.datasetHash || config.manifest.manifestHash !== run.manifest_hash || !expected(run,p)) return 'config_mismatch';
  const version = frozen[p.arm === 'llm-list' ? 'llmListPromptVersion' : 'jevPromptVersion'];
  if (version !== p.promptVersion || (p.variant !== 'base' && !config.probeUserKeys.includes(p.userKey))) return 'config_mismatch';
  if (counts.data.find((c) => c.userKey === p.userKey)?.kEff !== p.candidates.length) return 'config_mismatch';
  if (run.split === 'heldout') {
    const prereg = config.prereg;
    const dated = run.prereg_dated_at === null ? NaN : Date.parse(run.prereg_dated_at);
    const started = run.started_at === null ? NaN : Date.parse(run.started_at);
    if (!prereg || !run.prereg_hash || hashCanonical(prereg) !== run.prereg_hash || !Number.isFinite(dated) || !Number.isFinite(started) || !(dated < started) ||
        Date.parse(String(prereg.datedAt)) !== dated || prereg.datasetHash !== p.datasetHash || prereg.manifestHash !== run.manifest_hash || prereg.configHash !== p.configHash || hashCanonical(prereg.config) !== p.configHash) return 'prereg_required';
  }
  return null;
}
async function timed(adapter: ProviderAdapter, body: string, timeoutMs: number): Promise<ProviderReply> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([adapter.call(body,controller.signal),new Promise<never>((_,reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AdapterError('timeout_uncertain',true)); },timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function finiteUsage(usage: Usage | null): usage is Usage {
  return usage !== null && [usage.inputTokens,usage.outputTokens,usage.cachedTokens].every((n) => Number.isSafeInteger(n) && n >= 0);
}
export async function rankPipeline(text: string, deps: PipelineDeps): Promise<PipelineResult> {
  const checked = parsePayloadText(text);
  if (!checked.ok) return fail(checked.status,checked.status === 413 ? 'payload_too_large' : 'invalid_payload');
  const p = checked.payload; const { repo } = deps;
  const now = deps.now ?? Date.now; const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve,ms)));
  const run = await repo.getRun(p.runId);
  if (!run || run.owner_id !== deps.ownerId || run.mode !== 'live' || run.state !== 'running' || !run.approval ||
      run.approval.config_hash !== run.config_hash || run.approval.cap_micro !== run.cap_micro || hashCanonical(run.approval.arm_caps) !== hashCanonical(run.arm_caps)) return fail(403,'approval_required');
  const mismatch = bindingError(run,p); if (mismatch) return fail(403,mismatch);
  const models = run.config.frozen.models as Record<string,{provider:string;model:string}> | undefined;
  const pin = models?.[p.arm];
  const adapter = deps.adapters.find((a) => a.id === pin?.provider && a.model === pin?.model &&
    ((p.arm === 'llm-list' && a.id === 'anthropic' && a.model === 'claude-haiku-5-5') || (p.arm === 'jev-point' && a.id === 'typesafe' && a.model === 'jev-1.13.0')));
  if (!adapter) return fail(403,'model_pin_mismatch');
  const claim = await repo.claim(p);
  if (claim.kind === 'done') return {status:200,body:RerankResponseSchema.parse(claim.response)};
  if (claim.kind !== 'claimed') return fail(409,claim.kind === 'uncertain' ? 'uncertain_needs_review' : claim.kind);
  const { leaseToken } = claim;
  const request = buildProviderRequest(p,adapter.model);
  const ck = cacheKey({provider:adapter.id,model:adapter.model,promptVersion:p.promptVersion,promptHash:request.promptHash,params:request.params,repeatIndex:p.repeatIndex,mappingHash:p.mappingHash});
  const table = deps.prices ?? PRICE_TABLE;
  const row = (n:number,status:CallRow['status'],bound:HardBound|null,usage:Usage|null,costMicro:number,latencyMs=0): CallRow => ({
    id:`${p.requestKey}-${n}`,requestKey:p.requestKey,runId:p.runId,attemptNo:n,arm:p.arm,variant:p.variant,repeatIndex:p.repeatIndex,userKey:p.userKey,
    provider:adapter.id,model:adapter.model,promptVersion:p.promptVersion,promptHash:request.promptHash,cacheKey:ck,mappingHash:p.mappingHash,
    inputTokens:usage?.inputTokens ?? null,outputTokens:usage?.outputTokens ?? null,cachedTokens:usage?.cachedTokens ?? null,reportedUsage:usage,
    priceTableDate:table.datedAt,boundMicro:bound?.boundMicro ?? 0,costMicro,latencyMs:Math.max(0,Math.round(latencyMs)),status,provenance:{kind:'provider'},createdAt:new Date(now()).toISOString(),
  });
  const respond = (out:Pick<CachedOutcome,'finalOrder'|'rawLabelOrder'|'probabilities'|'repairs'|'formatFailure'|'failureReason'>,call:CallRow,callIds:string[],cacheHit:boolean): RerankResponse => RerankResponseSchema.parse({
    schemaVersion:1,requestKey:p.requestKey,mappingHash:p.mappingHash,cacheKey:ck,arm:p.arm,variant:p.variant,repeatIndex:p.repeatIndex,
    provider:adapter.id,model:adapter.model,promptVersion:p.promptVersion,promptHash:request.promptHash,
    finalOrder:out.finalOrder,rawLabelOrder:out.rawLabelOrder,probabilities:out.probabilities,repairs:out.repairs,formatFailure:out.formatFailure,failureReason:out.failureReason,
    cacheHit,usage:call.reportedUsage,costMicro:call.costMicro,boundMicro:call.boundMicro,latencyMs:call.latencyMs,callIds,
  });
  const cached = await repo.cache(ck);
  if (cached && cached.mappingHash === p.mappingHash && cached.model === adapter.model && cached.provider === adapter.id && cached.promptHash === request.promptHash) {
    const call = row(claim.nextAttemptNo,'cache_hit',null,cached.usage,0);
    call.provenance = {kind:'cache',sourceCallId:cached.sourceCallId};
    const response = respond(cached,call,[...await repo.callIds(p.requestKey),call.id],true);
    return {status:200,body:await repo.complete(p.requestKey,leaseToken,call,response,null)};
  }
  if (!adapter.ready) {
    await repo.failure(p.requestKey,leaseToken,row(claim.nextAttemptNo,'provider_error',null,null,0));
    return fail(503,`secret_missing:${adapter.secretName}`);
  }
  const gate = liveGate(table,adapter.id,adapter.model);
  if (!gate.ok) {
    await repo.failure(p.requestKey,leaseToken,row(claim.nextAttemptNo,'provider_error',null,null,0));
    return fail(gate.code === 'price_missing' ? 500 : 503,gate.code);
  }
  // Exactly the same byte serialization and hardBound used by budget/estimate.ts.
  const bound = hardBound(request.body,request.maxOutputTokens,gate.price,request.units);
  for (let n = claim.nextAttemptNo; n <= 3; n++) {
    const context = row(n,'stale_uncertain',bound,null,bound.boundMicro);
    if (!await repo.reserve(p.requestKey,leaseToken,n,bound.boundMicro,context)) {
      await repo.failure(p.requestKey,leaseToken,row(n,'budget_refused',bound,null,0));
      return fail(402,'budget_refused');
    }
    const started = now(); let reply: ProviderReply;
    try { reply = await timed(adapter,request.body,deps.timeoutMs ?? 30000); }
    catch (error) {
      const e = error instanceof AdapterError ? error : null;
      const rejected = e?.httpStatus === 429 || e?.httpStatus === 529;
      const provenUnsent = e !== null && !e.sent;
      if (rejected || provenUnsent) {
        const retry = n < 3;
        await repo.release(p.requestKey,leaseToken,row(n,'provider_error',bound,null,0,now()-started),retry);
        if (retry) { await sleep(n === 1 ? 1000 : 4000); continue; }
        return fail(502,'provider_retries_exhausted');
      }
      await repo.uncertain(p.requestKey,leaseToken,row(n,'timeout_uncertain',bound,null,bound.boundMicro,now()-started));
      return fail(409,'uncertain_needs_review');
    }
    const usage = finiteUsage(reply.usage) ? reply.usage : null;
    if (!usage || !usageWithinBound(usage,bound)) {
      const liability = usage ? Math.max(bound.boundMicro,costMicroOf(usage,request.units,gate.price)) : bound.boundMicro;
      await repo.uncertain(p.requestKey,leaseToken,row(n,'bound_violation',bound,usage,liability,reply.latencyMs));
      return fail(409,'accounting_failure');
    }
    const cost = costMicroOf(usage,request.units,gate.price);
    // A changed model may have different pricing: hold at least the configured bound and stop the run.
    if (reply.model !== adapter.model || (p.arm === 'llm-list' ? reply.kind !== 'text' : reply.kind !== 'probabilities')) {
      await repo.uncertain(p.requestKey,leaseToken,row(n,'bound_violation',bound,usage,Math.max(cost,bound.boundMicro),reply.latencyMs));
      return fail(409,'accounting_failure');
    }
    let outcome: Pick<CachedOutcome,'finalOrder'|'rawLabelOrder'|'probabilities'|'repairs'|'formatFailure'|'failureReason'>;
    if (p.arm === 'llm-list') {
      const g = guardLlmList(reply.text,request.labels.candidates);
      outcome = {finalOrder:g.order,rawLabelOrder:g.rawLabels,probabilities:null,repairs:g.repairs,formatFailure:g.formatFailure,failureReason:g.failure};
    } else {
      const g = validateJevAnswers(reply.answers,request.labels.candidates);
      outcome = {finalOrder:g.order,rawLabelOrder:null,probabilities:g.probabilities,repairs:g.repairs,formatFailure:g.formatFailure,failureReason:g.failure};
    }
    const call = row(n,outcome.formatFailure ? 'format_failure' : 'ok',bound,usage,cost,reply.latencyMs);
    const response = respond(outcome,call,[...await repo.callIds(p.requestKey),call.id],false);
    const entry: CachedOutcome = {...outcome,cacheKey:ck,mappingHash:p.mappingHash,provider:adapter.id,model:adapter.model,promptHash:request.promptHash,usage,sourceCallId:call.id};
    return {status:200,body:await repo.complete(p.requestKey,leaseToken,call,response,entry)};
  }
  return fail(409,'exhausted');
}
