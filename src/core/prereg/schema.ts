import { z } from 'zod';
import { hashCanonical } from '../util/hash.ts';
import { ARM_VARIANTS } from '../contracts/rerank-payload.ts';
import { FrozenConfigSchema, type FrozenConfig } from '../contracts/frozen-config.ts';
export { FrozenConfigSchema, type FrozenConfig } from '../contracts/frozen-config.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export function configHashOf(config: FrozenConfig): string { return hashCanonical(FrozenConfigSchema.parse(config)); }

// Executable preregistration is separate from config/prereg.json's human-readable undated template.
// M6 may add UI authoring; this contract already rejects an undated held-out live run.
export const PreregSchema = z.object({
  schemaVersion: z.literal(1), datedAt: z.string().datetime(), datasetHash: hash, manifestHash: hash, configHash: hash,
  config: FrozenConfigSchema,
  probes: z.object({
    'llm-list': z.array(z.enum(['hist_shuffle', 'cand_reversed', 'cand_shuffled', 'masked', 'repeat'])),
    'jev-point': z.array(z.literal('q_shuffle')),
  }).strict(),
}).strict().superRefine((p, ctx) => {
  if (p.configHash !== configHashOf(p.config)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'configHash mismatch' });
  for (const arm of ['llm-list', 'jev-point'] as const) {
    const want = ARM_VARIANTS[arm].filter((v) => v !== 'base');
    if (p.probes[arm].join('|') !== want.join('|')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${arm}: freeze all declared probes in canonical order` });
  }
});
export type Prereg = z.infer<typeof PreregSchema>;
export function preregHashOf(value: Prereg): string { return hashCanonical(PreregSchema.parse(value)); }
export function assertPreregistered(value: unknown, expected: { datasetHash: string; manifestHash: string; configHash: string; startedAt: string }): Prereg {
  const p = PreregSchema.parse(value);
  for (const field of ['datasetHash', 'manifestHash', 'configHash'] as const) if (p[field] !== expected[field]) throw new Error(`prereg ${field} mismatch`);
  const start = Date.parse(expected.startedAt);
  if (!Number.isFinite(start) || !(Date.parse(p.datedAt) < start)) throw new Error('prereg must be dated before run start');
  return p;
}
