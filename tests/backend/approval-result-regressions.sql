-- UNEXECUTED regression source. Future isolated Bolt-compatible database only, after all six migrations.
-- psql "$ISOLATED_DATABASE_URL" -v owner_id=<existing-test-auth-user-uuid> -f tests/backend/approval-result-regressions.sql
-- Run as an administrator able to SET ROLE authenticated. Uses the real owner approval/RLS boundary; all writes roll back.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.sub', :'owner_id', true);
create temporary table m4_fixture(config jsonb);
insert into m4_fixture values ('{
  "schemaVersion":1,
  "manifest":{"schemaVersion":1,"coreVersion":"0.1.0","seed":38,"q":0.8,"T":100,"minHistory":10,"minHeldout":150,
    "insufficientPrecision":true,"qTrials":[{"q":0.8,"T":100,"eligible":8,"dev":4,"heldout":4}],
    "files":{"uData":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uItem":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    "datasetHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "manifestHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "counts":{"interactions":100,"users":8,"items":40,"catalogue":20,"eligible":8,"dev":4,"heldout":4,"coldTargets":0,
      "exclusions":{"insufficient_history":0,"no_target":0},"rejectedLines":0},
    "salt":"0123456789abcdef0123456789abcdef","frozenAt":"2026-10-24T20:00:00.000Z"},
  "frozen":{"schemaVersion":1,"seed":38,"knnK":20,"K":20,"tunedWeights":{"knn":1,"recency":0,"genre":0},
    "llmListPromptVersion":"llm-list.v1","jevPromptVersion":"jev-point.v1","primaryArm":"llm-list","bootstrapResamples":10000,
    "practicalMarginNdcg":0.01,"probeSampleSeed":38,"probeSampleMax":150,"mock":null,
    "models":{"llm-list":{"provider":"anthropic","model":"claude-haiku-5-5"},"jev-point":{"provider":"typesafe","model":"jev-1.13.0"}}},
  "expectedResults":[
    {"runId":"placeholder","arm":"llm-list","variant":"base","repeatIndex":0,"userKey":"aaaaaaaaaaaaaaaa"},
    {"runId":"placeholder","arm":"llm-list","variant":"base","repeatIndex":0,"userKey":"bbbbbbbbbbbbbbbb"},
    {"runId":"placeholder","arm":"llm-list","variant":"base","repeatIndex":0,"userKey":"cccccccccccccccc"},
    {"runId":"placeholder","arm":"llm-list","variant":"base","repeatIndex":0,"userKey":"dddddddddddddddd"}],
  "candidateCounts":[{"userKey":"aaaaaaaaaaaaaaaa","kEff":2},{"userKey":"bbbbbbbbbbbbbbbb","kEff":2},
    {"userKey":"cccccccccccccccc","kEff":0},{"userKey":"dddddddddddddddd","kEff":0}],
  "probeUserKeys":[],"devDiffs":[],"prereg":null
}'::jsonb);
grant select on m4_fixture to authenticated;

-- These intentionally owner-attested hashes are not scientific or SQL-rehash evidence.
create function pg_temp.make_draft(p_id text, p_config jsonb, p_mode text default 'live') returns void language plpgsql as $$
begin
  p_config := jsonb_set(p_config, '{expectedResults}', (select jsonb_agg(x || jsonb_build_object('runId',p_id)) from jsonb_array_elements(p_config->'expectedResults') x));
  insert into public.eval_runs(id,split,mode,manifest_hash,dataset_hash,config,config_hash,cap_micro,arm_caps)
  values(p_id,'dev',p_mode,repeat('c',64),repeat('b',64),p_config,repeat('a',64),1000,'{"llm-list":1000,"jev-point":1000,"probe":1000}');
end $$;
create function pg_temp.approve(p_id text) returns void language plpgsql as $$
begin
  insert into public.run_approvals(run_id,owner_id,config_hash,estimate_hash,estimate_micro,cap_micro,arm_caps)
  select id,owner_id,config_hash,repeat('e',64),0,cap_micro,arm_caps from public.eval_runs where id = p_id;
end $$;
create function pg_temp.expect_rejected(p_sql text, p_reason text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_reason in sqlerrm) = 0 then raise exception 'unexpected rejection: %',sqlerrm; end if;
    return;
  end;
  raise exception 'REGRESSION: operation unexpectedly succeeded: %',p_sql;
end $$;
create function pg_temp.insert_empty(p_id text, p_user text) returns void language plpgsql as $$
begin
  insert into public.run_user_results(run_id,arm,variant,repeat_index,user_key,candidate_ids,ranked_ids,presented_ids,k_eff,flags,
    target_rank,in_candidates,target_popularity,cold_target,repairs,format_failure,call_ids,request_key)
  values(p_id,'llm-list','base',0,p_user,'{}','{}','{}',0,array['short_list','no_candidates'],null,false,0,false,
    '{"unknown":0,"repeat":0,"missing":0,"emptyRanking":0}',false,'{}',null);
end $$;

