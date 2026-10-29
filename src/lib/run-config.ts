import { z } from 'zod';
import { configHashOf, FrozenConfigSchema, PreregSchema, preregHashOf, assertPreregistered } from '../core/prereg/schema.ts';
import { ResultRowSchema, RunIdentitySchema, resultKey, type RunIdentity } from '../core/runner/store.ts';
import { loadManifest, ManifestSchema } from '../core/split/manifest.ts';
import { CandidateCountsSchema, candidateScheduleError, frozenModeError } from '../core/contracts/frozen-config.ts';

export const ResultKeySchema = ResultRowSchema.pick({ runId: true, arm: true, variant: true, repeatIndex: true, userKey: true });
export const PersistedConfigSchema = z.object({
  schemaVersion: z.literal(1), manifest: ManifestSchema, frozen: FrozenConfigSchema,
  expectedResults: z.array(ResultKeySchema).min(1).max(100000),
  candidateCounts: CandidateCountsSchema,
  probeUserKeys: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(150),
  devDiffs: z.array(z.number().finite()).max(10000), prereg: PreregSchema.nullable(),
}).strict();
export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;
export const PersistedRunSchema = z.object({
  id: z.string().min(1).max(64), owner_id: z.string().uuid(), mode: z.enum(['mock', 'live']), split: z.enum(['dev', 'heldout']),
  dataset_hash: z.string(), manifest_hash: z.string(), config_hash: z.string(), prereg_hash: z.string().nullable(),
  prereg_dated_at: z.string().nullable(), config: PersistedConfigSchema,
  state: z.enum(['draft', 'approved', 'running', 'incomplete', 'complete']),
  started_at: z.string().nullable(), cap_micro: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  arm_caps: z.object({ 'llm-list': z.number().int().nonnegative(), 'jev-point': z.number().int().nonnegative(),
    probe: z.number().int().nonnegative() }).strict(),
}).passthrough();
export type PersistedRun = z.infer<typeof PersistedRunSchema>;
export function identityOfRun(run: PersistedRun): RunIdentity {
  return RunIdentitySchema.parse({ schemaVersion: 1, runId: run.id, mode: run.mode, split: run.split,
    datasetHash: run.dataset_hash, manifestHash: run.manifest_hash, configHash: run.config_hash, preregHash: run.prereg_hash });
}
/** Called at every persisted boundary, including read-only export of completed runs. */
export function validatePersistedRun(input: unknown): PersistedRun {
  const run = PersistedRunSchema.parse(input);
  const identity = identityOfRun(run);
  const config = run.config;
  const loaded = loadManifest(config.manifest, { datasetHash: identity.datasetHash });
  if (!loaded.ok) throw new Error(loaded.error);
  if (config.manifest.manifestHash !== identity.manifestHash || configHashOf(config.frozen) !== identity.configHash)
    throw new Error('persisted manifest/config hash mismatch');
  if (config.manifest.seed !== config.frozen.seed) throw new Error('manifest and config seeds differ');
  if (new Set(config.expectedResults.map(resultKey)).size !== config.expectedResults.length ||
    config.expectedResults.some((key) => key.runId !== run.id)) throw new Error('invalid frozen expected result keys');
  if (new Set(config.probeUserKeys).size !== config.probeUserKeys.length) throw new Error('duplicate frozen probe keys');
  const candidatesError = candidateScheduleError(config.candidateCounts, config.expectedResults.map((key) => key.userKey), config.frozen.K);
  if (candidatesError) throw new Error(candidatesError);
  const modeError = frozenModeError(config.frozen, run.mode);
  if (modeError) throw new Error(modeError);
  if (config.prereg) {
    if (preregHashOf(config.prereg) !== identity.preregHash || config.prereg.datasetHash !== identity.datasetHash ||
      config.prereg.manifestHash !== identity.manifestHash || config.prereg.configHash !== identity.configHash ||
      Date.parse(config.prereg.datedAt) !== Date.parse(run.prereg_dated_at ?? '')) throw new Error('persisted preregistration mismatch');
    if (run.started_at) assertPreregistered(config.prereg, { ...identity, startedAt: run.started_at });
  } else if (identity.preregHash !== null || run.prereg_dated_at !== null || (run.mode === 'live' && run.split === 'heldout'))
    throw new Error('held-out live run requires its frozen dated preregistration');
  return run;
}
