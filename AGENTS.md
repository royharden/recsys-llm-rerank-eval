# Product agent instructions — v1.0 (2026-10-24)

This inner folder is the product Git root. The optional outer wrapper holds private planning, STATUS/HANDOFF, reviews and backups; never copy those artifacts into product source or commit in that wrapper. Follow its current authorized task when present. Do not create a second plan, naming registry, team or skill mirror as a side effect.

Current phase: source construction under Roy's explicitly scoped Dirty Mode. Runtime remains unverified. Until Roy explicitly authorizes activation/closes that mode, do not install dependencies, run tests/builds/apps/browsers/databases, make network/provider calls, provision, deploy or publish. Do not push/create remotes or delete preserved work. Keep backups before replacing inherited files. User instructions control the phase.

Canonical boundaries:

- React/Vite console in src/app, public user auth/persistence in src/lib, deterministic shared core in src/core. Node-only filesystem/session code stays in src/core/node; never import it in the browser.
- Targets remain in scoring/report/split paths. Arms, prompts, providers and probes receive target-free UserContext or strict capped payloads. Models only permute candidates; code computes all metrics and verdicts. Preserve cold/zero-candidate users and format failures in denominators.
- Use the canonical frozen config/schema, manifest, exact expected keys and candidateCounts. Resume stored identities without retuning. Never reset held-out eligibility or replace approved configuration.
- Atomic accounting/authorization lives in ordered migrations and the rerank function; browser/CLI use user JWT and owner RPCs only. No provider/service-role secrets in src or VITE_ values. No silent persisted-to-mock fallback.
- Vendored closure source is src/core/{util,prompts,rerankguard,contracts} plus price/prompt JSON. Edit canonical files, then regenerate copies with scripts/sync-function-vendor.ts in an authorized phase. Keep the equality/import-closure regression source.
- Raw MovieLens/session/real manifest locks remain private/gitignored. Never commit raw data, credentials, agent transcripts or fabricated measurement outputs.

Read README.md, BOLT-HANDOFF.md and docs/DEFERRED-VALIDATION.md before activation. Full type/lint/test/build/Deno/SQL/tenant/concurrency/browser/provider checks are pending; syntax parsing is not a substitute. Every source bug fix needs a meaningful regression source and an honest record of what was actually checked. Do not weaken guards or enable unverified live gates to make a demo appear ready.

Changelog: v1.0 adds the stable product boundaries and source-only activation status. No shared skills or global instructions were changed.
