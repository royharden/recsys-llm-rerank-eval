import type { Session, SupabaseClient } from '@supabase/supabase-js';

function requireClient(client: SupabaseClient | null): SupabaseClient {
  if (!client) throw new Error('Configure the public database URL and anon key, or choose local mock.');
  return client;
}
export async function currentSession(client: SupabaseClient | null): Promise<Session | null> {
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}
export async function requireUser(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('Sign in to access a persisted run.');
  return data.user.id;
}
export async function signIn(client: SupabaseClient | null, email: string, password: string): Promise<Session> {
  const { data, error } = await requireClient(client).auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('Sign-in did not create a session.');
  return data.session;
}
export async function signUp(client: SupabaseClient | null, email: string, password: string): Promise<Session | null> {
  const { data, error } = await requireClient(client).auth.signUp({ email, password });
  if (error) throw error;
  return data.session;
}
export async function signOut(client: SupabaseClient | null): Promise<void> {
  if (!client) return;
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw error;
}
export async function requestPasswordReset(client: SupabaseClient | null, email: string): Promise<void> {
  const { error } = await requireClient(client).auth.resetPasswordForEmail(email);
  if (error) throw error;
}
/** Auth events include refresh/expiry/sign-out; returns cleanup for the console. */
export function observeSession(client: SupabaseClient | null, changed: (session: Session | null) => void): () => void {
  if (!client) { changed(null); return () => undefined; }
  const { data } = client.auth.onAuthStateChange((_event, session) => changed(session));
  return () => data.subscription.unsubscribe();
}
