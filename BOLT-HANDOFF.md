# Bolt infrastructure handoff — Recommender offline evaluation

## Target and readiness

- App root: this inner repository root, not its optional private outer wrapper. Local branch `main`; inspect the actual checkout with `git rev-parse HEAD`. No remote/push/import/publication has been performed.
- Database target: **Bolt Database** with Supabase-compatible public auth/data/function APIs. Intended fresh empty target; actual connection, schema and applied migration baseline are **unknown**. Preserve any existing intended connection/data.
- Hosting: intended Bolt hosting, unprovisioned/unverified. Publication: **prepare only**.
- Status: **source implementation complete, never run; provisioning pending**. This is Dirty Mode construction acceptance, not locally validated or deployed readiness. No dependency install, lockfile generation, typecheck, lint, test, build, application/worker, SQL or provider execution occurred.
- Future Bolt action: **inspect and prepare only**. Provisioning/publishing requires a separate authorized activation. These files do not establish database or function readiness.
- Owner prerequisites: later repository/import access, intended database connection, auth email/reset-completion settings, provider accounts/keys, exact verified model pins/prices/bounds, final origin and approved budgets.

## Build and connection

| Item | Source / future command |
|---|---|
| Runtime/package manager | package.json declares Node >=20, npm; actual version compatibility pending |
| Install | First authorized activation: `npm install`, review/commit package-lock.json; afterwards `npm ci` |
| Dev | `npm run dev` in Bolt's managed environment; on Roy's workstation first claim a host port and pass it with `-- --port <assigned-port>` |
| Build/output | `npm run build` -> dist/ (never run) |
| Checks | `npm run typecheck`, `npm run lint`, `npm test` (all pending); Deno and SQL separate |
| Client | src/lib/supabase.ts, lazy nullable browser client; missing config supports explicit local mock |
| Public browser values | VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY |
| Public CLI equivalents | SUPABASE_URL, SUPABASE_ANON_KEY; gitignored token-only .recsys-session.json after explicit login |
| Source-only checks performed | Static source review and syntax parsing; no type/dependency/runtime/visual evidence |

## Database inventory (all applied status pending)

Inspect migration tracking first; apply only pending files in order during a later authorized activation. Never replay against an unknown baseline, drop/recreate resources or retry a timed-out migration blindly.

| Order | Exact migration | Implemented resources |
|---|---|---|
| 1 | supabase/migrations/20261024000001_eval_runs.sql | eval_runs, owner RLS/grants, state/freeze trigger, heldout_live_once owner+dataset unique index without state exclusion, frozen configuration/schedule validators |
| 2 | supabase/migrations/20261024000002_run_approvals.sql | run_approvals, immutable owner approval, before validation/server timestamp + after parent sealing triggers |
| 3 | supabase/migrations/20261024000003_llm_requests_calls.sql | llm_requests, llm_calls, owner read policies, function-only writes, per-attempt provenance |
| 4 | supabase/migrations/20261024000004_response_cache.sql | owner response_cache, source-call provenance, derived orders/probabilities/usage only |
| 5 | supabase/migrations/20261024000005_budget.sql | budget_reservations, atomic F-RPCs, lifecycle/uncertain R-RPCs |
| 6 | supabase/migrations/20261024000006_run_user_results.sql | immutable run_user_results, exact done-request/count integrity, complete_run, append_mock_call |

Access: signed-in owners select their own runs/approvals/requests/calls/cache/results; RLS also checks parents. Reservations have no client table access. No anonymous product data or client delete path. Owner result inserts require a running run and approved exact identity/count evidence. Live model rows reconcile function-owned done results; a no-call zero row needs frozen zero-candidate evidence.

Approval seals config/manifest/prereg/caps, exact expected result identities and `candidateCounts:[{userKey,kEff}]`. Candidate counts are owner-derived freeze evidence, not independent dataset truth. The envelope remains schemaVersion1 because nothing was ever provisioned/run; do not import an earlier construction envelope missing candidateCounts.

R-RPCs granted to authenticated owners: `start_run`, `mark_incomplete`, `resume_run`, `complete_run`, `acknowledge_uncertain`, `append_mock_call` (mock mode only). F-RPCs granted only to service_role: `claim_request`, `reserve_and_mark_sent`, `complete_attempt`, `release_attempt`, `hold_uncertain`, `record_failure`, internal `insert_call`. Each privileged function pins search_path; actual grants and RLS must be exercised with real user clients, not inferred from admin SQL.

Reservations lock the parent and account overlapping run/arm/probe caps. Reserve and sent marker occur together. Definite permitted retries are separately recorded/reserved; uncertain sent calls retain liability and require explicit bound-consuming acknowledgement. `complete_run` checks frozen identities and no unresolved requests/reservations. Actual transaction/concurrency/trigger behavior is unverified.

Extensions: no custom scheduler/vector extension required; verify gen_random_uuid availability in the chosen PostgreSQL target. Seeds: not required for schema. Use the local synthetic generator for acceptance, not raw MovieLens uploads. Realtime: not required.

## Function

| Name/source | Caller/auth | Contract | Dependencies/secrets | Configuration |
|---|---|---|---|---|
| rerank — supabase/functions/rerank/index.ts | Signed-in user JWT; verify_jwt=true plus handler auth.getUser and owner-scoped run load | One rank operation: capped strict RerankPayload -> RerankResponse; no free prompt/model/URL/target | Tables/RPCs above; Anthropic and TypeSafe fixed adapters; names below | supabase/config.toml [functions.rerank] verify_jwt=true |

