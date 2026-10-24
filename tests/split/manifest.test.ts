import { describe, expect, it } from 'vitest';
import { generateSynthetic } from '../../src/core/data/synthetic.ts';
import { loadDataset } from '../../src/core/data/movielens.ts';
import {
  computeManifestHash,
  freezeManifest,
  loadManifest,
  splitFromManifest,
  userKeyOf,
  type Manifest,
} from '../../src/core/split/manifest.ts';
import { temporalSplit } from '../../src/core/split/temporal.ts';
import { canonicalJson } from '../../src/core/util/canonical-json.ts';
import { sha256Hex } from '../../src/core/util/hash.ts';
import { utf8Encode } from '../../src/core/util/sha256.ts';

const SALT = '0123456789abcdef0123456789abcdef';
const SALT2 = 'fedcba9876543210fedcba9876543210';
const AT1 = '2026-10-24T20:00:00.000Z';
const AT2 = '2026-11-01T08:30:00.000Z';

const fx = generateSynthetic(38);
const uData = utf8Encode(fx.uData);
const loaded = loadDataset({ uData, uItem: fx.uItem });
if (!loaded.ok) throw new Error(loaded.error);
const { dataset, report } = loaded;
const { decision, split } = temporalSplit(dataset.interactions, { seed: 38 });
const input = { dataset, report, decision, split };
const frozen = freezeManifest(input, { randomSaltHex: SALT, frozenAt: AT1 });
const roundTrip = (m: Manifest): unknown => JSON.parse(JSON.stringify(m));

describe('freezeManifest', () => {
  it('records q, T, seed, hashes, counts and the supplied salt', () => {
    expect(frozen).toMatchObject({
      schemaVersion: 1,
      seed: 38,
      q: decision.q,
      T: decision.T,
      insufficientPrecision: decision.insufficientPrecision,
      datasetHash: dataset.hashes.datasetHash,
      files: { uData: sha256Hex(uData), uItem: sha256Hex(fx.uItem) },
      salt: SALT,
      frozenAt: AT1,
    });
    expect(frozen.qTrials).toEqual(decision.trials);
    expect(frozen.counts).toMatchObject({
      interactions: dataset.interactions.length,
      users: 150,
      items: 300,
      catalogue: split.catalogue.length,
      eligible: split.eligibleUserIds.length,
      dev: split.devUserIds.length,
      heldout: split.heldoutUserIds.length,
      coldTargets: split.coldTargetUserIds.length,
      exclusions: split.exclusions,
      rejectedLines: 0,
    });
  });

  it('datasetHash = sha256(canonicalJson({uData, uItem})) and is salt-independent', () => {
    expect(frozen.datasetHash).toBe(sha256Hex(canonicalJson({ uData: sha256Hex(uData), uItem: sha256Hex(fx.uItem) })));
    expect(freezeManifest(input, { randomSaltHex: SALT2, frozenAt: AT1 }).datasetHash).toBe(frozen.datasetHash);
  });

  it('manifestHash excludes frozenAt', () => {
    const later = freezeManifest(input, { randomSaltHex: SALT, frozenAt: AT2 });
    expect(later.frozenAt).not.toBe(frozen.frozenAt);
    expect(later.manifestHash).toBe(frozen.manifestHash);
    expect(computeManifestHash(frozen)).toBe(frozen.manifestHash);
  });

  it('manifestHash covers the salt', () => {
    expect(freezeManifest(input, { randomSaltHex: SALT2, frozenAt: AT1 }).manifestHash).not.toBe(frozen.manifestHash);
  });

  it('requires a caller-supplied 16-byte hex salt (the core never generates one)', () => {
    for (const bad of ['', 'xyz', SALT.toUpperCase(), SALT.slice(0, 30), `${SALT}00`]) {
      expect(() => freezeManifest(input, { randomSaltHex: bad, frozenAt: AT1 })).toThrow(/randomSaltHex/);
    }
  });

  it('rejects a split that does not belong to the decision', () => {
    expect(() => freezeManifest({ ...input, split: { ...split, T: split.T + 1 } }, { randomSaltHex: SALT, frozenAt: AT1 })).toThrow();
  });
});

describe('loadManifest (stored path)', () => {
  it('reuses the stored salt unchanged, so userKeys are stable across reloads', () => {
    const r = loadManifest(roundTrip(frozen), { datasetHash: dataset.hashes.datasetHash });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest).toEqual(frozen);
    expect(r.manifest.salt).toBe(SALT);
    for (const u of split.heldoutUserIds.slice(0, 5)) expect(userKeyOf(r.manifest.salt, u)).toBe(userKeyOf(SALT, u));
  });

  it('refuses a manifest whose contents no longer match manifestHash', () => {
    const tampered = roundTrip(frozen) as Manifest;
    tampered.counts.heldout += 1;
    expect(loadManifest(tampered)).toMatchObject({ ok: false, error: expect.stringMatching(/manifestHash/) });
    const swapped = { ...(roundTrip(frozen) as Manifest), salt: SALT2 };
    expect(loadManifest(swapped)).toMatchObject({ ok: false, error: expect.stringMatching(/manifestHash/) });
  });

  it('accepts a changed frozenAt (not hashed)', () => {
    expect(loadManifest({ ...(roundTrip(frozen) as Manifest), frozenAt: AT2 }).ok).toBe(true);
  });

  it('refuses a different dataset', () => {
    const r = loadManifest(roundTrip(frozen), { datasetHash: 'f'.repeat(64) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/datasetHash differs/) });
  });

  it('refuses schema violations (unknown field, missing salt)', () => {
    expect(loadManifest({ ...(roundTrip(frozen) as Manifest), extra: 1 }).ok).toBe(false);
    const noSalt: Record<string, unknown> = { ...(roundTrip(frozen) as Manifest) };
    delete noSalt.salt;
    expect(loadManifest(noSalt)).toMatchObject({ ok: false, error: expect.stringMatching(/salt/) });
    expect(loadManifest(null).ok).toBe(false);
  });
});

describe('splitFromManifest', () => {
  it('re-derives the identical split from the stored T and seed', () => {
    const r = splitFromManifest(dataset, frozen);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.split.T).toBe(frozen.T);
    expect(r.split.devUserIds).toEqual(split.devUserIds);
    expect(r.split.heldoutUserIds).toEqual(split.heldoutUserIds);
  });

  it('refuses a dataset with a different hash', () => {
    const other = { ...dataset, hashes: { ...dataset.hashes, datasetHash: '0'.repeat(64) } };
    expect(splitFromManifest(other, frozen).ok).toBe(false);
  });

  it('refuses when the counts are not reproduced', () => {
    const wrong = { ...frozen, counts: { ...frozen.counts, heldout: frozen.counts.heldout + 1 } };
    expect(splitFromManifest(dataset, wrong).ok).toBe(false);
  });
});

describe('userKeyOf', () => {
  it('is the first 16 hex of sha256(salt|userId)', () => {
    expect(userKeyOf(SALT, 42)).toBe(sha256Hex(`${SALT}|42`).slice(0, 16));
    expect(userKeyOf(SALT, 42)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes with the salt', () => {
    expect(userKeyOf(SALT, 42)).not.toBe(userKeyOf(SALT2, 42));
  });
});
