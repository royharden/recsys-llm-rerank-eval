import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPublicSupabase, publicSupabaseConfig } from '../../src/lib/supabase.ts';
import { cliPublicConfig } from '../../src/core/node/session.ts';

describe('explicit setup and credential boundaries', () => {
  it('returns a nullable public client until both public browser values exist', () => {
    expect(publicSupabaseConfig({})).toBeNull();
    expect(publicSupabaseConfig({ VITE_SUPABASE_URL: 'https://example.com' })).toBeNull();
    expect(createPublicSupabase(null)).toBeNull();
    expect(publicSupabaseConfig({ VITE_SUPABASE_URL: 'https://example.com/', VITE_SUPABASE_ANON_KEY: 'public' }))
      .toEqual({ url: 'https://example.com', anonKey: 'public' });
    expect(() => cliPublicConfig({})).toThrow(/SUPABASE_URL/);
  });
  it('stores only session tokens, restricts access before writes, and never echoes a password', () => {
    const source = readFileSync(new URL('../../src/core/node/session.ts', import.meta.url), 'utf8');
    expect(source).toContain('access_token: session.access_token, refresh_token: session.refresh_token');
    expect(source.indexOf('await handle.chmod(0o600)')).toBeLessThan(source.indexOf('await handle.writeFile'));
    expect(source.indexOf('await restrictWindowsFile(absolute)')).toBeLessThan(source.indexOf('await handle.writeFile'));
    expect(source).toContain('SetAccessRuleProtection($true, $false)');
    expect(source).toContain('input.setRawMode(true)');
    expect(source).not.toMatch(/stdout\.write\((?:password|character)|console\.(?:log|error)\((?:password|tokens|session)/);
    const cli = readFileSync(new URL('../../scripts/eval.ts', import.meta.url), 'utf8');
    expect(cli).not.toMatch(/approveRun|run_approvals|SERVICE_ROLE|ANTHROPIC_API_KEY|TYPESAFE_API_KEY/);
    expect(cli).toContain('if (args.runId) { await persistedMain(args); return; }');
    expect(readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')).toContain('.recsys-session.json');
  });
});
