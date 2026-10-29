create table public.response_cache (
  owner_id uuid not null references auth.users(id), cache_key text not null, mapping_hash text not null,
  final_order integer[] not null, raw_label_order jsonb, probabilities jsonb, usage jsonb,
  source_call_id text not null references public.llm_calls(id), entry jsonb not null,
  primary key(owner_id,cache_key)
);
alter table public.response_cache enable row level security;
revoke all on public.response_cache from public, anon, authenticated;
grant select on public.response_cache to authenticated;
create policy cache_read on public.response_cache for select to authenticated using(owner_id = auth.uid() and exists(select 1 from public.llm_calls c join public.eval_runs r on r.id = c.run_id where c.id = source_call_id and c.owner_id = auth.uid() and r.owner_id = auth.uid()));
-- Only complete_attempt may insert cache entries. They never contain prompt/response text.

grant select on public.response_cache to service_role;
