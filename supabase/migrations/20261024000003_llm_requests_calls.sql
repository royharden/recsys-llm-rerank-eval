create table public.llm_requests (
  request_key text primary key check (request_key ~ '^[0-9a-f]{64}$'), run_id text not null, owner_id uuid not null,
  arm text not null check (arm in ('llm-list','jev-point')), variant text not null,
  repeat_index integer not null check (repeat_index in (0,1)), user_key text not null check(user_key ~ '^[0-9a-f]{16}$'),
  config_hash text not null, mapping_hash text not null,
  state text not null check (state in ('claimed','done','failed','uncertain')),
  lease_token uuid not null default gen_random_uuid(), lease_until timestamptz not null, sent_at timestamptz, attempt_context jsonb,
  candidate_ids integer[], presented_ids integer[], final_order integer[], repairs jsonb, format_failure boolean, response jsonb,
  unique(run_id,arm,variant,repeat_index,user_key), foreign key(run_id,owner_id) references public.eval_runs(id,owner_id)
);
create table public.llm_calls (
  id text primary key, request_key text not null references public.llm_requests(request_key), run_id text not null, owner_id uuid not null,
  attempt_no integer not null check (attempt_no between 1 and 3), arm text not null, variant text not null,
  provider text not null, model text not null, prompt_version text not null, prompt_hash text not null,
  input_tokens bigint, output_tokens bigint, cached_tokens bigint, reported_usage jsonb, price_table_date date,
  bound_micro bigint not null check(bound_micro >= 0), cost_micro bigint not null check(cost_micro >= 0),
  latency_ms bigint not null check(latency_ms >= 0), status text not null check(status in ('ok','format_failure','provider_error','timeout_uncertain','stale_uncertain','bound_violation','cache_hit','budget_refused')),
  call_row jsonb not null, created_at timestamptz not null default now(),
  unique(request_key,attempt_no), foreign key(run_id,owner_id) references public.eval_runs(id,owner_id),
  check (status <> 'cache_hit' or (cost_micro = 0 and call_row#>>'{provenance,kind}' = 'cache'))
);
alter table public.llm_requests enable row level security;
alter table public.llm_calls enable row level security;
revoke all on public.llm_requests, public.llm_calls from public, anon, authenticated;
grant select on public.llm_requests, public.llm_calls to authenticated;
create policy requests_read on public.llm_requests for select to authenticated using(owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid()));
create policy calls_read on public.llm_calls for select to authenticated using(owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid()));
-- No UPDATE/DELETE policies or grants. Calls are append-only, even after finalization.

grant select on public.llm_calls, public.llm_requests to service_role;