set local role authenticated;
do $$
declare base jsonb; c jsonb; kind text; reason text;
begin
  select config into strict base from m4_fixture;
  foreach kind in array array['K10','missingSeed','missingWeights','badWeights','badPrompt','badPrimary','badResamples','badProbeSeed',
    'badPin','liveMock','mockLivePins','manifestSeed','missingCounts','missingUserCount','duplicateCount'] loop
    c := base; reason := 'unsupported frozen config values';
    case kind
      when 'K10' then c := jsonb_set(c,'{frozen,K}','10');
      when 'missingSeed' then c := c #- '{frozen,seed}'; reason := 'invalid frozen config fields';
      when 'missingWeights' then c := c #- '{frozen,tunedWeights}'; reason := 'invalid frozen config fields';
      when 'badWeights' then c := jsonb_set(c,'{frozen,tunedWeights}','{"knn":0.1,"recency":0.9,"genre":0}'); reason := 'invalid frozen weights';
      when 'badPrompt' then c := jsonb_set(c,'{frozen,jevPromptVersion}','"jev-point.v2"');
      when 'badPrimary' then c := jsonb_set(c,'{frozen,primaryArm}','"itemknn"');
      when 'badResamples' then c := jsonb_set(c,'{frozen,bootstrapResamples}','100');
      when 'badProbeSeed' then c := jsonb_set(c,'{frozen,probeSampleSeed}','null'); reason := 'frozen seeds must be integers';
      when 'badPin' then c := jsonb_set(c,'{frozen,models,llm-list,model}','"moving-alias"'); reason := 'live provider/model pins mismatch';
      when 'liveMock' then c := jsonb_set(c,'{frozen,mock}','{}'); reason := 'live provider/model pins mismatch';
      when 'mockLivePins' then reason := 'mock behavior/pins required';
      when 'manifestSeed' then c := jsonb_set(c,'{manifest,seed}','39'); reason := 'manifest and config seeds differ';
      when 'missingCounts' then c := c - 'candidateCounts'; reason := 'missing frozen manifest/config/schedule';
      when 'missingUserCount' then c := c #- '{candidateCounts,0}'; reason := 'frozen candidate counts must cover every user';
      when 'duplicateCount' then c := jsonb_set(c,'{candidateCounts}',c->'candidateCounts' || (c#>'{candidateCounts,0}')); reason := 'invalid frozen candidate counts';
    end case;
    perform pg_temp.make_draft('m4-reject-' || kind,c,case when kind = 'mockLivePins' then 'mock' else 'live' end);
    perform pg_temp.expect_rejected(format('select pg_temp.approve(%L)','m4-reject-' || kind),reason);
    if exists(select 1 from public.eval_runs where id = 'm4-reject-' || kind and state <> 'draft')
       or exists(select 1 from public.run_approvals where run_id = 'm4-reject-' || kind) then raise exception 'rejected approval was not atomic'; end if;
  end loop;
  c := jsonb_set(base,'{frozen,models}','{"llm-list":{"provider":"mock","model":"mock-1"},"jev-point":{"provider":"mock","model":"mock-1"}}');
  c := jsonb_set(c,'{frozen,mock}',jsonb_build_object('preset','unbiased','seed',38,'forcedModesHash',repeat('e',64)));
  perform pg_temp.make_draft('m4-valid-mock',c,'mock');
  perform pg_temp.approve('m4-valid-mock');
  if not exists(select 1 from public.eval_runs where id = 'm4-valid-mock' and state = 'approved') then raise exception 'supported mock approval failed'; end if;
  perform pg_temp.make_draft('m4-result-regression',base);
  perform pg_temp.approve('m4-result-regression');
  perform public.start_run('m4-result-regression',repeat('a',64));
end $$;
reset role;

-- Privileged fixture seeds durable done outcomes, not paid calls. d's contradictory zero marker specifically
-- proves identity reconciliation cannot be bypassed even if an old/inconsistent approved marker says zero.
insert into public.llm_requests(request_key,run_id,owner_id,arm,variant,repeat_index,user_key,config_hash,mapping_hash,state,lease_until,
  candidate_ids,presented_ids,final_order,repairs,format_failure,response)
select repeat(case when u = 'aaaaaaaaaaaaaaaa' then 'd' else 'f' end,64),'m4-result-regression',auth.uid(),'llm-list','base',0,u,
  repeat('a',64),repeat('e',64),'done',clock_timestamp(),array[1,2],array[1,2],array[2,1],
  '{"unknown":0,"repeat":0,"missing":0,"emptyRanking":0}',false,'{"callIds":[]}'::jsonb
from unnest(array['aaaaaaaaaaaaaaaa','dddddddddddddddd']) u;
set local role authenticated;
select pg_temp.expect_rejected($q$select pg_temp.insert_empty('m4-result-regression','aaaaaaaaaaaaaaaa')$q$,'live result differs from function result');
select pg_temp.expect_rejected($q$select pg_temp.insert_empty('m4-result-regression','dddddddddddddddd')$q$,'live result differs from function result');
select pg_temp.expect_rejected($q$select pg_temp.insert_empty('m4-result-regression','bbbbbbbbbbbbbbbb')$q$,'live no-call result requires frozen no-candidate user');
select pg_temp.insert_empty('m4-result-regression','cccccccccccccccc');
do $$
begin
  if (select count(*) from public.run_user_results where run_id = 'm4-result-regression') <> 1
    or exists(select 1 from public.llm_requests where run_id = 'm4-result-regression' and user_key = 'cccccccccccccccc')
    then raise exception 'legitimate frozen zero-candidate no-call result did not persist alone'; end if;
end $$;
reset role;
rollback;
