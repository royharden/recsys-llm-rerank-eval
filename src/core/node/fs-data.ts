// Node-only I/O for the CLI: raw MovieLens bytes and the manifest lock. Never imported by src/app.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Dataset, ValidationReport } from '../data/types.ts';
import type { RawFiles } from '../data/movielens.ts';
import { freezeManifest, loadManifest, splitFromManifest, type Manifest } from '../split/manifest.ts';
import { temporalSplit, type QOptions, type SplitResult } from '../split/temporal.ts';

export const DEFAULT_DATA_DIR = 'data/ml-100k';
export const MANIFEST_LOCK_PATH = 'config/manifest.lock.json';

function asBytes(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Read u.data and u.item as raw bytes (hashing and latin-1 decoding happen in the pure core). */
export async function readMovieLensBytes(dir: string = DEFAULT_DATA_DIR): Promise<RawFiles> {
  const [uData, uItem] = await Promise.all([readFile(path.join(dir, 'u.data')), readFile(path.join(dir, 'u.item'))]);
  return { uData: asBytes(uData), uItem: asBytes(uItem) };
}

/** 16 cryptographically random bytes as 32 hex chars: the manifest salt, generated once per dataset. */
export function randomSaltHex(): string {
  return randomBytes(16).toString('hex');
}

/** Stored lock JSON, or null when no lock exists. */
export async function readManifestLock(file: string = MANIFEST_LOCK_PATH): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write a new lock. Refuses to overwrite an existing one (flag 'wx'): a manifest is never re-frozen for a dataset. */
export async function writeManifestLock(manifest: Manifest, file: string = MANIFEST_LOCK_PATH): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export interface LockedSplit {
  manifest: Manifest;
  split: SplitResult;
  /** True when this call froze a new manifest (and wrote the lock). */
  frozeNow: boolean;
}

/**
 * Load path when a lock exists (salt reused, dataset hash must match, split re-derived from the stored T);
 * freeze path otherwise (fresh salt from node:crypto, lock written with 'wx').
 */
export async function loadOrFreezeManifest(
  dataset: Dataset,
  report: ValidationReport,
  opts: { seed: number; file?: string } & QOptions,
): Promise<LockedSplit> {
  const file = opts.file ?? MANIFEST_LOCK_PATH;
  const stored = await readManifestLock(file);
  if (stored !== null) {
    const loaded = loadManifest(stored, { datasetHash: dataset.hashes.datasetHash });
    if (!loaded.ok) throw new Error(`${file}: ${loaded.error}`);
    const re = splitFromManifest(dataset, loaded.manifest);
    if (!re.ok) throw new Error(`${file}: ${re.error}`);
    return { manifest: loaded.manifest, split: re.split, frozeNow: false };
  }
  const { decision, split } = temporalSplit(dataset.interactions, opts);
  const manifest = freezeManifest(
    { dataset, report, decision, split },
    { randomSaltHex: randomSaltHex(), frozenAt: new Date().toISOString() },
  );
  await writeManifestLock(manifest, file);
  return { manifest, split, frozeNow: true };
}
