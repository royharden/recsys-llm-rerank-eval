import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { createAdapters } from './adapters.ts';
import { rankPipeline } from './pipeline.ts';
import { createRepo } from './repo.ts';
import { PAYLOAD_LIMITS } from './_vendor/src/core/contracts/rerank-payload.ts';

// The fallback '*' is preflight-only. POST requires an explicitly configured console origin.
Deno.serve(async (request: Request): Promise<Response> => {
  const allowed = Deno.env.get('ALLOWED_ORIGIN'); const origin = request.headers.get('origin');
  const cors = {'access-control-allow-origin':allowed ?? '*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'authorization, apikey, content-type, x-client-info',vary:'Origin'};
  const json = (status:number,body:unknown) => new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  if (request.method !== 'POST') return json(405,{error:'method_not_allowed'});
  if (origin && (!allowed || origin !== allowed)) return json(403,{error:'origin_not_allowed'});
  const url = Deno.env.get('SUPABASE_URL'); const anon = Deno.env.get('SUPABASE_ANON_KEY'); const role = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anon || !role) return json(503,{error:'database_not_configured'});
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.slice(7) === anon || authorization.slice(7) === role) return json(401,{error:'user_jwt_required'});
  const userClient = createClient(url,anon,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const auth = await userClient.auth.getUser(authorization.slice(7));
  if (auth.error || !auth.data.user || auth.data.user.is_anonymous) return json(401,{error:'user_jwt_required'});
  const service = createClient(url,role,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    // Stream the input with an actual byte cap; Content-Length alone is not trusted.
    const reader = request.body?.getReader(); if (!reader) return json(422,{error:'invalid_payload'});
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > PAYLOAD_LIMITS.maxBytes) { await reader.cancel(); return json(413,{error:'payload_too_large'}); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    const adapters = createAdapters({anthropic:Deno.env.get('ANTHROPIC_API_KEY'),typesafe:Deno.env.get('TYPESAFE_API_KEY')});
    const result = await rankPipeline(new TextDecoder().decode(bytes),{ownerId:auth.data.user.id,repo:createRepo(userClient,service,auth.data.user.id),adapters});
    return json(result.status,result.body);
  } catch {
    // A server crash after reserve+sent leaves durable full liability; lease expiry is handled by claim_request.
    return json(500,{error:'rerank_failed'});
  }
});
