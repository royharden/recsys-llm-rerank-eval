import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { buildRerankPayload } from '../../src/core/arms/model-arm.ts';
import { createEdgeRerankClient } from '../../src/core/providers/edge.ts';
import { RerankResponseSchema } from '../../src/core/contracts/rerank-response.ts';
import { modelContext, MODEL_CFG } from '../helpers/model.ts';

const payload = buildRerankPayload(modelContext(), 'llm-list', 'base', MODEL_CFG);
function response() {
  return RerankResponseSchema.parse({ schemaVersion: 1, requestKey: payload.requestKey, mappingHash: payload.mappingHash,
    cacheKey: 'c'.repeat(64), arm: payload.arm, variant: payload.variant, repeatIndex: payload.repeatIndex,
    provider: 'anthropic', model: 'frozen-pin', promptVersion: payload.promptVersion, promptHash: 'd'.repeat(64),
    finalOrder: payload.candidates.map((c) => c.itemId), rawLabelOrder: null, probabilities: null,
    repairs: { unknown: 0, repeat: 0, missing: 0, emptyRanking: 0 }, formatFailure: false, failureReason: null,
    cacheHit: false, usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 }, costMicro: 1,
    boundMicro: 100, latencyMs: 1, callIds: ['call-1'] });
}
function setup(fetcher: typeof fetch, signedIn = true) {
  const client = { auth: { getSession: vi.fn(async () => ({ data: { session: signedIn ? { access_token: 'user-jwt' } : null }, error: null })) } } as unknown as SupabaseClient;
  return createEdgeRerankClient({ client, url: 'https://project.example', anonKey: 'public-anon',
    provider: 'anthropic', model: 'frozen-pin', fetch: fetcher });
}
describe('JWT edge client', () => {
  it('forwards the exact target-free payload to the one function with user JWT, without constructing provider prompts', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response()), { status: 200 }));
    const client = setup(transport);
    await client.rerank(payload);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://project.example/functions/v1/rerank');
    expect(init?.body).toBe(JSON.stringify(payload));
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer user-jwt', apikey: 'public-anon' });
    expect(init?.body).not.toMatch(/target|api_key|system|messages/);
  });
  it('does not retry a 409/402/503 or ambiguous network error', async () => {
    for (const status of [409, 402, 503]) {
      const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'uncertain_needs_review' }), { status }));
      await expect(setup(transport).rerank(payload)).rejects.toMatchObject({ status, code: 'uncertain_needs_review' });
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('connection lost'); });
    await expect(setup(transport).rerank(payload)).rejects.toThrow('connection lost');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects expired session, target-bearing payloads, bad keys/pins/order before accepting results', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...response(), model: 'alias' }), { status: 200 }));
    await expect(setup(transport, false).rerank(payload)).rejects.toThrow(/Sign in/);
    expect(transport).not.toHaveBeenCalled();
    await expect(setup(transport).rerank({ ...payload, target: 123 } as typeof payload)).rejects.toThrow();
    await expect(setup(transport).rerank({ ...payload, mappingHash: '0'.repeat(64) })).rejects.toThrow(/key mismatch/);
    expect(transport).not.toHaveBeenCalled();
    await expect(setup(transport).rerank(payload)).rejects.toThrow(/pin mismatch/);
  });
});
