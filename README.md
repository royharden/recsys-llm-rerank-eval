# Recommender offline evaluation with an LLM reranker

An offline measurement console and CLI comparing item-kNN with two bounded model rerankers on MovieLens 100K. The question is whether reranking changes held-out NDCG@10, with paired confidence intervals, candidate ceilings, probes and cost per user. A negative or inconclusive result is a valid experiment outcome.

**Status: source construction complete; runtime unverified. Not yet measured.** This repository was written in source-only Dirty Mode. Nothing has been installed, type-checked, linted, tested, built, run, provisioned or deployed. Static source reviews and syntax-only TypeScript parsing have been performed; they do not establish type correctness, working UI, SQL/RLS isolation or model behavior. Test files are unexecuted source. There is no generated lockfile, synthetic file fixture, result table or live measurement yet.

Every simulated report is labelled **MOCK: simulated, not a measurement**. Never use a mock result as evidence of live recommendation quality.

## Implemented source

- React + TypeScript + Vite console: Setup/account access, Data, Run, Results, Inspector and Ledger. Missing public configuration leaves an explicit local mock option. The public browser client activates only when persisted mode is selected.
- One plain-TypeScript core and Node CLI: validated Latin-1 MovieLens ingestion, seeded synthetic generator, frozen temporal/dev/held-out split, four non-model arms and two model arms, guarded permutations, metrics, bootstrap, probes and computed reports.
- Bolt Database-compatible source: six ordered SQL migrations, owner RLS, approvals, frozen schedules, cache, atomic overlapping budget reservations, uncertain-attempt accounting, resumable results and the authenticated Deno `rerank` function.
- Local mock uses memory in the console and JSONL checkpoints in the CLI. Persisted mock and live use the same frozen result-store/lifecycle interfaces. A persisted error never silently switches to local mock.

The arms are `mostpop`, `itemknn`, `random-rerank`, `tuned-rerank`, `llm-list` and `jev-point`. The last two only reorder the same item-kNN pool. Targets stay outside their context/payloads. Empty-candidate and cold-target users remain misses. Failed formats are repaired or fall back to kNN and stay in denominators.

## Activation commands (not executed)

Run these only in a separately authorized activation phase after Dirty Mode closes, from this repository root. `package.json` declares Node >=20 and npm; actual installed-tool compatibility remains unverified.

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Review and commit the generated `package-lock.json`; subsequent clean installs use `npm ci`. The full pending checklist, including edge-function and database checks, is [docs/DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md). Frontend checks do not validate the Deno function or SQL.

For a future workstation browser run, claim a host port using the existing agent-ports workflow before starting Vite, then pass that assigned port with `npm run dev -- --port <assigned-port>`. No local server was started during construction. Bolt's managed development environment uses its own port arrangement.

## Keyless mock journey

After the activation prerequisites, choose **Local mock** in Setup, then **Use synthetic fixture** on Data. Inspect validation and the manifest. On Run, **Compute dry run — no provider calls** shows a provisional plan. **Select mock variants on dev + freeze design** explicitly performs simulated dev selection. Start the frozen run, inspect Results, its named failure list, Inspector and Ledger, then download computed Markdown/JSONL. Local tab state is lost on reload. Save a private manifest lock if you need to preserve its salt and identities.

The same core is available through the CLI:

```sh
npm run gen:synthetic
npm run eval -- --mock --dry-run
npm run eval
npm run eval -- --mock --preset planted-bias --output-dir results/planted
```

`gen:synthetic` writes `fixtures/synthetic/{u.data,u.item,traps.json}`. The default eval generates the seeded input in memory, freezes/reuses its manifest lock, and writes `results/results.md`, `results/results.jsonl` and `results/config.json`. Run it again to resume the same JSONL identity. Changed data/config/seed requires an explicit different experiment; it must not overwrite a completed analysis. Generated fixture bytes, traps, numbers and performance have never been checked by execution.

The seed-38 generator has 150 users/300 items and named trap constructions for cold targets, ceiling misses, recency, popularity, duplicate titles/metadata, timestamp ties, short lists, injection text, malformed model output and planted position bias. The source includes corresponding regression assertions, not evidence that they pass.

## MovieLens input

