create table public.run_approvals (
  run_id text primary key, owner_id uuid not null, config_hash text not null,
  estimate_hash text not null check (estimate_hash ~ '^[0-9a-f]{64}$'),
  estimate_micro bigint not null check (estimate_micro >= 0), cap_micro bigint not null check (cap_micro >= 0),
  arm_caps jsonb not null, approved_at timestamptz not null default now(),
  foreign key(run_id,owner_id) references public.eval_runs(id,owner_id)
);
alter table public.run_approvals enable row level security;
revoke all on public.run_approvals from public, anon, authenticated;
grant select, insert on public.run_approvals to authenticated;
create policy approvals_read on public.run_approvals for select to authenticated using (owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid()));
create policy approvals_insert on public.run_approvals for insert to authenticated with check (owner_id = auth.uid() and exists(select 1 from public.eval_runs r where r.id = run_id and r.owner_id = auth.uid() and r.state = 'draft' and r.config_hash = run_approvals.config_hash and r.cap_micro = run_approvals.cap_micro and r.arm_caps = run_approvals.arm_caps));
create function public.approve_run_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare r public.eval_runs;
begin
  select * into strict r from public.eval_runs where id = new.run_id for update;
  if r.owner_id <> new.owner_id or r.owner_id <> auth.uid() or r.state <> 'draft' or r.config_hash <> new.config_hash or r.cap_micro <> new.cap_micro or r.arm_caps <> new.arm_caps then raise exception 'approval mismatch'; end if;
  perform public.validate_frozen_config(r.config->'frozen',r.mode,r.config->'manifest');
  perform public.validate_run_schedule(r.id,r.config);
  if r.config#>>'{manifest,datasetHash}' is distinct from r.dataset_hash or r.config#>>'{manifest,manifestHash}' is distinct from r.manifest_hash then raise exception 'manifest identity mismatch'; end if;
  if r.mode = 'mock' and new.estimate_micro <> 0 then raise exception 'mock estimate must be zero'; end if;
  new.approved_at := clock_timestamp();
  return new;
end $$;
create trigger record_run_approval before insert on public.run_approvals for each row execute function public.approve_run_insert();
-- Change the parent AFTER the insert's RLS draft check. A BEFORE parent change would make that check reject every approval.
create function public.seal_approved_run() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.eval_runs set state = 'approved', approved_at = new.approved_at where id = new.run_id and owner_id = new.owner_id and state = 'draft';
  if not found then raise exception 'draft approval parent required'; end if;
  return new;
end $$;
create trigger seal_run_approval after insert on public.run_approvals for each row execute function public.seal_approved_run();
revoke all on function public.approve_run_insert() from public, anon, authenticated;
revoke all on function public.seal_approved_run() from public, anon, authenticated;
