# Preregistration contract

`prereg.json` is an intentionally invalid, undated template. Its executable validators are
`src/core/prereg/schema.ts`: `FrozenConfigSchema`, `PreregSchema`, `configHashOf`, `preregHashOf`,
and `assertPreregistered`. Do not start a live held-out run using the template.

After an approved **live dev** run, fill the null choices from dev tuning and freeze the chosen k,
K, weights, prompt version, primary arm (tie to llm-list), model pins, probe design/seeds, bootstrap
settings and practical margin. Hash the complete validated config with `configHashOf`; fill dataset
and manifest hashes from the locked manifest; date in UTC strictly before held-out start; then hash
the validated registration using `preregHashOf`. The dated record and its hashes become immutable run
config. `assertPreregistered` rejects wrong hashes, changed choices, missing dates and late dates.

Mock configuration uses provider/model `mock`/`mock-1` and records its preset plus forced-mode hash.
Mock reports are simulated and do not establish live choices or a measurement. The CLI's mock-only
held-out journey may use a null prereg hash; held-out **live** identities reject a null hash. M4 must
validate the full dated registration against the persisted run's start before allowing calls.

The candidate live model and all provider prices/request bounds remain unverified. This contract
does not bypass `boundVerified:false` or provisioning/approval gates. The owner-set date and hashes
are self-attested workflow controls, not proof that a human preregistered honestly.
