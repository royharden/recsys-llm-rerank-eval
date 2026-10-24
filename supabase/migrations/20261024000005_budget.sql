create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(), run_id text not null, owner_id uuid not null,
  request_key text not null references public.llm_requests(request_key), attempt_no integer not null check(attempt_no between 1 and 3),
  arm text not null, variant text not null, amount_micro bigint not null check(amount_micro >= 0), actual_micro bigint check(actual_micro >= 0),
  state text not null check(state in ('reserved','settled','released','held_uncertain')),
  unique(request_key,attempt_no), foreign key(run_id,owner_id) references public.eval_runs(id,owner_id)
);
alter table public.budget_reservations enable row level security;
revoke all on public.budget_reservations from public, anon, authenticated;
-- No client policies: reservation data is exposed only via the owner-checked request/call views.

create function public.start_run(p_run_id text, p_config_hash text) returns public.eval_runs language plpgsql security definer set search_path = public as $$
declare r public.eval_runs; a public.run_approvals;
begin
 select * into strict r from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if r.state <> 'approved' or r.config_hash <> p_config_hash then raise exception 'approved matching run required'; end if;
 select * into strict a from public.run_approvals where run_id = r.id and owner_id = r.owner_id;
 if a.config_hash <> r.config_hash or a.cap_micro <> r.cap_micro or a.arm_caps <> r.arm_caps then raise exception 'approval mismatch'; end if;
 if r.mode = 'live' and r.split = 'heldout' and not (r.prereg_dated_at < clock_timestamp()) then raise exception 'prereg must precede start'; end if;
 update public.eval_runs set state = 'running', started_at = clock_timestamp(), state_reason = null where id = r.id returning * into r;
 return r;