The function validates keys, frozen config/mode/pins/prompt/data/cardinality, approval and held-out timing; claims a lease; reuses done/cache results; gates prices/bounds; reserves; calls a fixed adapter; guards output; settles atomically. Retries are limited to 429/529 or proven pre-send failure, max three attempts. Post-send ambiguity is not auto-retried. Missing/excess usage marks accounting failure and stops the run.

The deployment closure is committed in rerank/_vendor, mirroring canonical repository paths. `scripts/sync-function-vendor.ts` adds a generated TS header and rewrites only zod to `npm:zod@3.23.8`; JSON is copied exactly. Source equality/import-closure regression is unexecuted. Verify the deployed bundle includes the closure and pinned dependencies; frontend compilation does not prove Deno resolution.

CORS: final ALLOWED_ORIGIN must match the chosen console origin. A wildcard is only a development preflight default, not authorization. CLI calls have no browser origin. Auth/JWT/origin/missing-secret/error behavior all remain pending acceptance checks. No request/prompt/raw-response body logging or raw rating storage is intended.

## Server settings (names only)

| Name | Consumer | Source/requirement |
|---|---|---|
| ANTHROPIC_API_KEY | rerank llm-list adapter | Owner provider account, server secret only |
| TYPESAFE_API_KEY | rerank Jev adapter | Owner provider account, server secret only |
| ALLOWED_ORIGIN | rerank CORS | Owner final console origin; required for intended browser origin policy |
| SUPABASE_URL | rerank database/auth | Platform-injected availability must be verified |
| SUPABASE_ANON_KEY | rerank user-JWT client | Platform-injected public key, availability must be verified |
| SUPABASE_SERVICE_ROLE_KEY | rerank privileged repo/RPCs | Platform-injected server secret, never browser/CLI |

Missing live secret should return actionable `secret_missing:<NAME>` without a value. Keep all current live price/bound gates off until exact model IDs, current API protocol, usage fields, prices and byte-bound assumptions are verified with approved dev calls. The TypeSafe typed-question JSON is provisional; local guide/spec text is not live integration evidence.

## Auth, storage and external steps

- Email/password sign-up/sign-in/sign-out and reset-request UI source is present. Configure confirmation/email delivery and final Site URL/redirect allowlist. The app uses the root route and provider-default reset redirect; configure an authorized reset-completion destination. A password-change completion form is not part of the reset-request scope.
- No buckets/uploads, Realtime publication, webhook, cron, durable worker or scheduler is required. Raw files stay on the user's device. The Web Worker computes locally; long execution uses a continuously running CLI and durable resume.
- Local mock is explicit, simulated and not persisted in the browser. Persisted mock writes zero-cost approved rows under owner auth. Live mode is not replaced by fabricated responses when an integration fails.
- D1 exact generative model pin, D2 budgets (proposal held-out5/dev2, arms4/1, overlapping probes2 USD), D3 allowed origin and D4 real failure-example publication remain owner decisions. No spending or publication is authorized by this handoff.

## Pending acceptance checks

All outcomes are **PENDING / never executed**; see docs/DEFERRED-VALIDATION.md for exact commands/scenarios.

| Check | Expected behavior | Outcome |
|---|---|---|
| Install/type/lint/test/build/worker | locked dependencies, all checks and UI module load succeed | Pending |
| Deno closure | `deno check supabase/functions/rerank/index.ts`; deployment includes vendor imports | Pending |
| SQL/schema/RLS | six pending migrations apply; two real users/anon isolated; F-RPC grants enforced | Pending |
| Freeze/approval/held-out | unsupported/missing/mode-incompatible configs reject; no config/timestamp reset; same dataset claim retained in all states | Pending |
| Live result integrity | forged empty/contradictory results reject; approved genuine zero no-call user retained | Pending |
| Concurrency/accounting | overlapping caps serialized; attempt/cache provenance; leases/uncertainty retain liability | Pending |
| Function errors | invalid/anon JWT, non-owner, no approval, bad payload/origin, missing secret and unverified bound fail clearly | Pending |
| Providers | exact protocols/models/usage/prices/bounds verified on separately approved dev calls | Pending |
| Both console branches/CLI | local no-network and persisted mock auth/dry/approve/cancel/reselect/resume/results/exports match frozen identities | Pending |
| Real measurement | live dev selection -> dated prereg -> one frozen held-out run -> generated table and owner-reviewed failure excerpt | Pending |
| Hosting/publication | separate authorization and actual final-route/auth receipt | Not requested |

## One prompt after an authorized future import — inspect and prepare only

> Read BOLT-HANDOFF.md and inspect this source at the intended checkout/revision. Target Bolt Database without replacing an existing intended connection. Compare the six migration files, rerank function/auth/vendor closure, public connection settings and server secret names with the actual available environment. Inspect migration history read-only when authorized and report concrete compatibility/deployment gaps, unexecuted checks and owner steps. Preserve the app, data and closed live gates. Prepare a reviewable activation plan using the actual resource names. Do not provision or change cloud resources, apply migrations, deploy functions, enter secrets, start paid calls, enable schedules or publish. The source has never been installed, type-checked, tested, built or run; do not describe static construction as a working deployment.
