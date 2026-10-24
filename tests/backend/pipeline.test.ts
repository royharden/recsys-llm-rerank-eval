// Fake repository and adapters only. These sources were not executed under Dirty Mode.
import { describe,expect,it,vi } from 'vitest';
import { rankPipeline } from '../../supabase/functions/rerank/pipeline.ts';
import { AdapterError,type ProviderAdapter,type ProviderReply } from '../../supabase/functions/rerank/adapters.ts';
import type { CachedOutcome,CallRow,Claim,Repo,RunRecord } from '../../supabase/functions/rerank/repo.ts';
import { buildRerankPayload } from '../../src/core/arms/model-arm.ts';
import { buildProviderRequest } from '../../src/core/prompts/request.ts';
import { hardBound } from '../../src/core/contracts/bound.ts';
import { cacheKey } from '../../src/core/contracts/keys.ts';
import { hashCanonical } from '../../src/core/util/hash.ts';
import { PRICE_TABLE,type PriceTable } from '../../src/core/contracts/prices.ts';
import { MODEL_CFG,modelContext } from '../helpers/model.ts';

function fixture() {
  const frozen = {schemaVersion:1,seed:38,knnK:20,K:20,tunedWeights:{knn:1,recency:0,genre:0},
    llmListPromptVersion:'llm-list.v1',jevPromptVersion:'jev-point.v1',primaryArm:'llm-list',bootstrapResamples:10000,
    practicalMarginNdcg:0.01,probeSampleSeed:38,probeSampleMax:150,mock:null,
    models:{'llm-list':{provider:'anthropic',model:'claude-haiku-5-5'},'jev-point':{provider:'typesafe',model:'jev-1.13.0'}}};
  const p = buildRerankPayload(modelContext(),'llm-list','base',{...MODEL_CFG,configHash:hashCanonical(frozen)});
  const caps = {'llm-list':4000000,'jev-point':1000000,probe:2000000};
  const run:RunRecord = {id:p.runId,owner_id:'owner',mode:'live',split:'dev',state:'running',config_hash:p.configHash,dataset_hash:p.datasetHash,manifest_hash:'c'.repeat(64),prereg_hash:null,prereg_dated_at:null,started_at:'2026-10-24T10:00:00.000Z',cap_micro:5000000,arm_caps:caps,
    approval:{config_hash:p.configHash,cap_micro:5000000,arm_caps:caps},config:{schemaVersion:1,manifest:{seed:38,datasetHash:p.datasetHash,manifestHash:'c'.repeat(64)},frozen,expectedResults:[{runId:p.runId,arm:p.arm,variant:p.variant,repeatIndex:p.repeatIndex,userKey:p.userKey}],candidateCounts:[{userKey:p.userKey,kEff:p.candidates.length}],probeUserKeys:[],prereg:null}};
  const calls:CallRow[] = []; const reservations:number[] = [];
  let claim:Claim = {kind:'claimed',leaseToken:'lease',nextAttemptNo:1}; let cached:CachedOutcome|null = null; let reserveAllowed = true;
  const complete = vi.fn<Repo['complete']>(async (_key,_lease,call,response) => { calls.push(call); return response; });
  const repo:Repo = {
    getRun:vi.fn(async () => run),claim:vi.fn(async () => claim),cache:vi.fn(async () => cached),callIds:vi.fn(async () => calls.map((c) => c.id)),
    reserve:vi.fn(async (_key,_lease,_n,bound) => { reservations.push(bound); return reserveAllowed; }),complete,
    release:vi.fn(async (_key,_lease,call) => { calls.push(call); }),uncertain:vi.fn(async (_key,_lease,call) => { calls.push(call); }),failure:vi.fn(async (_key,_lease,call) => { calls.push(call); }),
  };
  const answer:ProviderReply = {kind:'text',text:JSON.stringify({ranking:p.candidates.map((_,i) => `C${i+1}`)}),model:'claude-haiku-5-5',usage:{inputTokens:100,outputTokens:40,cachedTokens:0},latencyMs:2};
  const adapter:ProviderAdapter = {id:'anthropic',model:'claude-haiku-5-5',secretName:'ANTHROPIC_API_KEY',ready:true,call:vi.fn(async () => answer)};
  const prices:PriceTable = {...PRICE_TABLE,entries:PRICE_TABLE.entries.map((e) => ({...e,inputUsdPerMTok:1,outputUsdPerMTok:1,perCallUsd:0,perUnitUsd:0,boundVerified:true,priceVerified:true}))};
  const sleep = vi.fn(async (ms:number) => {void ms;});
  const deps = {repo,ownerId:'owner',adapters:[adapter],prices,sleep,now:() => Date.parse('2026-10-24T10:00:01.000Z')};
  return {p,run,repo,calls,reservations,adapter,answer,prices,sleep,deps,setClaim:(c:Claim) => {claim=c;},setCache:(c:CachedOutcome) => {cached=c;},refuse:() => {reserveAllowed=false;}};
}
describe('live rank pipeline (injected sources, no network/DB)',() => {
  it.each(['K10','missingSeed','missingWeights','offGridWeights','badPrompt','badPin','liveMock','manifestSeed'] as const)(
    'rejects an otherwise hash-matched %s frozen config before claim/reserve/provider', async (kind) => {
      // Regression: partial config binding previously admitted a direct-owner approved K=10 experiment.
      const f=fixture(); const config=f.run.config.frozen;
      if(kind==='K10') config.K=10;
      if(kind==='missingSeed') delete config.seed;
      if(kind==='missingWeights') delete config.tunedWeights;
      if(kind==='offGridWeights') config.tunedWeights={knn:0.1,recency:0.9,genre:0};
      if(kind==='badPrompt') config.jevPromptVersion='jev-point.v2';
      if(kind==='badPin') config.models={'llm-list':{provider:'mock',model:'mock-1'},'jev-point':{provider:'typesafe',model:'jev-1.13.0'}};
      if(kind==='liveMock') config.mock={preset:'unbiased',seed:38,forcedModesHash:'a'.repeat(64)};
      if(kind==='manifestSeed') f.run.config.manifest.seed=39;
      // Matching hashes remove hash mismatch as an incidental reason for rejection.
      f.run.config_hash=hashCanonical(config); f.run.approval!.config_hash=f.run.config_hash;
      const p=buildRerankPayload(modelContext(1,kind==='K10'?10:20),'llm-list','base',{...MODEL_CFG,configHash:f.run.config_hash});
      f.run.config.candidateCounts[0].kEff=p.candidates.length;
      expect(await rankPipeline(JSON.stringify(p),f.deps)).toMatchObject({status:403,body:{error:'config_mismatch'}});
      expect(f.repo.claim).not.toHaveBeenCalled(); expect(f.repo.reserve).not.toHaveBeenCalled(); expect(f.adapter.call).not.toHaveBeenCalled();
    });
  it.each([0,19,21])('rejects payload count inconsistent with approved kEff=%s without calling', async (kEff) => {
    const f=fixture(); f.run.config.candidateCounts[0].kEff=kEff;
    expect(await rankPipeline(JSON.stringify(f.p),f.deps)).toMatchObject({status:403,body:{error:'config_mismatch'}});
    expect(f.repo.claim).not.toHaveBeenCalled(); expect(f.adapter.call).not.toHaveBeenCalled();
  });
  it('rejects oversized/target/key/config/unapproved requests before any paid call',async () => {
    const f = fixture();
    expect((await rankPipeline(' '.repeat(32769),f.deps)).status).toBe(413);
    expect((await rankPipeline(JSON.stringify({...f.p,target:1}),f.deps)).status).toBe(422);
    expect((await rankPipeline(JSON.stringify({...f.p,mappingHash:'0'.repeat(64)}),f.deps)).status).toBe(422);
    f.run.approval = null;
    expect(await rankPipeline(JSON.stringify(f.p),f.deps)).toMatchObject({status:403,body:{error:'approval_required'}});
    expect(f.adapter.call).not.toHaveBeenCalled();
  });
  it.each(['in_flight','uncertain','stale_uncertain','exhausted'] as const)('never retries a durable %s claim',async (kind) => {
    const f = fixture(); f.setClaim({kind});
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(409);
    expect(f.adapter.call).not.toHaveBeenCalled(); expect(f.repo.reserve).not.toHaveBeenCalled();
  });
  it('reserves the shared exact-byte hard bound, repairs once, and commits response/call/cache atomically',async () => {
    const f = fixture(); f.answer.text = '{"ranking":["C2","C2","invented"]}';
    const result = await rankPipeline(JSON.stringify(f.p),f.deps);
    const req = buildProviderRequest(f.p,f.adapter.model);
    const e = f.prices.entries[0];
    const bound = hardBound(req.body,req.maxOutputTokens,{...e,inputUsdPerMTok:1,outputUsdPerMTok:1,perCallUsd:0,perUnitUsd:0,priceTableDate:f.prices.datedAt},req.units);
    expect(f.reservations).toEqual([bound.boundMicro]);
    expect(result).toMatchObject({status:200,body:{repairs:{unknown:1,repeat:1,missing:19}}});
    expect(f.repo.complete).toHaveBeenCalledTimes(1);
    expect(f.adapter.call).toHaveBeenCalledWith(req.body,expect.any(AbortSignal));
    expect(JSON.stringify(f.calls)).not.toContain('Candidate');
  });
  it('returns a durable done response without restarting or reserving',async () => {
    const f=fixture(); const first=await rankPipeline(JSON.stringify(f.p),f.deps);
    if ('error' in first.body) throw new Error('fixture should succeed');
    const again=fixture(); again.setClaim({kind:'done',response:first.body});
    expect(await rankPipeline(JSON.stringify(again.p),again.deps)).toEqual(first);
    expect(again.repo.reserve).not.toHaveBeenCalled(); expect(again.adapter.call).not.toHaveBeenCalled();
  });
  it('validates typed Jev probabilities through the same settlement path and falls back as a whole',async () => {
    const f=fixture();
    const p=buildRerankPayload(modelContext(),'jev-point','base',{...MODEL_CFG,configHash:f.p.configHash,promptVersion:'jev-point.v1'});
    f.run.config.expectedResults=[{runId:p.runId,arm:p.arm,variant:p.variant,repeatIndex:p.repeatIndex,userKey:p.userKey}];
    f.adapter.id='typesafe'; f.adapter.model='jev-1.13.0'; f.adapter.secretName='TYPESAFE_API_KEY';
    f.adapter.call=vi.fn(async () => ({kind:'probabilities' as const,answers:{c_1:0.8},model:f.adapter.model,usage:{inputTokens:100,outputTokens:0,cachedTokens:0},latencyMs:1}));
    const result=await rankPipeline(JSON.stringify(p),f.deps);
    expect(result).toMatchObject({status:200,body:{formatFailure:true,failureReason:'missing_answer',finalOrder:p.candidates.map((c) => c.itemId)}});
    expect(f.calls[0].status).toBe('format_failure'); expect(f.repo.complete).toHaveBeenCalledTimes(1);
  });
  it('cache completion is zero cost with durable source provenance and no reservation',async () => {
    const f = fixture(); const req=buildProviderRequest(f.p,f.adapter.model);
    const ck=cacheKey({provider:f.adapter.id,model:f.adapter.model,promptVersion:f.p.promptVersion,promptHash:req.promptHash,params:req.params,repeatIndex:0,mappingHash:f.p.mappingHash});
    f.setCache({cacheKey:ck,mappingHash:f.p.mappingHash,provider:f.adapter.id,model:f.adapter.model,promptHash:req.promptHash,finalOrder:f.p.candidates.map((c) => c.itemId),rawLabelOrder:null,probabilities:null,repairs:{unknown:0,repeat:0,missing:0,emptyRanking:0},formatFailure:false,failureReason:null,usage:f.answer.usage,sourceCallId:'source'});
    expect(await rankPipeline(JSON.stringify(f.p),f.deps)).toMatchObject({status:200,body:{cacheHit:true,costMicro:0,boundMicro:0}});
    expect(f.calls[0].provenance).toEqual({kind:'cache',sourceCallId:'source'}); expect(f.repo.reserve).not.toHaveBeenCalled();
  });
  it('closed price/secret gates and refused caps never call the provider',async () => {
    const f=fixture(); f.adapter.ready=false;
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(503);
    f.adapter.ready=true;
    expect(await rankPipeline(JSON.stringify(f.p),{...f.deps,prices:PRICE_TABLE})).toMatchObject({status:500,body:{error:'price_missing'}});
    const unverified={...f.prices,entries:f.prices.entries.map((e) => ({...e,boundVerified:false}))};
    expect(await rankPipeline(JSON.stringify(f.p),{...f.deps,prices:unverified})).toMatchObject({status:503,body:{error:'bound_unverified'}});
    f.refuse(); expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(402); expect(f.adapter.call).not.toHaveBeenCalled();
  });
  it('429/529 and proven pre-send errors only retry, with every attempt and 1s/4s backoff',async () => {
    const f=fixture(); let n=0;
    f.adapter.call=vi.fn(async () => { n++; if(n<3) throw new AdapterError('rejected',false,n===1?429:529); return f.answer; });
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(200);
    expect(f.sleep.mock.calls.map((c) => c[0])).toEqual([1000,4000]);
    expect(f.calls.map((c) => c.attemptNo)).toEqual([1,2,3]); expect(f.reservations).toHaveLength(3);
    const unsent=fixture(); unsent.adapter.call=vi.fn(async () => {throw new AdapterError('not sent',false);});
    expect((await rankPipeline(JSON.stringify(unsent.p),unsent.deps)).status).toBe(502); expect(unsent.calls).toHaveLength(3);
  });
  it('post-send ambiguity and timeout hold the full bound, with no retry',async () => {
    const f=fixture(); f.adapter.call=vi.fn(async () => {throw new AdapterError('sent',true);});
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(409);
    expect(f.calls[0]).toMatchObject({status:'timeout_uncertain',costMicro:f.reservations[0]}); expect(f.adapter.call).toHaveBeenCalledTimes(1);
    const slow=fixture(); slow.adapter.call=vi.fn(() => new Promise<ProviderReply>(() => {}));
    expect((await rankPipeline(JSON.stringify(slow.p),{...slow.deps,timeoutMs:1})).status).toBe(409); expect(slow.calls).toHaveLength(1);
  });
  it.each(['missing','overbound','model'] as const)('stops on %s accounting violation without a success/cache write',async (kind) => {
    const f=fixture();
    if(kind==='missing') f.answer.usage=null;
    if(kind==='overbound') f.answer.usage={inputTokens:99999999,outputTokens:0,cachedTokens:0};
    if(kind==='model') f.answer.model='moving-alias';
    expect(await rankPipeline(JSON.stringify(f.p),f.deps)).toMatchObject({status:409,body:{error:'accounting_failure'}});
    expect(f.calls[0].status).toBe('bound_violation'); expect(f.calls[0].costMicro).toBeGreaterThanOrEqual(f.reservations[0]); expect(f.repo.complete).not.toHaveBeenCalled();
  });
  it('rejects held-out dates at/after start and off-schedule probes without tuning',async () => {
    const f=fixture(); f.run.split='heldout'; f.run.prereg_dated_at=f.run.started_at;
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(403);
    f.run.split='dev'; f.run.config.expectedResults=[];
    expect((await rankPipeline(JSON.stringify(f.p),f.deps)).status).toBe(403); expect(f.repo.claim).not.toHaveBeenCalled();
  });
});
