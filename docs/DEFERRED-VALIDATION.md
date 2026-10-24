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
