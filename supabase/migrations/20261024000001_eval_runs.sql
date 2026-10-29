-- Source only: apply once in migration order; never replay against an unknown baseline.
create table public.eval_runs (
  id text primary key check (id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  owner_id uuid not null default auth.uid() references auth.users(id),
  split text not null check (split in ('dev','heldout')),
  mode text not null check (mode in ('mock','live')),
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  dataset_hash text not null check (dataset_hash ~ '^[0-9a-f]{64}$'),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  prereg_hash text check (prereg_hash ~ '^[0-9a-f]{64}$'), prereg_dated_at timestamptz,
  cap_micro bigint not null check (cap_micro between 0 and 9007199254740991),
  arm_caps jsonb not null check (jsonb_typeof(arm_caps) = 'object'),
  state text not null default 'draft' check (state in ('draft','approved','running','incomplete','complete')),
  state_reason text, summary jsonb,
  created_at timestamptz not null default now(), approved_at timestamptz, started_at timestamptz, completed_at timestamptz,
  unique(id, owner_id),
  check (split <> 'heldout' or mode <> 'live' or (prereg_hash is not null and prereg_dated_at is not null))
);
-- An incomplete/aborted claim still consumes the held-out slot. No state predicate.
create unique index heldout_live_once on public.eval_runs(owner_id, dataset_hash) where split = 'heldout' and mode = 'live';
alter table public.eval_runs enable row level security;
revoke all on public.eval_runs from public, anon, authenticated;
grant select, insert on public.eval_runs to authenticated;
grant update(config, config_hash, manifest_hash, dataset_hash, prereg_hash, prereg_dated_at, cap_micro, arm_caps, summary) on public.eval_runs to authenticated;
create policy eval_runs_read on public.eval_runs for select to authenticated using (owner_id = auth.uid());
create policy eval_runs_create on public.eval_runs for insert to authenticated with check (owner_id = auth.uid() and state = 'draft');
create policy eval_runs_update on public.eval_runs for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create function public.guard_state_transition() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.approved_at is not null or new.started_at is not null or new.completed_at is not null or new.summary is not null or new.state_reason is not null then
      raise exception 'new runs must be draft with server timestamps';
    end if;
    new.created_at := clock_timestamp(); return new;
  end if;
  if new.id <> old.id or new.owner_id <> old.owner_id or new.mode <> old.mode or new.split <> old.split or new.created_at <> old.created_at then raise exception 'immutable run identity'; end if;
  if old.state <> 'draft' and (new.config, new.config_hash, new.manifest_hash, new.dataset_hash, new.prereg_hash, new.prereg_dated_at, new.cap_micro, new.arm_caps)
    is distinct from (old.config, old.config_hash, old.manifest_hash, old.dataset_hash, old.prereg_hash, old.prereg_dated_at, old.cap_micro, old.arm_caps) then raise exception 'sealed config is immutable'; end if;
  if new.summary is distinct from old.summary and old.state not in ('running','incomplete') then raise exception 'summary requires active run'; end if;
  if new.state <> old.state and not ((old.state = 'draft' and new.state = 'approved') or (old.state = 'approved' and new.state = 'running') or
      (old.state = 'running' and new.state in ('incomplete','complete')) or (old.state = 'incomplete' and new.state = 'running')) then raise exception 'invalid state transition'; end if;
  if old.started_at is not null and new.started_at is distinct from old.started_at then raise exception 'started_at is immutable'; end if;
  if old.approved_at is not null and new.approved_at is distinct from old.approved_at then raise exception 'approved_at is immutable'; end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then raise exception 'completed_at is immutable'; end if;
  return new;
end $$;
create trigger freeze_sealed_fields before insert or update on public.eval_runs for each row execute function public.guard_state_transition();

-- Structural counterparts of contracts/frozen-config.ts. No SQL JSON rehashing or data/estimate verification is claimed.
create function public.json_object_keys_exact(p_value jsonb, p_keys text[]) returns boolean language sql immutable set search_path = public as $$
  select coalesce(jsonb_typeof(p_value) = 'object' and p_value ?& p_keys and p_value - p_keys = '{}'::jsonb, false)
$$;
create function public.validate_frozen_config(p_frozen jsonb, p_mode text, p_manifest jsonb) returns void language plpgsql set search_path = public as $$
declare field text; w jsonb; m jsonb;
begin
  if not public.json_object_keys_exact(p_frozen, array['schemaVersion','seed','knnK','K','tunedWeights','llmListPromptVersion','jevPromptVersion','primaryArm','bootstrapResamples','practicalMarginNdcg','probeSampleSeed','probeSampleMax','models','mock']) then raise exception 'invalid frozen config fields'; end if;
  if p_frozen->'schemaVersion' is distinct from '1'::jsonb or p_frozen->'K' not in ('20'::jsonb,'30'::jsonb)
     or p_frozen->'knnK' not in ('20'::jsonb,'50'::jsonb,'100'::jsonb,'"all"'::jsonb)
     or p_frozen->'llmListPromptVersion' not in ('"llm-list.v1"'::jsonb,'"llm-list.v2"'::jsonb)
     or p_frozen->'jevPromptVersion' is distinct from '"jev-point.v1"'::jsonb
     or p_frozen->'primaryArm' not in ('"llm-list"'::jsonb,'"jev-point"'::jsonb)
     or p_frozen->'bootstrapResamples' is distinct from '10000'::jsonb or p_frozen->'practicalMarginNdcg' is distinct from '0.01'::jsonb
     or p_frozen->'probeSampleMax' is distinct from '150'::jsonb then raise exception 'unsupported frozen config values'; end if;
  foreach field in array array['seed','probeSampleSeed'] loop
    if jsonb_typeof(p_frozen->field) is distinct from 'number' then raise exception 'frozen seeds must be integers'; end if;
    if (p_frozen->>field)::numeric <> trunc((p_frozen->>field)::numeric) then raise exception 'frozen seeds must be integers'; end if;
  end loop;
  if jsonb_typeof(p_manifest->'seed') is distinct from 'number' or p_manifest->'seed' is distinct from p_frozen->'seed' then raise exception 'manifest and config seeds differ'; end if;
  w := p_frozen->'tunedWeights';
  if not public.json_object_keys_exact(w, array['knn','recency','genre']) then raise exception 'invalid frozen weights'; end if;
  foreach field in array array['knn','recency','genre'] loop
    if jsonb_typeof(w->field) is distinct from 'number' then raise exception 'invalid frozen weights'; end if;
    if (w->>field)::numeric not in (0,0.25,0.5,0.75,1) then raise exception 'invalid frozen weights'; end if;
  end loop;
  if (w->>'knn')::numeric + (w->>'recency')::numeric + (w->>'genre')::numeric <> 1 then raise exception 'invalid frozen weights'; end if;
  m := p_frozen->'models';
  if not public.json_object_keys_exact(m, array['llm-list','jev-point']) then raise exception 'invalid frozen model pins'; end if;
  foreach field in array array['llm-list','jev-point'] loop
    if not public.json_object_keys_exact(m->field, array['provider','model']) or jsonb_typeof(m#>array[field,'provider']) is distinct from 'string'
       or jsonb_typeof(m#>array[field,'model']) is distinct from 'string' then raise exception 'invalid frozen model pins'; end if;
  end loop;
  if p_mode = 'live' then
    if p_frozen->'mock' is distinct from 'null'::jsonb or m is distinct from '{"llm-list":{"provider":"anthropic","model":"claude-haiku-5-5"},"jev-point":{"provider":"typesafe","model":"jev-1.13.0"}}'::jsonb then raise exception 'live provider/model pins mismatch'; end if;
  elsif p_mode = 'mock' then
    if m is distinct from '{"llm-list":{"provider":"mock","model":"mock-1"},"jev-point":{"provider":"mock","model":"mock-1"}}'::jsonb
       or not public.json_object_keys_exact(p_frozen->'mock', array['preset','seed','forcedModesHash']) then raise exception 'mock behavior/pins required'; end if;
    if p_frozen#>'{mock,preset}' not in ('"unbiased"'::jsonb,'"planted-bias"'::jsonb) or p_frozen#>'{mock,seed}' is distinct from p_frozen->'seed'
       or jsonb_typeof(p_frozen#>'{mock,forcedModesHash}') is distinct from 'string' or coalesce(p_frozen#>>'{mock,forcedModesHash}','') !~ '^[0-9a-f]{64}$' then raise exception 'invalid frozen mock behavior'; end if;
  else raise exception 'unsupported run mode'; end if;
end $$;

-- Validates the frozen schedule and owner-derived candidate counts, not their scientific truth.
create function public.validate_run_schedule(p_run_id text, p_config jsonb) returns void language plpgsql set search_path = public as $$
declare x jsonb; seen text[] := '{}'; users text[] := '{}'; counted text[] := '{}'; probes text[] := '{}'; k text;
begin
  if not public.json_object_keys_exact(p_config, array['schemaVersion','manifest','frozen','expectedResults','candidateCounts','probeUserKeys','devDiffs','prereg'])
     or p_config->'schemaVersion' is distinct from '1'::jsonb or jsonb_typeof(p_config->'manifest') is distinct from 'object'
     or jsonb_typeof(p_config->'frozen') is distinct from 'object' or jsonb_typeof(p_config->'expectedResults') is distinct from 'array'
     or jsonb_typeof(p_config->'candidateCounts') is distinct from 'array' or jsonb_typeof(p_config->'probeUserKeys') is distinct from 'array'
     or jsonb_typeof(p_config->'devDiffs') is distinct from 'array' or jsonb_typeof(p_config->'prereg') not in ('null','object') then raise exception 'missing frozen manifest/config/schedule'; end if;
  if jsonb_array_length(p_config->'expectedResults') not between 1 and 100000 or jsonb_array_length(p_config->'candidateCounts') not between 1 and 100000
     or jsonb_array_length(p_config->'probeUserKeys') > 150 or jsonb_array_length(p_config->'devDiffs') > 10000
     or exists(select 1 from jsonb_array_elements(p_config->'devDiffs') d where jsonb_typeof(d) <> 'number') then raise exception 'invalid frozen schedule size'; end if;
  for x in select value from jsonb_array_elements(p_config->'expectedResults') loop
    if not public.json_object_keys_exact(x, array['runId','arm','variant','repeatIndex','userKey']) or jsonb_typeof(x->'runId') is distinct from 'string'
       or jsonb_typeof(x->'userKey') is distinct from 'string' or jsonb_typeof(x->'arm') is distinct from 'string' or jsonb_typeof(x->'variant') is distinct from 'string'
       or jsonb_typeof(x->'repeatIndex') is distinct from 'number' or x->>'runId' is distinct from p_run_id or coalesce(x->>'userKey','') !~ '^[0-9a-f]{16}$'
       or coalesce(x->>'arm','') not in ('mostpop','itemknn','random-rerank','tuned-rerank','llm-list','jev-point')
       or coalesce(x->>'variant','') not in ('base','hist_shuffle','cand_reversed','cand_shuffled','masked','repeat','q_shuffle')
       or coalesce(x->>'repeatIndex','') <> case when x->>'variant' = 'repeat' then '1' else '0' end then raise exception 'invalid frozen result identity'; end if;
    if x->>'variant' <> 'base' and (not (p_config->'probeUserKeys' @> jsonb_build_array(x->>'userKey'))
       or not ((x->>'arm' = 'llm-list' and x->>'variant' in ('hist_shuffle','cand_reversed','cand_shuffled','masked','repeat'))
          or (x->>'arm' = 'jev-point' and x->>'variant' = 'q_shuffle'))) then raise exception 'invalid frozen probe'; end if;
    k := concat_ws('|', x->>'runId', x->>'arm', x->>'variant', x->>'repeatIndex', x->>'userKey');
    if k = any(seen) then raise exception 'duplicate frozen result identity'; end if;
    seen := array_append(seen,k);
    if not (x->>'userKey' = any(users)) then users := array_append(users,x->>'userKey'); end if;
  end loop;
  for x in select value from jsonb_array_elements(p_config->'candidateCounts') loop
    if not public.json_object_keys_exact(x, array['userKey','kEff']) or jsonb_typeof(x->'userKey') is distinct from 'string'
       or jsonb_typeof(x->'kEff') is distinct from 'number' or coalesce(x->>'userKey','') !~ '^[0-9a-f]{16}$'
       or not (x->>'userKey' = any(users)) or x->>'userKey' = any(counted) then raise exception 'invalid frozen candidate counts'; end if;
    if (x->>'kEff')::numeric <> trunc((x->>'kEff')::numeric) or (x->>'kEff')::numeric not between 0 and (p_config#>>'{frozen,K}')::numeric then raise exception 'invalid frozen candidate counts'; end if;
    counted := array_append(counted,x->>'userKey');
  end loop;
  if cardinality(counted) <> cardinality(users) then raise exception 'frozen candidate counts must cover every user'; end if;
  for x in select value from jsonb_array_elements(p_config->'probeUserKeys') loop
    k := x#>>'{}';
    if jsonb_typeof(x) <> 'string' or not (k = any(users)) or k = any(probes) then raise exception 'invalid frozen probe keys'; end if;
    probes := array_append(probes,k);
  end loop;
end $$;
revoke all on function public.guard_state_transition() from public, anon, authenticated;
revoke all on function public.validate_run_schedule(text,jsonb) from public, anon, authenticated;
revoke all on function public.validate_frozen_config(jsonb,text,jsonb), public.json_object_keys_exact(jsonb,text[]) from public, anon, authenticated;
