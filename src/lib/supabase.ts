import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface PublicSupabaseConfig { url: string; anonKey: string }
export function publicSupabaseConfig(env: Record<string, string | undefined>): PublicSupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim();
  const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('invalid public database URL');
  return { url: parsed.href.replace(/\/$/, ''), anonKey };
}
export function createPublicSupabase(config: PublicSupabaseConfig | null,
  options: { persistSession?: boolean; autoRefreshToken?: boolean } = {}): SupabaseClient | null {
  return config ? createClient(config.url, config.anonKey, { auth: {
    persistSession: options.persistSession ?? true, autoRefreshToken: options.autoRefreshToken ?? true,
    detectSessionInUrl: options.persistSession ?? true,
  } }) : null;
}
// Node's import.meta has no env. Missing browser configuration is an explicit local-mock/setup state.
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
export const supabaseConfig = publicSupabaseConfig(viteEnv);
export const supabase = createPublicSupabase(supabaseConfig);