Download MovieLens 100K yourself from [GroupLens](https://grouplens.org/datasets/movielens/100k/), review its terms, and place `u.data` and `u.item` in gitignored `data/ml-100k/`, or select the two files in Data. Do not commit or redistribute the raw dataset. `u.user` is never read. Cite F. Maxwell Harper and Joseph A. Konstan, *The MovieLens Datasets: History and Context* (2015), [doi:10.1145/2827872](https://doi.org/10.1145/2827872).

```sh
npm run eval -- --mock --data-dir data/ml-100k --manifest-lock config/manifest.lock.json --output-dir results/ml100k-mock
```

This is still simulated inference. Raw ratings remain local; the browser uploads neither source file. A persisted run stores derived rankings, hashes, metadata and accounting. Live model calls transiently send recent history and candidate titles/year/genres to hosted providers. Review the dataset terms and provider handling before real transfer. Real manifests contain a private salt; keep them private. A user key is pseudonymous, not anonymous.

## Frozen protocol

All ratings count as interactions. A global temporal cutoff uses the predeclared q rule; training uses only pre-cutoff interactions. Dev users select kNN neighborhood, K (20/30), reranker weights, prompt and primary. Held-out live settings must come from live dev evidence, be dated in executable pre-registration before server start, and stay frozen during resume. `config/prereg.json` is an intentionally invalid, undated template; see [config/prereg.schema.md](config/prereg.schema.md). The console accepts a dated preregistration or `{prereg,devDiffs}` package and matching private manifest; these are owner-attested inputs, not independently verified provenance.

Results include HR@10, NDCG@10, MRR@K, shared ceiling, coverage, pooled novelty/head share, delta CIs, cost, latency, failures, repairs and n; conditional and popularity-tercile rows are exploratory. The primary verdict is fixed before held-out evaluation. A CI spanning zero means no detectable difference, not equivalence. History/candidate-order, masking, repeat and Jev question-order probes belong to the one frozen protocol. Masking is not memorisation removal.

## Persistence and live path

Use [BOLT-HANDOFF.md](BOLT-HANDOFF.md) for the single infrastructure inventory. No cloud resources exist by virtue of these files. Browser public values are `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Provider/service-role secrets belong only in function settings. Account source supports sign-in, sign-up, sign-out and password-reset request; email and reset-completion settings remain owner/platform configuration.

Live pins are provisional (`claude-haiku-5-5`, `jev-1.13.0`); prices/protocol/bounds are unverified. Current gates deliberately refuse paid starts. Verify current primary provider docs, exact returned model IDs, usage, prices and bounds in an approved dev activation before enabling them. No browser or CLI holds provider keys. The proposed held-out cap is $5, arm caps $4/$1, overlapping probe cap $2; a dev cap of $2 is proposed. Caps are explicit owner choices sealed at approval, not permission to spend now.

For future persisted execution: sign in, create an exact draft, review the dry plan, record explicit approval, then start. After reload, load that run ID and reselect the original local files. Its stored manifest/salt/T/seed/config wins; no retuning or replacement of the expected keys/counts occurs. Completed runs are read/exported without new calls. Uncertain sent calls require explicit acknowledgement consuming their full bound before a safe retry.

For long runs, **a tab is not a worker — use the CLI**. The Web Worker handles computation, not unattended background execution. After provisioning/authorization, set CLI public `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then:

```sh
npm run eval -- login
npm run eval -- --live --run-id APPROVED_DEV_RUN_ID --data-dir data/ml-100k --dry-run
npm run eval -- --live --run-id APPROVED_DEV_RUN_ID --data-dir data/ml-100k
npm run eval -- logout
```

The CLI cannot approve runs. Login prompts without password echo and stores token-only session state in gitignored `.recsys-session.json`; filesystem permissions/refresh remain unverified. `logout` removes that local session file when explicitly invoked in the future. Persisted mock uses `--mock --run-id APPROVED_MOCK_RUN_ID`. Keep the process running; database resume is not a background scheduler.

## Source map and remaining decisions

`src/core` owns deterministic evaluation; `src/core/node` is CLI-only. `src/lib` owns public auth/persistence. `src/app` owns the console. `src/shared/{evalkit,callledger,providers,orderprobe,rerankguard}.ts` are reusable exports. The Edge function uses transformed copies under `_vendor`; after a canonical source change run the deferred `npm run sync:vendor` and equality check.

See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for inference/privacy limitations. Owner decisions remain: exact generative model pin (D1), approved budgets (D2), final allowed origin (D3), and whether any real failure examples may be published (D4). Default publication excerpt is synthetic only; none has been generated. Source is MIT; runtime dependencies and datasets retain their own terms. No remote, push, import, deployment or publication was performed.
