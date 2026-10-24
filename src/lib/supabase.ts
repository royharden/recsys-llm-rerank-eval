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
function browserConfiguration() {
  try { return { config: publicSupabaseConfig(viteEnv), error: null }; }
  catch { return { config: null, error: 'Public database configuration is invalid. Check its URL and anon key, then reload.' }; }
}
const browser = browserConfiguration();
export const supabaseConfig = browser.config;
export const supabaseConfigError = browser.error;
// Importing the console/CLI never starts auth refresh or URL-session processing.
// The console activates this public client only after an explicit persisted-mode choice.
export let supabase: SupabaseClient | null = null;
export function activateBrowserSupabase(): SupabaseClient | null {
  supabase ??= createPublicSupabase(supabaseConfig);
  supabase?.auth.startAutoRefresh();
  return supabase;
}
