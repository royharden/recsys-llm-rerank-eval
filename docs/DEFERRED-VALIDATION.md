# Deferred validation

This repository was written under **Dirty Mode**: source only. Nothing in it has been installed, type-checked, linted,
tested, built or run. The only check performed was a syntax-only TypeScript parse (`tools/tsparse.cjs` in the outer
planning shell, VS Code's bundled TypeScript, no type resolution). Every item below must be done, in order, before any
result from this code is trusted. Seeded in M1; each later milestone appends its rows.

| # | Item | Why deferred | Exact command / steps |
|---|---|---|---|
| 1 | Install dependencies and commit the lockfile | Installs and network are forbidden in Dirty Mode, so no `package-lock.json` exists and versions are caret ranges only | `npm install` → review resolved versions → commit `package-lock.json`; afterwards always `npm ci` |
| 2 | Type check (app + node configs) | No `node_modules`, so `tsc` cannot resolve `zod`, `vite/client`, `@types/node` | `npm run typecheck` (= `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.node.json`); fix every error |
| 3 | Lint, incl. erasable-TS and Scorer-import rules | ESLint not installed | `npm run lint` |
| 4 | Unit tests: util, data, synthetic, split | Vitest not installed; tests were written, never executed | `npm test` (or `npx vitest run tests/util tests/data tests/split`) |
| 5 | SHA-256 against independent vectors | Pure-TS implementation never executed | `npm test -- tests/util/sha256.test.ts`; additionally compare `sha256Hex(bytes)` with `node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('fixtures/synthetic/u.data')).digest('hex'))"` |
| 6 | Generate and commit the synthetic fixture | `gen:synthetic` needs `tsx`; fixture files must be produced by the generator, never hand-written | `npm run gen:synthetic` → inspect `fixtures/synthetic/{u.data,u.item,traps.json}` → run twice and confirm byte-identical (`git diff --exit-code fixtures/synthetic`) → commit |
| 7 | Synthetic trap structure holds on the generated files | Generator logic (anchor-pinned cut, island/cluster construction) never run | `npm test -- tests/data/synthetic.test.ts`; confirm the split reports `T = 892000000` for every q trial and `insufficientPrecision: true` (150 users cannot reach 150 held-out) |
| 8 | Real ML-100K load + split counts | Data download is network; `data/ml-100k/` is gitignored | Download `ml-100k.zip` from https://grouplens.org/datasets/movielens/100k/ → unzip to `data/ml-100k/` → load via `src/core/node/fs-data.ts` (`readMovieLensBytes` + `loadDataset`) and confirm 100,000 rows, 943 users, 1,682 items, 0 rejects; record q, T, eligible/dev/held-out counts and the q-rule outcome |
| 9 | Manifest lock freeze-once behaviour | Writes files; never run | With no `config/manifest.lock.json`: run the loader once (lock written, `frozeNow: true`); run again (`frozeNow: false`, same salt and manifestHash); confirm the lock is gitignored (`git check-ignore config/manifest.lock.json`) |

## Seeded from PLAN §11 for later milestones (steps are completed when the milestone lands)

| # | Item | Milestone | Exact command / steps |
|---|---|---|---|
| 10 | Mock end-to-end eval | M3 | `npm run eval` → `results/results.md` + `results/results.jsonl`, MOCK stamp present |
| 11 | Deno check of the `rerank` function | M4 | `deno check supabase/functions/rerank/index.ts` |
| 12 | Migrations on a real Bolt Database; RLS two-user isolation; JWT/anon rejection | M4 | Apply `supabase/migrations/*` in order; two test accounts; anon-key call to `rerank` must 401 |
| 13 | Approval/cap under concurrency; freeze/transition triggers; held-out unique index; result-integrity trigger | M4 | Scripted SQL/RPC scenarios against the provisioned database |
| 14 | Uncertain/lease handling with a fake slow provider | M4 | Pipeline run with an adapter that sleeps past the 30 s timeout after send |
| 15 | Provider + Jev live calls, model pin, prices, token-bound overhead (`boundVerified`) | M4 / activation | One dev live call per adapter; compare reported usage with the bound; only then set `boundVerified: true` |
| 16 | Cache across reloads; CLI login/live | M4 | Re-run a dev live run and confirm `cache_hit` rows at 0 µ$; `npm run eval -- login`, `--run-id` |
| 17 | Browser UX on both branches + Web Worker | M5 | `npm run dev`; walk the local-mock and persisted-mock journeys |
| 18 | README numbers regenerated from outputs | M6 | Regenerate the table from `results/results.md`; never hand-edit numbers |
| 19 | Entry points not yet present at M1: `scripts/eval.ts` (M3), `scripts/sync-function-vendor.ts` (M4), `src/app/main.tsx` (M5) | M1 | `npm run eval`, `npm run sync:vendor`, `npm run dev`/`build` fail until those milestones land; re-check after M5 |

## M2 — baselines, metrics, statistics

| # | Item | Why deferred | Exact command / steps |
|---|---|---|---|
| 20 | Unit tests: arms, tuning, metrics, stats | Vitest not installed; tests written, never executed | `npx vitest run tests/arms tests/metrics tests/stats` |
| 21 | Type check of the M2 modules (strict, `noUnusedLocals`, `verbatimModuleSyntax`) | Only a syntax parse was possible | `npm run typecheck`; pay attention to `src/core/arms/*`, `src/core/metrics/ranking.ts`, `src/core/stats/*` and the tuple-typed `Map` constructions in `tests/helpers/toy.ts` / `tests/arms/tuning.test.ts` |
| 22 | Lint: Scorer import restriction holds for `src/core/arms/**` | ESLint not installed | `npm run lint`; additionally `grep -rn "split/scorer" src/core/arms` must print nothing |
| 23 | itemknn cost on real ML-100K (dense 1,682² Float32Array ≈ 11 MB, neighbour sort, per-user scoring) | Never executed; timing/memory unmeasured | Load ML-100K (row 8), `buildTrainingData(dataset.interactions, split.T, dataset.items)` under `node --max-old-space-size=512`, time it and one `tuneOnDev` pass over the dev users; record wall time and peak RSS. Expected: seconds, < 100 MB |
| 24 | Dev tuning outcomes on real data (k, K, tuned-rerank weights) | Needs real data and a Scorer; never run | After row 8: `tuneOnDev({ train, itemById, devUsers: devUsersOf(split, split.devUserIds, salt), judge: judgeFromScorer(scorerFromSplit(split, split.devUserIds, salt)), fitsCap: () => true })`; record k trials, ceilings (hits20/hits30/n), K reason and the weight trials |
| 25 | Bootstrap runtime at 10,000 resamples × n held-out | Never executed | Time `pairedBootstrap` on n = 470 random vectors (≈ 4.7 M draws); expect well under 1 s |
| 26 | Cross-check of metric formulas against an independent implementation | Only hand-computed tests (unrun) | Compute HR@10 / NDCG@10 / MRR@K / coverage / novelty for one arm with a short independent script (e.g. a spreadsheet or a 20-line Node script over `results.jsonl` from M3) and compare to 1e-12 |

## M3 — model arms, runner, reports and mock CLI

All rows below remain **pending**. The implementation and test sources have only been parsed for syntax.
The `contextsForUsers` / `devUsersOf` adapters now live in `src/core/split/contexts.ts`; target-bearing
`SplitResult` and `Scorer` imports are forbidden from arms, prompts, providers and probes by ESLint.

| # | Item | Why deferred | Exact command / steps |
|---|---|---|---|
| 27 | M3 contracts, prompts, guard and probe/ledger tests | Tests authored under Dirty Mode, never executed | `npm test -- tests/model` |
| 28 | Runner, immutable resume, JSONL corruption, report pooling and prereg tests | Same | `npm test -- tests/runner tests/report tests/prereg` |
| 29 | Complete static typing/lint after dependency installation | Syntax parse cannot resolve imports, types or ESLint rules | `npm run typecheck`; `npm run lint`; fix all errors including JSON import attributes and `noUnusedLocals` |
| 30 | Default mock end-to-end journey | CLI/tsx, tuning and I/O never executed | `npm run eval` → inspect `results/results.md`, `results/results.jsonl`, `results/config.json`; confirm six base arms, all probe rows, MOCK stamp, conditional/tercile/head-share rows, failure excerpt, paired CIs and ledger totals; no live/network calls |
| 31 | Dry run has no provider calls | Source inspection only; spy regression unrun | `npm run eval -- --dry-run`; `npm test -- tests/model/probes-ledger.test.ts`; the dry run uses v1 as a declared placeholder and does not select the primary model |
| 32 | JSONL resume keeps frozen identity and salt | Filesystem behavior never executed | Run `npm run eval` twice; second pass must reuse the lock's salt and preserve results.jsonl bytes/count (completed rows skipped). `npm run eval -- --seed 39` against that same lock must refuse. `npm test -- tests/runner/jsonl-store.test.ts` checks identity mismatch and corrupt trailing record refusal |
| 33 | Planted position bias / unbiased control | No measured mock output yet | `npm test -- tests/model/probes-ledger.test.ts`; then `npm run eval -- --preset planted-bias --output-dir results/planted` and compare its position-bias CI/flag with the unbiased output; do not substitute simulated values into a claim |
| 34 | Guard permutations and exact chaos repair counts | All nine chaos modes are test sources only | `npm test -- tests/model/guard.test.ts`; confirm valid prose/fences, unknown/repeated/missing labels, empty/wrong/no reply and finite [0,1] Jev validation |
| 35 | Prompt leakage and repeat/cache separation | Tests never executed | `npm test -- tests/model/contracts-prompts.test.ts`; target changes and added post-T rows must leave both prompt bodies byte-identical; duplicate-metadata mappings and repeat index must change cache keys |
| 36 | Pooled novelty/head share and failure-list definition | Report never executed | `npm test -- tests/report/table.test.ts`; compare short-list recommendation-pair weighting with an independent calculation; verify failure list is kNN rank ≤10 and model rank >10/absent |
| 37 | Prereg template activation | Template is intentionally undated/invalid; no live choices exist | Follow `config/prereg.schema.md` after approved live dev evaluation; run `npm test -- tests/prereg/schema.test.ts`; M4 must call `assertPreregistered` with persisted hashes and startedAt before held-out live calls |
| 38 | TypeSafe request shape/model and provider billing | Network/API calls forbidden; local source follows the construction plan only | At activation, check current TypeSafe primary docs against `serializeJevRequest` and the Jev adapter; verify `jev-1.13.0`, probability response keys and reported usage; confirm provider prices/overhead; only then enable verified bounds as in row 15 |
| 39 | Real-data mock evaluation on the locked split | Dataset unavailable and runtime forbidden | After row 8, `npm run eval -- --data-dir data/ml-100k --manifest-lock config/manifest.lock.json --output-dir results/ml100k-mock`; all output remains MOCK and cannot be a held-out live measurement |

Local JSONL checkpoints are single-writer files. An interrupted partial JSON record is refused with its line number;
restore a complete checkpoint before resuming. This is an explicit local mock adapter; a persisted/live error must
never silently fall back to it. `config/manifest.lock.json` stays gitignored; no salt or raw user ids enter result exports.


## M4 — backend, live client and persisted resume

All items remain **pending**. SQL text guards are typo/contract guards, not evidence of executable SQL or actual RLS.
The committed vendor closure was generated by a filesystem-only copy of source with its documented header/zod rewrite;
no application, sync script, provider, database or test runner executed during construction.

| # | Item | Why deferred | Exact command / steps |
|---|---|---|---|
| 40 | M4 type/lint and backend/client regression sources | Dependencies absent; Dirty Mode forbids execution | `npm run typecheck`; `npm run lint`; `npm test -- tests/backend tests/client tests/vendor.test.ts`; fix every error before trusting the source |
| 41 | Canonical vendor regeneration and equality | TS sync tool and Vitest never executed | `npm run sync:vendor`; `git diff --exit-code -- supabase/functions/rerank/_vendor`; `npm test -- tests/vendor.test.ts`; confirm every local import resolves inside `_vendor` |
| 42 | Deno compilation/deployment dependencies | No Deno/package/network setup permitted | `deno check supabase/functions/rerank/index.ts`; inspect `verify_jwt = true` in `supabase/config.toml`; verify deployed bundle includes the closure and pinned npm imports |
| 43 | Six migration execution and baseline | No database started/provisioned | Inspect the intended Bolt Database migration history first; apply only pending `20261024000001_eval_runs.sql` through `20261024000006_run_user_results.sql` in order; record actual SQL errors/schema/receipt; preserve any existing data |
| 44 | Real two-user ownership and RPC grants | Static policies do not prove isolation | Sign in accounts A/B plus anon client; A creates a synthetic run/approval/results; B and anon must fail reads/inserts/mutations of A's run, approvals, requests, calls, cache and results. Authenticated/anon calls to each F-RPC must fail; service role is server-only |
| 45 | Freeze/state/timestamp and held-out-once rules | Triggers/index never executed | As owner attempt direct state/owner/timestamp changes, approved config/cap/prereg edits and backward transitions; all must fail. Create held-out live run for a dataset, mark incomplete, then try same dataset with a new salt/config/run id: unique claim must still reject |
| 46 | Atomic overlapping budget caps | Concurrency untested | With a fake bounded provider and authorized dev run, send concurrent requests whose combined bounds exceed run, arm and overlapping probe caps; at most fitting reservations may send, refused run becomes incomplete, settled/held liability remains in totals |
| 47 | Attempt/lease/crash/acknowledgement accounting | No provider/DB runtime | Exercise 429/529 retries, proven pre-send failure, timeout/crash after reserve+sent, live/expired leases, stale sent request and acknowledgement; never automatically repeat uncertain send, retain durable attempt metadata, acknowledgement consumes full bound, then resume same request only when safe |
| 48 | Cache and completion integrity | Transactions unexecuted | Complete one dev live request, reload/replay same identity: stored response or zero-cost cache row with original source-call provenance; repeatIndex=1 must not use repeat 0. Attempt mismatched live result insert and finalization missing/replacing a frozen key: reject; complete only exact expected set with no unresolved liability |
| 49 | Real adapter protocol/model/usage/prices/bounds | Local guide is provisional; no network or paid calls | Compare `adapters.ts` and Jev `serializeJevRequest` with current official provider docs; verify `{model,state,questions}` typed-Noul JSON and answers[key].noul, immutable model pins, actual usage, billable cached/units/output fields, token limits and message overhead. Run one approved dev call per adapter, compare bound to reported liability; only then update dated prices and `priceVerified`/`boundVerified` |
| 50 | Missing secret/auth/origin failures | Edge function never invoked | With authorized isolated setup, call missing/invalid JWT and anon bearer (401), another owner's run (403), missing approval/config mismatch (403), missing secret (actionable 503 without values), unknown price (500), unverified bound (503), oversized body (413), malformed fields/keys (422), disallowed CORS origin |
| 51 | CLI auth and session privacy | Login, filesystem permissions and refresh never run | Set public `SUPABASE_URL`/`SUPABASE_ANON_KEY`; `npm run eval -- login` (password must not echo); inspect `.recsys-session.json` ACL/mode without printing tokens, ensure gitignored; expire/refresh session and verify persisted replacement; `npm run eval -- logout`; local credential file removed only by this explicit future user action |
| 52 | Approved CLI live dry/run/resume/export | No authenticated runtime | Approve a dev run in console, then `npm run eval -- --live --run-id <approved-dev-run-id> --data-dir data/ml-100k --dry-run`; inspect estimate without paid calls. When authorized, repeat without `--dry-run`, interrupt/resume same id; compare generated rows/calls/report with console; no CLI approve command, provider key or silent mock fallback |
| 53 | Persisted mock cancellation/resume and pagination | Test source only | `npm test -- tests/client`; then console persisted mock synthetic run: cancel/reload, reselect identical files, resume; changed bytes/config/salt/seed must reject. Confirm >1000 result/call rows are fully paged and finished runs export without restarting calls |
| 54 | Held-out activation | No live dev evidence or dated prereg exists | After verified live dev runs, freeze selected k/K/weights/prompt/primary/models/probes/seeds and budgets; date executable prereg strictly before server start, record exact hashes, approve once, execute/resume the one frozen held-out live identity; generate all numbers/table/failure list from output, never hand-edit a measurement |
| 55 | CLI persisted/mock export and restricted refresh | Source only; filesystem/SDK never exercised | `npm run eval -- --mock --output-dir results/m4-local`; `npm run eval -- --mock --dry-run`; console-create/approve persisted synthetic MOCK, then `npm run eval -- --mock --run-id <approved-mock-id> --output-dir results/m4-persisted`; interrupt and re-run same command, verify exact rows and complete read-only re-export. After row 51, confirm POSIX 0600 or Windows current-SID-only ACL without inherited/other allow ACEs, including after token refresh. Test active-lease acknowledgement rejection and expired explicit acknowledgement with full-bound accounting |
| 56 | M4 direct approval and forged-empty regressions | SQL and Vitest regression sources only; never executed | After row 43 on an isolated test database, create a test auth user and run `psql "$ISOLATED_DATABASE_URL" -v owner_id=<test-user-uuid> -f tests/backend/approval-result-regressions.sql` as an administrator able to `SET ROLE authenticated`. It must reject authenticated approvals with K=10, missing seed/weights, invalid weight grid/prompt/primary/resamples/probe seed, mode-incompatible pins/mock fields, manifest seed mismatch, and missing/incomplete/duplicate candidate counts; each rejection leaves draft/no approval. Valid live and mock approvals must pass. An existing nonempty done request followed by a forged empty row must reject, including a contradictory frozen-zero marker. A no-request user frozen with candidates must reject an empty row; a frozen-zero user with no request must accept exactly the empty miss with no calls. All fixture writes roll back |
| 57 | Frozen candidate schedule and pre-call schema binding | Shared contract and new assertions have syntax inspection only | `npm test -- tests/backend/pipeline.test.ts tests/backend/migration-contracts.test.ts tests/client/frozen-resume.test.ts tests/client/store.test.ts tests/vendor.test.ts`; malformed complete-config fields must reject before claim/reserve/provider even with matching owner-attested hashes; mismatched payload candidate counts (including an approved zero) must reject. Resume must reject changed candidate-count evidence. Separately exercise simultaneous result insert/claim using one frozen-zero user and one candidate-bearing user; the parent locks must serialize and claim must reject zero/candidate cardinality mismatches |

M4 rework API note: persisted envelope `schemaVersion: 1` now **requires** `candidateCounts: [{ userKey, kEff }]`, one row per distinct expected
user, covering all arms/variants for that user. `expectedResults` identities are unchanged. `preparePersistedConfig` derives counts from the frozen
contexts; reconstruction and `assertFrozenExpectations(expectedResults, candidateCounts, schedule)` verify them again before run/dry run/export.
M5 consumers must use this preparation path and retain the field unchanged when approving/resuming. There is no provisioned or executed M4 baseline;
pre-rework local draft fixtures must be recreated rather than filled with inferred zero counts. These six migrations remain unapplied source; if a
target already has any prior edition applied, inspect its migration history and prepare a forward migration before touching it.

Counts are authenticated owner-derived freeze evidence, sealed with the run on approval. SQL checks structure, supported parameters, mode/pins,
manifest identity/seed, count coverage, and consistency with function outcomes. It does not recompute dataset/candidate truth, SQL JSON hashes,
client-derived metrics, or the owner-attested estimate. Exact model pins, live prices/bounds, SQL execution and concurrency remain unverified.
