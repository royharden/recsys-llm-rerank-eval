import { describe,expect,it } from 'vitest';
import { readFile } from 'node:fs/promises';
describe('environment privacy text contracts',() => {
  it('public example defines only public Supabase configuration and no credential values',async () => {
    const example=await readFile(new URL('../../.env.example',import.meta.url),'utf8');
    const active=example.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
    expect(active).toEqual(['VITE_SUPABASE_URL=','VITE_SUPABASE_ANON_KEY=']);
    expect(example).not.toMatch(/VITE_(?:ANTHROPIC|TYPESAFE|SUPABASE_SERVICE_ROLE)/);
    const ignore=await readFile(new URL('../../.gitignore',import.meta.url),'utf8');
    expect(ignore).toContain('.env*'); expect(ignore).toContain('.recsys-session.json'); expect(ignore).toContain('config/manifest.lock.json');
  });
  it('edge reads only explicit server secret names and never logs a prompt/body',async () => {
    const edge=await readFile(new URL('../../supabase/functions/rerank/index.ts',import.meta.url),'utf8');
    expect([...edge.matchAll(/Deno\.env\.get\('([^']+)'\)/g)].map((m) => m[1]).sort()).toEqual(['ALLOWED_ORIGIN','ANTHROPIC_API_KEY','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_URL','TYPESAFE_API_KEY'].sort());
    expect(edge).not.toMatch(/console\.(?:log|debug|error)/); expect(edge).not.toContain('VITE_');
  });
});
