// Source guards only. These tests cannot establish SQL executability, RLS isolation or atomicity.
// Execute the two-account/concurrency scenarios in docs/DEFERRED-VALIDATION.md after provisioning.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const directory = new URL('../../supabase/migrations/', import.meta.url);
const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
const sources = names.map((name) => readFileSync(new URL(name, directory), 'utf8'));
const sql = sources.join('\n').toLowerCase();
const compact = (text: string): string => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();

function functionSource(name: string): string {
  const match = sql.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?end \\$\\$;`));
  if (!match) throw new Error(`missing SQL function ${name}`);
  return compact(match[0]);
}

function policySource(name: string): string {
  const match = sql.match(new RegExp(`create policy ${name}\\b[^;]*;`));
  if (!match) throw new Error(`missing SQL policy ${name}`);
  return compact(match[0]);
}

describe('migration source boundary guards (not executed SQL evidence)', () => {
  it('keeps the six dependency-ordered migration resources', () => {
    expect(names).toEqual([
      '20261024000001_eval_runs.sql', '20261024000002_run_approvals.sql',
      '20261024000003_llm_requests_calls.sql', '20261024000004_response_cache.sql',
      '20261024000005_budget.sql', '20261024000006_run_user_results.sql',
    ]);
  });

  it.each(['eval_runs', 'run_approvals', 'llm_requests', 'llm_calls', 'response_cache',
    'budget_reservations', 'run_user_results'])('enables RLS on %s', (table) => {
    expect(sql).toMatch(new RegExp(`alter table public\\.${table}\\s+enable row level security`));
  });

  it('retains the held-out claim after incomplete or aborted execution and resalting', () => {
    const index = sql.match(/create unique index heldout_live_once\b[^;]*;/)?.[0];
    expect(index).toBeDefined();
    expect(compact(index!)).toMatch(/on public\.eval_runs\s*\(owner_id,\s*dataset_hash\)/);
    expect(index).toMatch(/where\s+split\s*=\s*'heldout'\s+and\s+mode\s*=\s*'live'/);
    expect(index).not.toMatch(/\bstate\b|manifest_hash/);
  });

  it('leaves finalized owner results readable while restricting inserts to a running parent', () => {
    const read = policySource('results_read');
    expect(read).toContain('for select to authenticated');
    expect(read).toContain('owner_id = auth.uid()');
    expect(read).not.toMatch(/\bstate\b/);
    const insert = policySource('results_insert');
    expect(insert).toContain('for insert to authenticated');
    expect(insert).toContain("r.state = 'running'");
    expect(insert).toContain('r.owner_id = auth.uid()');
  });

  it.each(['claim_request', 'reserve_and_mark_sent', 'complete_attempt', 'release_attempt',
    'hold_uncertain', 'record_failure'])('restricts paid mutation RPC %s to the service role', (name) => {
    const definition = functionSource(name);
    expect(definition).toContain('security definer set search_path = public');
    // A forgotten default PUBLIC EXECUTE grant would expose a privileged paid-call mutation.
    const revoke = sql.split(';').find((statement) => /revoke all on function/.test(statement)
      && statement.includes(`public.${name}(`));
    const grant = sql.split(';').find((statement) => /grant execute on function/.test(statement)
      && statement.includes(`public.${name}(`));
    expect(revoke).toMatch(/from public,\s*anon,\s*authenticated/);
    expect(grant).toMatch(/to service_role/);
    expect(grant).not.toMatch(/to authenticated|to anon|to public/);
  });

  it('reserves and marks sent under the parent lock in one RPC source', () => {
    const reserve = functionSource('reserve_and_mark_sent');
    expect(reserve).toContain('for update of r0');
    expect(reserve).toContain('insert into public.budget_reservations');
    expect(reserve).toContain('set sent_at = clock_timestamp()');
    expect(reserve).toContain('arm_total + p_bound_micro');
    expect(reserve).toContain('probe_total + p_bound_micro');
  });

  it('finalizes from frozen identities and refuses unsettled requests/reservations', () => {
    const complete = functionSource('complete_run');
    expect(complete).toContain("r.config->'expectedresults'");
    expect(complete).toContain('u.repeat_index');
    expect(complete).toContain('u.user_key');
    expect(complete).toContain("state in ('claimed','uncertain')");
    expect(complete).toContain("state in ('reserved','held_uncertain')");
  });

  it('validates the complete supported config at the direct owner approval boundary', () => {
    const approval = functionSource('approve_run_insert');
    expect(approval).toContain("validate_frozen_config(r.config->'frozen',r.mode,r.config->'manifest')");
    const frozen = functionSource('validate_frozen_config');
    for (const field of ['seed', 'knnk', 'tunedweights', 'llmlistpromptversion', 'jevpromptversion', 'primaryarm',
      'bootstrapresamples', 'practicalmarginndcg', 'probesampleseed', 'probesamplemax', 'models', 'mock']) expect(frozen).toContain(`'${field}'`);
    expect(frozen).toContain("p_frozen->'k' not in ('20'::jsonb,'30'::jsonb)");
    expect(frozen).toContain('weights'); expect(frozen).toContain('manifest and config seeds differ');
    expect(frozen).toContain('live provider/model pins mismatch'); expect(frozen).toContain('mock behavior/pins required');
    expect(functionSource('validate_run_schedule')).toContain('frozen candidate counts must cover every user');
  });

  it('always reconciles live identity and only permits approved zero-candidate no-call results', () => {
    const integrity = functionSource('check_result_integrity');
    expect(integrity).not.toMatch(/and new\.k_eff > 0/);
    expect(integrity).toContain("r.config->'candidatecounts'");
    expect(integrity).toContain('select * into q from public.llm_requests where run_id = r.id');
    expect(integrity).toContain('repeat_index = new.repeat_index and user_key = new.user_key');
    expect(integrity).toContain("q.state <> 'done' or new.request_key is distinct from q.request_key");
    expect(integrity).toContain('elsif frozen_k_eff <> 0 or new.request_key is not null');
    expect(integrity).toContain('live no-call result requires frozen no-candidate user');
    expect(functionSource('claim_request')).toContain('frozen candidate count mismatch');
  });
});
