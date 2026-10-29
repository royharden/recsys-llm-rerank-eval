import { describe,expect,it,vi } from 'vitest';
import { createAdapters,parseProviderResponse,AdapterError } from '../../supabase/functions/rerank/adapters.ts';
import { serializeJevRequest,renderJev } from '../../src/core/prompts/jev-point.ts';
import { buildRerankPayload } from '../../src/core/arms/model-arm.ts';
import { modelContext,MODEL_CFG } from '../helpers/model.ts';
describe('provider protocol boundaries (all fake responses)',() => {
  it('uses the local guide questions envelope and typed Noul extraction, never nouls array',() => {
    const p = buildRerankPayload(modelContext(),'jev-point','base',{...MODEL_CFG,promptVersion:'jev-point.v1'});
    const request = JSON.parse(serializeJevRequest('jev-1.13.0',renderJev(p)));
    expect(request.nouls).toBeUndefined();
    expect(request.questions.c_1).toMatchObject({type:'noul'});
    expect(request.questions.c_1.instructions).toContain('likely watch next');
    expect(parseProviderResponse('typesafe',{model:'jev-1.13.0',answers:{c_1:{noul:0.75}},usage:{input_tokens:42,output_tokens:0}},1)).toMatchObject({answers:{c_1:0.75},usage:{inputTokens:42,outputTokens:0,cachedTokens:0}});
  });
  it('leaves malformed/missing usage null for accounting failure and bounds body handling',() => {
    expect(parseProviderResponse('anthropic',{model:'pin',content:[]},1).usage).toBeNull();
    expect(parseProviderResponse('typesafe',{model:'pin',answers:{},usage:{input_tokens:-1,output_tokens:0}},1).usage).toBeNull();
    expect(() => parseProviderResponse('typesafe',{},0)).toThrow(AdapterError);
  });
  it('passes shared bytes unchanged and retries neither ambiguous fetch nor other HTTP statuses internally',async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL,init?: RequestInit) => {void url; void init; return new Response('',{status:429});});
    const adapter = createAdapters({anthropic:'fake',typesafe:undefined},fetcher as typeof fetch)[0];
    await expect(adapter.call('exact bytes',new AbortController().signal)).rejects.toMatchObject({httpStatus:429,sent:false});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.body).toBe('exact bytes');
    const ambiguous = createAdapters({anthropic:'fake',typesafe:undefined},vi.fn(async () => { throw new TypeError('network'); }) as typeof fetch)[0];
    await expect(ambiguous.call('{}',new AbortController().signal)).rejects.toMatchObject({sent:true});
  });
});
