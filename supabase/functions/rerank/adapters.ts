// Fixed upstreams only. Request bodies come unchanged from the shared buildProviderRequest function.
import { z } from 'npm:zod@3.23.8';
import type { Usage } from './_vendor/src/core/contracts/rerank-response.ts';
export interface ProviderReply {
  model: string; usage: Usage | null; latencyMs: number;
  kind: 'text' | 'probabilities'; text?: string | null; answers?: unknown;
}
export class AdapterError extends Error {
  readonly sent: boolean; readonly httpStatus: number | null;
  constructor(code: string, sent: boolean, httpStatus: number | null = null) {
    super(code); this.name = 'AdapterError'; this.sent = sent; this.httpStatus = httpStatus;
  }
}
export interface ProviderAdapter {
  id: 'anthropic' | 'typesafe'; model: string;
  /** Secret readiness is checked after reusable done/cache results. Secret values never leave the adapter. */
  secretName: 'ANTHROPIC_API_KEY' | 'TYPESAFE_API_KEY'; ready: boolean;
  call(body: string, signal: AbortSignal): Promise<ProviderReply>;
}
const tokens = z.number().int().nonnegative();
const usageSchema = z.object({ input_tokens: tokens, output_tokens: tokens, cache_read_input_tokens: tokens.optional(), cache_creation_input_tokens: tokens.optional() });
function usageOf(raw: unknown, anthropic: boolean): Usage | null {
  const u = usageSchema.safeParse(raw);
  if (!u.success) return null;
  const cached = u.data.cache_read_input_tokens ?? 0;
  // Count all billed input categories conservatively, including cache creation/read tokens.
  return { inputTokens: u.data.input_tokens + (anthropic ? cached + (u.data.cache_creation_input_tokens ?? 0) : 0), outputTokens: u.data.output_tokens, cachedTokens: cached };
}
const envelope = z.object({ model:z.string(), usage:z.unknown().optional() }).passthrough();
export function parseProviderResponse(provider: 'anthropic' | 'typesafe', raw: unknown, latencyMs: number): ProviderReply {
  const parsed = envelope.safeParse(raw);
  // A malformed successful HTTP response may still have been billed: do not retry or release liability.
  if (!parsed.success) throw new AdapterError('provider_schema',true);
  const v = parsed.data;
  const usage = usageOf(v.usage,provider === 'anthropic');
  if (provider === 'anthropic') {
    const content = z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).safeParse(v.content);
    return { kind:'text',model:v.model,usage,latencyMs,text:content.success ? content.data.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') : null };
  }
  // Local 01-jev-integration-guide.md: answers[questionKey].noul. Full live schema remains UNVERIFIED.
  const answers = z.record(z.unknown()).safeParse(v.answers);
  const probabilities: Record<string,unknown> = {};
  if (answers.success) for (const [key,value] of Object.entries(answers.data)) {
    if (typeof value === 'object' && value !== null && 'noul' in value) probabilities[key] = value.noul;
  }
  return { kind:'probabilities',model:v.model,usage,latencyMs,answers:answers.success ? probabilities : null };
}
export function createAdapters(secrets: { anthropic: string | undefined; typesafe: string | undefined }, fetcher: typeof fetch = fetch): ProviderAdapter[] {
  const make = (id:'anthropic'|'typesafe', model:string, key:string|undefined): ProviderAdapter => ({
    id,model,secretName:id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'TYPESAFE_API_KEY',ready:!!key,
    async call(body,signal) {
      if (!key) throw new AdapterError('secret_missing',false);
      const started = Date.now();
      let response: Response;
      try {
        response = await fetcher(id === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.typesafe.ai/v1/systemone', {
          method:'POST',body,signal,redirect:'error',
          headers:id === 'anthropic' ? {'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'} : {'content-type':'application/json',authorization:`Bearer ${key}`},
        });
      } catch {
        // Fetch cannot prove whether bytes reached the upstream. No automatic connection-failure retry here.
        throw new AdapterError('transport_uncertain',true);
      }
      if (!response.ok) {
        // Only 429/529 are explicitly retryable, known rejected requests. Other HTTP errors hold liability conservatively.
        await response.body?.cancel();
        throw new AdapterError('provider_http',response.status !== 429 && response.status !== 529,response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AdapterError('provider_schema',true);
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 262144) { await reader.cancel(); throw new AdapterError('provider_response_too_large',true); }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AdapterError('provider_schema',true); }
      return parseProviderResponse(id,raw,Math.max(0,Date.now()-started));
    },
  });
  return [make('anthropic','claude-haiku-5-5',secrets.anthropic),make('typesafe','jev-1.13.0',secrets.typesafe)];
}
