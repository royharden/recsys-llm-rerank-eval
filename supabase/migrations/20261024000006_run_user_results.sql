create table public.run_user_results (
 run_id text not null, owner_id uuid not null default auth.uid(), arm text not null, variant text not null, repeat_index integer not null check(repeat_index in (0,1)),
 user_key text not null check(user_key ~ '^[0-9a-f]{16}$'), candidate_ids integer[] not null, ranked_ids integer[] not null,
 presented_ids integer[] not null default '{}', k_eff integer not null check(k_eff between 0 and 30), flags text[] not null,
 target_rank integer check(target_rank > 0), in_candidates boolean not null, target_popularity integer not null check(target_popularity >= 0), cold_target boolean not null,
 repairs jsonb not null, format_failure boolean not null, call_ids text[] not null default '{}', request_key text references public.llm_requests(request_key),
 primary key(run_id,arm,variant,repeat_index,user_key), foreign key(run_id,owner_id) references public.eval_runs(id,owner_id),
 check(cardinality(candidate_ids) = k_eff and cardinality(ranked_ids) <= 30 and (target_rank is null or target_rank <= cardinality(ranked_ids)))
);
alter table public.run_user_results enable row level security;
revoke all on public.run_user_results from public, anon, authenticated;
grant select, insert on public.run_user_results to authenticated;
create policy results_read on public.run_user_results for select to authenticated using(owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid()));
create policy results_insert on public.run_user_results for insert to authenticated with check(owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid() and r.state = 'running'));
create function public.check_result_integrity() returns trigger language plpgsql security definer set search_path = public as $$
declare r public.eval_runs; q public.llm_requests; frozen_k_eff integer;
begin
 select * into strict r from public.eval_runs where id = new.run_id and owner_id = new.owner_id for share;
 if r.state <> 'running' or r.owner_id <> auth.uid() then raise exception 'owner running run required'; end if;
 if not exists(select 1 from jsonb_array_elements(r.config->'expectedResults') x where x->>'runId' = new.run_id and x->>'arm' = new.arm and x->>'variant' = new.variant and (x->>'repeatIndex')::integer = new.repeat_index and x->>'userKey' = new.user_key) then raise exception 'result key not frozen'; end if;
 select (x->>'kEff')::integer into strict frozen_k_eff from jsonb_array_elements(r.config->'candidateCounts') x where x->>'userKey' = new.user_key;
 if cardinality(new.candidate_ids) <> (select count(distinct x) from unnest(new.candidate_ids) x) or cardinality(new.ranked_ids) <> (select count(distinct x) from unnest(new.ranked_ids) x) then raise exception 'duplicate result ids'; end if;
 if new.arm <> 'mostpop' and (cardinality(new.ranked_ids) <> new.k_eff or not (new.ranked_ids @> new.candidate_ids and new.ranked_ids <@ new.candidate_ids)) then raise exception 'reranker must return candidate permutation'; end if;
 if r.mode = 'live' and new.arm in ('llm-list','jev-point') then
   -- Identity lookup always runs, even for an inserted zero count or null/forged request key.
   -- The parent SHARE lock serializes with claim_request's parent UPDATE lock.
   select * into q from public.llm_requests where run_id = r.id and owner_id = r.owner_id and arm = new.arm and variant = new.variant and repeat_index = new.repeat_index and user_key = new.user_key;
   if found then
     if q.state <> 'done' or new.request_key is distinct from q.request_key or new.candidate_ids is distinct from q.candidate_ids or new.presented_ids is distinct from q.presented_ids or new.ranked_ids is distinct from q.final_order or new.repairs is distinct from q.repairs or new.format_failure is distinct from q.format_failure or to_jsonb(new.call_ids) is distinct from q.response->'callIds' then raise exception 'live result differs from function result'; end if;
   elsif frozen_k_eff <> 0 or new.request_key is not null or cardinality(new.candidate_ids) <> 0 or cardinality(new.ranked_ids) <> 0 or cardinality(new.presented_ids) <> 0 or cardinality(new.call_ids) <> 0
     or new.flags is distinct from array['short_list','no_candidates']::text[] or new.target_rank is not null or new.in_candidates or new.format_failure
     or new.repairs is distinct from '{"unknown":0,"repeat":0,"missing":0,"emptyRanking":0}'::jsonb then
     raise exception 'live no-call result requires frozen no-candidate user';
   end if;
 end if;
 if new.k_eff <> frozen_k_eff then raise exception 'result candidate count differs from frozen schedule'; end if;
 if exists(select 1 from unnest(new.call_ids) x where not exists(select 1 from public.llm_calls c where c.id = x and c.run_id = r.id and c.owner_id = r.owner_id and c.arm = new.arm and c.variant = new.variant and c.call_row->>'userKey' = new.user_key and (c.call_row->>'repeatIndex')::integer = new.repeat_index)) then raise exception 'result call provenance mismatch'; end if;
 return new;