end $$;
create function public.mark_incomplete(p_run_id text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r public.eval_runs;
begin
 select * into strict r from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if r.state = 'incomplete' then return; end if;
 if r.state <> 'running' then raise exception 'running run required'; end if;
 -- Never persist arbitrary exception text: it might contain provider input or credentials.
 update public.eval_runs set state = 'incomplete', state_reason = case when p_reason in ('cancelled','accounting_failure','budget_refused') then p_reason else 'interrupted' end where id = r.id;
end $$;
create function public.resume_run(p_run_id text, p_config_hash text) returns public.eval_runs language plpgsql security definer set search_path = public as $$
declare r public.eval_runs;
begin
 select * into strict r from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if r.state <> 'incomplete' or r.config_hash <> p_config_hash then raise exception 'incomplete matching run required'; end if;
 if r.state_reason = 'accounting_failure' then raise exception 'accounting failure blocks live resume'; end if;
 if exists(select 1 from public.llm_requests where run_id = r.id and (state = 'uncertain' or (state = 'claimed' and sent_at is not null))) then raise exception 'uncertain_needs_review'; end if;
 update public.eval_runs set state = 'running', state_reason = null where id = r.id returning * into r;
 return r;
end $$;

-- All F mutations verify the owner supplied by the authenticated handler, then lock the parent first.
create function public.claim_request(p_owner_id uuid, p_payload jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.eval_runs; q public.llm_requests; n integer;
begin
 select * into strict r from public.eval_runs where id = p_payload->>'runId' and owner_id = p_owner_id for update;
 if r.mode <> 'live' or r.state <> 'running' or r.config_hash is distinct from p_payload->>'configHash' or r.dataset_hash is distinct from p_payload->>'datasetHash' then raise exception 'approval_required'; end if;
 if not exists(select 1 from public.run_approvals where run_id = r.id and owner_id = r.owner_id and config_hash = r.config_hash and cap_micro = r.cap_micro and arm_caps = r.arm_caps) then raise exception 'approval_required'; end if;
 if not exists(select 1 from jsonb_array_elements(r.config->'expectedResults') x where x->>'runId' = r.id and x->>'arm' = p_payload->>'arm' and x->>'variant' = p_payload->>'variant' and x->>'repeatIndex' = p_payload->>'repeatIndex' and x->>'userKey' = p_payload->>'userKey') then raise exception 'unexpected_result_key'; end if;
 if not exists(select 1 from jsonb_array_elements(r.config->'candidateCounts') x where x->>'userKey' = p_payload->>'userKey' and (x->>'kEff')::integer > 0 and (x->>'kEff')::integer = jsonb_array_length(p_payload->'candidates')) then raise exception 'frozen candidate count mismatch'; end if;
 select * into q from public.llm_requests where request_key = p_payload->>'requestKey' for update;
 if found then
   if q.owner_id <> p_owner_id or q.run_id <> r.id or q.mapping_hash is distinct from p_payload->>'mappingHash' or q.config_hash <> r.config_hash then raise exception 'request conflict'; end if;
   if q.state = 'done' then return jsonb_build_object('kind','done','response',q.response); end if;
   if q.state = 'uncertain' then return jsonb_build_object('kind','uncertain'); end if;
   if q.state = 'claimed' and q.lease_until > clock_timestamp() then return jsonb_build_object('kind','in_flight'); end if;
   if q.sent_at is not null then
     update public.budget_reservations set state = 'held_uncertain' where request_key = q.request_key and state = 'reserved';
     if q.attempt_context is not null and not exists(select 1 from public.llm_calls where request_key = q.request_key and attempt_no = (q.attempt_context->>'attemptNo')::integer) then
       perform public.insert_call(p_owner_id, q.attempt_context || jsonb_build_object('status','stale_uncertain'));
     end if;
     update public.llm_requests set state = 'uncertain' where request_key = q.request_key;
     update public.eval_runs set state = 'incomplete', state_reason = 'uncertain' where id = r.id;
     return jsonb_build_object('kind','stale_uncertain');
   end if;
   update public.budget_reservations set state = 'released', actual_micro = 0 where request_key = q.request_key and state = 'reserved';
   update public.llm_requests set state = 'claimed', lease_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '120 seconds', sent_at = null where request_key = q.request_key returning * into q;
 else
   insert into public.llm_requests(request_key,run_id,owner_id,arm,variant,repeat_index,user_key,config_hash,mapping_hash,state,lease_until,candidate_ids,presented_ids)
   values(p_payload->>'requestKey',r.id,p_owner_id,p_payload->>'arm',p_payload->>'variant',(p_payload->>'repeatIndex')::integer,p_payload->>'userKey',r.config_hash,p_payload->>'mappingHash','claimed',clock_timestamp()+interval '120 seconds',array(select (x->>'itemId')::integer from jsonb_array_elements(p_payload->'candidates') x order by (x->>'knnRank')::integer),array(select (x->>'itemId')::integer from jsonb_array_elements(p_payload->'candidates') x)) returning * into q;
 end if;
 select coalesce(max(attempt_no),0)+1 into n from public.llm_calls where request_key = q.request_key;
 if n > 3 then update public.llm_requests set state = 'failed' where request_key = q.request_key; return jsonb_build_object('kind','exhausted'); end if;
 return jsonb_build_object('kind','claimed','leaseToken',q.lease_token,'nextAttemptNo',n);
end $$;

create function public.reserve_and_mark_sent(p_owner_id uuid, p_request_key text, p_lease_token uuid, p_attempt_no integer, p_bound_micro bigint, p_context jsonb) returns boolean language plpgsql security definer set search_path = public as $$
declare r public.eval_runs; q public.llm_requests; total bigint; arm_total bigint; probe_total bigint;
begin
 select r0.* into strict r from public.eval_runs r0 join public.llm_requests q0 on q0.run_id = r0.id where q0.request_key = p_request_key and r0.owner_id = p_owner_id for update of r0;
 select * into strict q from public.llm_requests where request_key = p_request_key and owner_id = p_owner_id for update;
 if r.state <> 'running' or q.state <> 'claimed' or q.lease_token <> p_lease_token or q.lease_until <= clock_timestamp() or q.sent_at is not null then raise exception 'claim invalid'; end if;
 if p_bound_micro < 0 or p_attempt_no not between 1 and 3 or p_attempt_no <> (select coalesce(max(attempt_no),0)+1 from public.llm_calls where request_key = q.request_key) then raise exception 'attempt invalid'; end if;
 select coalesce(sum(case when state = 'settled' then actual_micro else amount_micro end),0),
   coalesce(sum(case when arm = q.arm then case when state = 'settled' then actual_micro else amount_micro end else 0 end),0),
   coalesce(sum(case when variant <> 'base' then case when state = 'settled' then actual_micro else amount_micro end else 0 end),0)
   into total,arm_total,probe_total from public.budget_reservations where run_id = r.id and state <> 'released';
 if total + p_bound_micro > r.cap_micro or arm_total + p_bound_micro > coalesce((r.arm_caps->>q.arm)::bigint,0)
    or (q.variant <> 'base' and probe_total + p_bound_micro > coalesce((r.arm_caps->>'probe')::bigint,0)) then
   update public.eval_runs set state = 'incomplete', state_reason = 'budget_refused' where id = r.id;
   return false;
 end if;
 insert into public.budget_reservations(run_id,owner_id,request_key,attempt_no,arm,variant,amount_micro,state) values(r.id,p_owner_id,q.request_key,p_attempt_no,q.arm,q.variant,p_bound_micro,'reserved');
 if p_context->>'requestKey' is distinct from q.request_key or (p_context->>'attemptNo')::integer is distinct from p_attempt_no or (p_context->>'boundMicro')::bigint is distinct from p_bound_micro then raise exception 'invalid attempt context'; end if;
 update public.llm_requests set sent_at = clock_timestamp(), attempt_context = p_context where request_key = q.request_key;
 return true;
end $$;

-- Internal append helper: only service_role can invoke, and complete/hold/release call it in the same transaction.
create function public.insert_call(p_owner_id uuid, p_call jsonb) returns void language plpgsql security definer set search_path = public as $$
declare q public.llm_requests;
begin
 select * into strict q from public.llm_requests where request_key = p_call->>'requestKey' and owner_id = p_owner_id;
 if q.run_id is distinct from p_call->>'runId' or q.arm is distinct from p_call->>'arm' or q.variant is distinct from p_call->>'variant' or q.user_key is distinct from p_call->>'userKey' or q.repeat_index <> (p_call->>'repeatIndex')::integer or q.mapping_hash is distinct from p_call->>'mappingHash' then raise exception 'call provenance mismatch'; end if;
 if p_call->>'status' = 'cache_hit' and not exists(select 1 from public.llm_calls source where source.id = p_call#>>'{provenance,sourceCallId}' and source.owner_id = p_owner_id and source.call_row->>'cacheKey' = p_call->>'cacheKey' and source.call_row->>'mappingHash' = p_call->>'mappingHash' and source.call_row->>'model' = p_call->>'model') then raise exception 'cache call provenance mismatch'; end if;
 insert into public.llm_calls(id,request_key,run_id,owner_id,attempt_no,arm,variant,provider,model,prompt_version,prompt_hash,input_tokens,output_tokens,cached_tokens,reported_usage,price_table_date,bound_micro,cost_micro,latency_ms,status,call_row,created_at)
 values(p_call->>'id',q.request_key,q.run_id,p_owner_id,(p_call->>'attemptNo')::integer,q.arm,q.variant,p_call->>'provider',p_call->>'model',p_call->>'promptVersion',p_call->>'promptHash',(p_call->>'inputTokens')::bigint,(p_call->>'outputTokens')::bigint,(p_call->>'cachedTokens')::bigint,nullif(p_call->'reportedUsage','null'::jsonb),(p_call->>'priceTableDate')::date,(p_call->>'boundMicro')::bigint,(p_call->>'costMicro')::bigint,(p_call->>'latencyMs')::bigint,p_call->>'status',p_call,(p_call->>'createdAt')::timestamptz);
end $$;

create function public.complete_attempt(p_owner_id uuid, p_request_key text, p_lease_token uuid, p_call jsonb, p_response jsonb, p_cache jsonb default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.llm_requests; r public.eval_runs; b public.budget_reservations; source public.llm_calls;
begin
 select r0.* into strict r from public.eval_runs r0 join public.llm_requests q0 on q0.run_id = r0.id where q0.request_key = p_request_key and r0.owner_id = p_owner_id for update of r0;
 select * into strict q from public.llm_requests where request_key = p_request_key and owner_id = p_owner_id for update;
 if q.state <> 'claimed' or q.lease_token <> p_lease_token or q.lease_until <= clock_timestamp() or r.state not in ('running','incomplete') then raise exception 'claim invalid'; end if;
 if p_call->>'requestKey' is distinct from q.request_key or p_response->>'requestKey' is distinct from q.request_key or p_response->>'mappingHash' is distinct from q.mapping_hash then raise exception 'completion provenance mismatch'; end if;
 if p_call->>'status' = 'cache_hit' then
   if (p_call->>'costMicro')::bigint <> 0 or (p_call->>'boundMicro')::bigint <> 0 or q.sent_at is not null then raise exception 'invalid cache completion'; end if;
   select * into strict source from public.llm_calls where id = p_call#>>'{provenance,sourceCallId}' and owner_id = p_owner_id;
   if not exists(select 1 from public.response_cache c where c.owner_id = p_owner_id and c.cache_key = p_response->>'cacheKey' and c.mapping_hash = q.mapping_hash and c.source_call_id = source.id and to_jsonb(c.final_order) = p_response->'finalOrder') then raise exception 'invalid cache source'; end if;
 else
   select * into strict b from public.budget_reservations where request_key = q.request_key and attempt_no = (p_call->>'attemptNo')::integer and state = 'reserved' for update;
   if b.amount_micro <> (p_call->>'boundMicro')::bigint or (p_call->>'costMicro')::bigint > b.amount_micro then raise exception 'invalid settlement'; end if;
   update public.budget_reservations set state = 'settled', actual_micro = (p_call->>'costMicro')::bigint where id = b.id;
 end if;
 perform public.insert_call(p_owner_id,p_call);
 if p_cache is not null then
   if p_cache->>'sourceCallId' is distinct from p_call->>'id' or p_cache->>'cacheKey' is distinct from p_response->>'cacheKey' or p_cache->>'mappingHash' is distinct from q.mapping_hash or p_cache->'finalOrder' is distinct from p_response->'finalOrder' then raise exception 'invalid cache provenance'; end if;
   insert into public.response_cache(owner_id,cache_key,mapping_hash,final_order,raw_label_order,probabilities,usage,source_call_id,entry)
   values(p_owner_id,p_cache->>'cacheKey',q.mapping_hash,array(select jsonb_array_elements_text(p_cache->'finalOrder')::integer),p_cache->'rawLabelOrder',p_cache->'probabilities',p_cache->'usage',p_call->>'id',p_cache) on conflict(owner_id,cache_key) do nothing;
 end if;
 update public.llm_requests set state = 'done', final_order = array(select jsonb_array_elements_text(p_response->'finalOrder')::integer), repairs = p_response->'repairs', format_failure = (p_response->>'formatFailure')::boolean, response = p_response where request_key = q.request_key;
 return p_response;
end $$;

create function public.release_attempt(p_owner_id uuid, p_request_key text, p_lease_token uuid, p_call jsonb, p_retry boolean) returns void language plpgsql security definer set search_path = public as $$
declare q public.llm_requests;
begin
 perform 1 from public.eval_runs r join public.llm_requests x on x.run_id = r.id where x.request_key = p_request_key and r.owner_id = p_owner_id for update of r;
 select * into strict q from public.llm_requests where request_key = p_request_key and owner_id = p_owner_id for update;
 if q.state <> 'claimed' or q.lease_token <> p_lease_token or p_call->>'requestKey' is distinct from q.request_key or (p_call->>'costMicro')::bigint <> 0 then raise exception 'invalid release'; end if;
 update public.budget_reservations set state = 'released', actual_micro = 0 where request_key = q.request_key and attempt_no = (p_call->>'attemptNo')::integer and state = 'reserved';
 if not found then raise exception 'missing reservation'; end if;
 perform public.insert_call(p_owner_id,p_call);
 update public.llm_requests set sent_at = null, state = case when p_retry then 'claimed' else 'failed' end, lease_until = clock_timestamp()+interval '120 seconds' where request_key = q.request_key;
end $$;

create function public.hold_uncertain(p_owner_id uuid, p_request_key text, p_lease_token uuid, p_call jsonb) returns void language plpgsql security definer set search_path = public as $$
declare q public.llm_requests; liability bigint;
begin
 perform 1 from public.eval_runs r join public.llm_requests x on x.run_id = r.id where x.request_key = p_request_key and r.owner_id = p_owner_id for update of r;
 select * into strict q from public.llm_requests where request_key = p_request_key and owner_id = p_owner_id for update;
 if q.state <> 'claimed' or q.lease_token <> p_lease_token or p_call->>'requestKey' is distinct from q.request_key then raise exception 'invalid uncertainty claim'; end if;
 if p_call->>'status' = 'bound_violation' then
   liability := greatest((p_call->>'boundMicro')::bigint,(p_call->>'costMicro')::bigint);
   update public.budget_reservations set state = 'settled', actual_micro = liability where request_key = q.request_key and attempt_no = (p_call->>'attemptNo')::integer and state = 'reserved';
   update public.llm_requests set state = 'failed' where request_key = q.request_key;
   update public.eval_runs set state = 'incomplete', state_reason = 'accounting_failure' where id = q.run_id and state in ('running','incomplete');
 else
   update public.budget_reservations set state = 'held_uncertain' where request_key = q.request_key and attempt_no = (p_call->>'attemptNo')::integer and state = 'reserved';
   update public.llm_requests set state = 'uncertain' where request_key = q.request_key;
   update public.eval_runs set state = 'incomplete', state_reason = 'uncertain' where id = q.run_id and state = 'running';
 end if;
 perform public.insert_call(p_owner_id,p_call);
end $$;

create function public.record_failure(p_owner_id uuid, p_request_key text, p_lease_token uuid, p_call jsonb) returns void language plpgsql security definer set search_path = public as $$
declare q public.llm_requests;
begin
 perform 1 from public.eval_runs r join public.llm_requests x on x.run_id = r.id where x.request_key = p_request_key and r.owner_id = p_owner_id for update of r;
 select * into strict q from public.llm_requests where request_key = p_request_key and owner_id = p_owner_id for update;
 if q.state <> 'claimed' or q.lease_token <> p_lease_token or q.sent_at is not null or p_call->>'requestKey' is distinct from q.request_key then raise exception 'invalid unsent failure'; end if;
 perform public.insert_call(p_owner_id,p_call);
 update public.llm_requests set state = 'failed' where request_key = q.request_key;
end $$;

create function public.acknowledge_uncertain(p_run_id text, p_request_key text) returns void language plpgsql security definer set search_path = public as $$
declare q public.llm_requests; b public.budget_reservations;
begin
 perform 1 from public.eval_runs where id = p_run_id and owner_id = auth.uid() for update;
 if not found then raise exception 'owner required'; end if;
 select * into strict q from public.llm_requests where request_key = p_request_key and run_id = p_run_id and owner_id = auth.uid() for update;
 if q.state = 'claimed' and q.sent_at is not null and q.lease_until <= clock_timestamp() then
   if q.attempt_context is null then raise exception 'missing stale attempt context'; end if;
   if not exists(select 1 from public.llm_calls where request_key = q.request_key and attempt_no = (q.attempt_context->>'attemptNo')::integer) then
     perform public.insert_call(q.owner_id,q.attempt_context || jsonb_build_object('status','stale_uncertain'));
   end if;
   update public.budget_reservations set state = 'held_uncertain' where request_key = q.request_key and state = 'reserved';
 elsif q.state <> 'uncertain' then raise exception 'uncertain request required'; end if;
 for b in select * from public.budget_reservations where request_key = q.request_key and state = 'held_uncertain' for update loop
   -- Acknowledge the maximum liability; never free the reserved cap. The call row already exists except after a crashed worker.
   if not exists(select 1 from public.llm_calls where request_key = q.request_key and attempt_no = b.attempt_no) then
     raise exception 'stale attempt needs service reconciliation before acknowledgement';
   end if;
   update public.budget_reservations set state = 'settled', actual_micro = greatest(amount_micro,coalesce(actual_micro,0)) where id = b.id;
 end loop;
 update public.llm_requests set state = 'failed', sent_at = null, lease_until = clock_timestamp() where request_key = q.request_key;
end $$;

-- R RPCs check auth.uid(); F RPCs are denied to every client role.
revoke all on function public.start_run(text,text), public.mark_incomplete(text,text), public.resume_run(text,text), public.acknowledge_uncertain(text,text) from public, anon, authenticated;
grant execute on function public.start_run(text,text), public.mark_incomplete(text,text), public.resume_run(text,text), public.acknowledge_uncertain(text,text) to authenticated;
revoke all on function public.claim_request(uuid,jsonb), public.reserve_and_mark_sent(uuid,text,uuid,integer,bigint,jsonb), public.insert_call(uuid,jsonb), public.complete_attempt(uuid,text,uuid,jsonb,jsonb,jsonb), public.release_attempt(uuid,text,uuid,jsonb,boolean), public.hold_uncertain(uuid,text,uuid,jsonb), public.record_failure(uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.claim_request(uuid,jsonb), public.reserve_and_mark_sent(uuid,text,uuid,integer,bigint,jsonb), public.insert_call(uuid,jsonb), public.complete_attempt(uuid,text,uuid,jsonb,jsonb,jsonb), public.release_attempt(uuid,text,uuid,jsonb,boolean), public.hold_uncertain(uuid,text,uuid,jsonb), public.record_failure(uuid,text,uuid,jsonb) to service_role;
