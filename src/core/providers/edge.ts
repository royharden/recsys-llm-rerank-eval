// The browser and CLI use the same JWT-authenticated function; no provider secrets or prompt construction here.
import type { SupabaseClient } from '@supabase/supabase-js';
import { mappingHash, requestKey } from '../contracts/keys.ts';
import { RerankPayloadSchema } from '../contracts/rerank-payload.ts';
import { RerankResponseSchema } from '../contracts/rerank-response.ts';
import type { ProviderId, RerankClient } from './types.ts';

export class EdgeRerankError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`rerank: ${code} (${status})`); this.name = 'EdgeRerankError'; this.status = status; this.code = code;
  }
}
export function createEdgeRerankClient(options: {
  client: SupabaseClient; url: string; anonKey: string; provider: Exclude<ProviderId, 'mock'>; model: string;
  fetch?: typeof fetch;
}): RerankClient {
  const endpoint = `${options.url.replace(/\/$/, '')}/functions/v1/rerank`;
  const transport = options.fetch ?? globalThis.fetch;
  return {
    mode: 'live', provider: options.provider, model: options.model,
    async rerank(input, signal) {
      const payload = RerankPayloadSchema.parse(input);
      if (payload.requestKey !== requestKey(payload) || payload.mappingHash !== mappingHash(payload))
        throw new Error('rerank payload key mismatch');
      if (signal?.aborted) throw new Error('cancelled');
      const { data, error } = await options.client.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error('Sign in again before continuing the persisted run.');
      // No retry here: a lost response may follow a paid request. The function owns leases and retries.
      const result = await transport(endpoint, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', apikey: options.anonKey,
          Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(payload) });
      if (!result.ok) {
        let code = 'function_error';
        try {
          const value = await result.json() as { error?: unknown; code?: unknown };
          const candidate = value.code ?? value.error;
          if (typeof candidate === 'string' && /^[a-zA-Z0-9_:.-]{1,100}$/.test(candidate)) code = candidate;
        } catch { /* Do not echo arbitrary server text, prompts or credentials. */ }
        throw new EdgeRerankError(result.status, code);
      }
      const response = RerankResponseSchema.parse(await result.json());
      for (const key of ['requestKey', 'mappingHash', 'arm', 'variant', 'repeatIndex', 'promptVersion'] as const)
        if (response[key] !== payload[key]) throw new Error(`rerank response ${key} mismatch`);
      if (response.provider !== options.provider || response.model !== options.model) throw new Error('rerank response model pin mismatch');
      const ids = payload.candidates.map((c) => c.itemId);
      if (response.finalOrder.length !== ids.length || new Set(response.finalOrder).size !== ids.length ||
        response.finalOrder.some((id) => !ids.includes(id))) throw new Error('rerank response is not a candidate permutation');
      return response;
    },
  };
}