end $$;
create trigger result_integrity before insert on public.run_user_results for each row execute function public.check_result_integrity();
revoke all on function public.check_result_integrity() from public, anon, authenticated;

create function public.complete_run(p_run_id text) returns void language plpgsql security definer set search_path = public as $$
declare r public.eval_runs;
begin
 select * into strict r from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if r.state = 'complete' then return; end if;
 if r.state <> 'running' then raise exception 'running run required'; end if;
 -- Two anti-joins verify identity equality, not just row counts or a caller-defined count.
 if exists(select 1 from jsonb_array_elements(r.config->'expectedResults') x where not exists(select 1 from public.run_user_results u where u.run_id = r.id and u.arm = x->>'arm' and u.variant = x->>'variant' and u.repeat_index = (x->>'repeatIndex')::integer and u.user_key = x->>'userKey'))
 or exists(select 1 from public.run_user_results u where u.run_id = r.id and not exists(select 1 from jsonb_array_elements(r.config->'expectedResults') x where x->>'runId' = u.run_id and x->>'arm' = u.arm and x->>'variant' = u.variant and (x->>'repeatIndex')::integer = u.repeat_index and x->>'userKey' = u.user_key)) then raise exception 'frozen result set incomplete or mismatched'; end if;
 if exists(select 1 from public.llm_requests where run_id = r.id and state in ('claimed','uncertain')) or exists(select 1 from public.budget_reservations where run_id = r.id and state in ('reserved','held_uncertain')) then raise exception 'unsettled requests remain'; end if;
 update public.eval_runs set state = 'complete', completed_at = clock_timestamp() where id = r.id;
end $$;

-- Persisted mock shares the ledger schema but can never write a live request/call.
create function public.append_mock_call(p_run_id text, p_call jsonb) returns void language plpgsql security definer set search_path = public as $$
declare r public.eval_runs; q public.llm_requests;
begin
 select * into strict r from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if r.mode <> 'mock' or r.state <> 'running' or p_call->>'runId' is distinct from r.id or p_call->>'provider' <> 'mock' or (p_call->>'costMicro')::bigint <> 0 then raise exception 'mock running owner call required'; end if;
 if not exists(select 1 from jsonb_array_elements(r.config->'expectedResults') x where x->>'arm' = p_call->>'arm' and x->>'variant' = p_call->>'variant' and x->>'repeatIndex' = p_call->>'repeatIndex' and x->>'userKey' = p_call->>'userKey') then raise exception 'unexpected mock call key'; end if;
 if exists(select 1 from public.llm_calls where id = p_call->>'id' and owner_id = r.owner_id and call_row = p_call) then return; end if;
 insert into public.llm_requests(request_key,run_id,owner_id,arm,variant,repeat_index,user_key,config_hash,mapping_hash,state,lease_until)
 values(p_call->>'requestKey',r.id,r.owner_id,p_call->>'arm',p_call->>'variant',(p_call->>'repeatIndex')::integer,p_call->>'userKey',r.config_hash,p_call->>'mappingHash','done',clock_timestamp()) on conflict(request_key) do nothing;
 select * into strict q from public.llm_requests where request_key = p_call->>'requestKey';
 if q.owner_id <> r.owner_id or q.run_id <> r.id then raise exception 'request conflict'; end if;
 perform public.insert_call(r.owner_id,p_call);
end $$;
revoke all on function public.complete_run(text), public.append_mock_call(text,jsonb) from public, anon, authenticated;
grant execute on function public.complete_run(text), public.append_mock_call(text,jsonb) to authenticated;
