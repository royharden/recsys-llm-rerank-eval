# Limitations and measurement status

**Not yet measured.** Source construction and static review are complete, but dependencies, types, tests, builds, CLI, UI/worker, SQL/RLS and providers have never run. There is no accuracy result, executed trap pass, measured latency or verified spend. All activation checks remain in [DEFERRED-VALIDATION.md](DEFERRED-VALIDATION.md).

## Interpretation

- The target is one next interaction, not an observed preference judgment, causal recommendation benefit, or online A/B result. All ratings count as binary interactions.
- Only pre-cutoff interactions train popularity/similarity, including pre-cutoff histories from both cohorts (declared transductive training). Dev/held-out users are disjoint; dev chooses parameters and the primary. Held-out live analysis resumes one identity rather than being restarted after seeing results.
- A reranker cannot recover a target outside the candidate pool. Cold and zero-candidate users stay in denominators. Conditional-on-target-in-K rows and popularity terciles are exploratory and have their own n.
- Small target-in-K cohorts limit power. The normal-approximation MDE is approximate, unavailable for inadequate/zero-variance dev differences, and not a guarantee. A CI spanning zero is not equivalence. Constant-difference bootstrap intervals can be degenerate; the report retains the warning.
- MovieLens is old and may be memorised by models. Title masking measures reliance on titles; it does not remove memorisation or establish uncontaminated evaluation.
- Mock affinity is history-derived and simulated, never a hidden-target oracle or evidence of live quality. Planted/control probe assertions are unexecuted source.
- Dense Float32 similarities can break mathematical ties by an ULP while remaining deterministic. The synthetic generator's floating-point weighted sampling may vary at engine boundaries; generated fixture determinism still needs validation.

## Integrity and accounting boundaries

Owner RLS, immutable approved envelopes, candidate counts, expected result identities, request/result integrity and the held-out owner/dataset index guard an honest owner's workflow. Dataset/candidate truth, scientific metrics, pre-registration dates and hashes/estimates are owner-attested; creating a new account/dataset identity can evade workflow-level claims. They are not external proof of scientific integrity.

The byte-count-plus-overhead token bound is a construction assumption, not a universal tokenisation theorem. Protocol, exact pins, reported usage, prices and per-adapter overhead must be verified before `boundVerified` is enabled. A timeout/crash after send is uncertain liability, never a free retry. Acknowledgement consumes its bound. Missing/over-bound usage stops the run for accounting failure. Actual SQL transaction/isolation/concurrency behavior is still unverified.

Caps overlap: an arm cap includes its probes, and the probe cap restricts a subset of the same spend. Cache hits cost zero incremental spend and retain original-call provenance; this does not mean the original inference was free. Inspect attempt rows, not a hand-entered total.

## Data and publication

Raw MovieLens files stay local/gitignored and `u.user` is not read. Persisted storage contains derived rankings, metadata/hashes, approvals and accounting, not raw ratings or prompt/model-response prose. Live providers transiently receive history/candidate metadata. Verify applicable dataset/provider terms at activation.

A published manifest salt can map pseudonymous user keys back to public source IDs. Keep real locks and CLI session tokens private; do not describe user keys as anonymous. Inspector and named demotion titles require matching local files and the stored manifest; mismatches show reselection rather than stale labels. Titles are not added to persisted rows or provider payloads by the failure-list rendering helper.

No named failure excerpt is published here because the generator/evaluation has not run. Results will compute the list of kNN-top-10 targets demoted below ten by a model and resolve titles locally; exports retain pseudonymous ranks rather than raw user IDs. A future docs excerpt is capped at 20 cases and synthetic by default. Real examples require the owner's D4 decision; do not invent or hand-type failures as evidence.

## Operational limits

Local browser state is not persisted; reload loses it. CLI JSONL is single-writer and rejects a partial/corrupt trailing record. Restore a complete checkpoint rather than discarding evidence. Persisted runs need original files again after reload. No server-side worker or scheduler continues work after a tab closes. Email confirmation/reset-completion configuration and the live model/origin/budget decisions are pending owner work.
