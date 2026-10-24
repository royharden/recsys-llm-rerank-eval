import { describe, expect, it } from 'vitest';
import { latin1Decode, loadDataset } from '../../src/core/data/movielens.ts';
import {
  ANCHOR_TS,
  ANCHOR_USERS,
  DUPLICATE_TITLE,
  FIXTURE_KINDS,
  FORMAT_CHAOS_MODES,
  generateSynthetic,
  INJECTION_TITLE,
  SYNTHETIC_ITEMS,
  SYNTHETIC_SEED,
  SYNTHETIC_USERS,
  TRAP_KINDS,
  trapsSidecar,
  type TrapRecord,
} from '../../src/core/data/synthetic.ts';
import { temporalSplit, type UserSplit } from '../../src/core/split/temporal.ts';
import { utf8Encode } from '../../src/core/util/sha256.ts';

const fx = generateSynthetic(SYNTHETIC_SEED);
const loaded = loadDataset({ uData: utf8Encode(fx.uData), uItem: fx.uItem });
if (!loaded.ok) throw new Error(`synthetic fixture failed to load: ${loaded.error}`);
const ds = loaded.dataset;
const { decision, split } = temporalSplit(ds.interactions, { seed: SYNTHETIC_SEED });

function trap<K extends TrapRecord['kind']>(kind: K): Extract<TrapRecord, { kind: K }> {
  const t = fx.traps.find((x): x is Extract<TrapRecord, { kind: K }> => x.kind === kind);
  if (!t) throw new Error(`missing trap ${kind}`);
  return t;
}
function user(u: number): UserSplit {
  const s = split.users.get(u);
  if (!s) throw new Error(`no user ${u}`);
  return s;
}
const historyOf = (u: number): number[] => user(u).history.map((r) => r.itemId);
const targetOf = (u: number): number | undefined => user(u).target?.itemId;
const title = (i: number): string | undefined => ds.itemById.get(i)?.title;
const genres = (i: number): string[] => ds.itemById.get(i)?.genres ?? [];

// Pre-T structure computed independently of the generator.
const preUsersByItem = new Map<number, Set<number>>();
for (const r of ds.interactions) {
  if (r.ts >= split.T) continue;
  const s = preUsersByItem.get(r.itemId) ?? new Set<number>();
  s.add(r.userId);
  preUsersByItem.set(r.itemId, s);
}
const prePop = (i: number): number => preUsersByItem.get(i)?.size ?? 0;
const cooccur = (a: number, b: number): boolean => {
  const A = preUsersByItem.get(a);
  const B = preUsersByItem.get(b);
  return !!A && !!B && [...A].some((u) => B.has(u));
};
const catalogue = new Set(split.catalogue);
const eligible = new Set(split.eligibleUserIds);

describe('synthetic generator: purity and shape', () => {
  it('same seed gives identical bytes and traps', () => {
    const again = generateSynthetic(SYNTHETIC_SEED);
    expect(again.uData).toBe(fx.uData);
    expect([...again.uItem]).toEqual([...fx.uItem]);
    expect(JSON.stringify(trapsSidecar(again))).toBe(JSON.stringify(trapsSidecar(fx)));
  });

  it('a different seed gives different data', () => {
    expect(generateSynthetic(SYNTHETIC_SEED + 1).uData).not.toBe(fx.uData);
  });

  it(`loads cleanly as ${SYNTHETIC_USERS} users x ${SYNTHETIC_ITEMS} items`, () => {
    expect(loaded.report.rejectCount).toBe(0);
    expect(loaded.report.users).toBe(SYNTHETIC_USERS);
    expect(loaded.report.items).toBe(SYNTHETIC_ITEMS);
    for (const line of fx.uData.trimEnd().split('\n')) expect(line).toMatch(/^\d+\t\d+\t[1-5]\t\d+$/);
  });

  it('u.item is latin-1 (one title carries byte 0xE9)', () => {
    expect(fx.uItem.includes(0xe9)).toBe(true);
    expect(ds.items.some((i) => i.title === 'Café des Étoiles')).toBe(true);
  });

  it('trap tags appear only in the sidecar, never in the data files', () => {
    const itemText = latin1Decode(fx.uItem);
    for (const kind of [...TRAP_KINDS, ...FIXTURE_KINDS]) {
      expect(fx.uData.includes(kind)).toBe(false);
      expect(itemText.includes(kind)).toBe(false);
    }
    expect(itemText.toLowerCase().includes('trap')).toBe(false);
  });

  it('emits all nine trap kinds plus k-shortage and duplicate-metadata-different-id, once each', () => {
    const kinds = fx.traps.map((t) => t.kind).sort();
    expect(kinds).toEqual([...TRAP_KINDS, ...FIXTURE_KINDS].sort());
    expect(trapsSidecar(fx).traps).toBe(fx.traps);
  });
});

describe('synthetic generator: the cut is pinned by the anchor cohort', () => {
  it('T = ANCHOR_TS for every q candidate', () => {
    for (const t of decision.trials) expect(t.T).toBe(ANCHOR_TS);
    expect(split.T).toBe(ANCHOR_TS);
  });

  it('is flagged insufficient_precision (150 users cannot give 150 held-out)', () => {
    expect(decision.insufficientPrecision).toBe(true);
    expect(split.heldoutUserIds.length).toBeLessThan(150);
  });

  it('anchor users are excluded for insufficient history', () => {
    expect(fx.anchor.userIds).toHaveLength(ANCHOR_USERS);
    for (const u of fx.anchor.userIds) expect(user(u).exclusion).toBe('insufficient_history');
  });

  it('every trap user with a userId is eligible', () => {
    for (const t of fx.traps) if ('userId' in t) expect(eligible.has(t.userId)).toBe(true);
    for (const a of trap('format-chaos').assignments) expect(eligible.has(a.userId)).toBe(true);
  });
});

describe('synthetic traps are structurally true under the real split', () => {
  it('popularity-decoy: niche target that co-occurs with history and is outside mostpop top-10', () => {
    const t = trap('popularity-decoy');
    const h = new Set(historyOf(t.userId));
    expect(targetOf(t.userId)).toBe(t.targetItemId);
    expect(catalogue.has(t.targetItemId)).toBe(true);
    for (const c of t.clusterItemIds.filter((i) => i !== t.targetItemId)) expect(h.has(c)).toBe(true);
    expect([...h].some((i) => cooccur(i, t.targetItemId))).toBe(true);
    const tp = prePop(t.targetItemId);
    const ahead = split.catalogue.filter((i) => !h.has(i) && (prePop(i) > tp || (prePop(i) === tp && i < t.targetItemId)));
    expect(ahead.length).toBeGreaterThanOrEqual(10);
  });

  it('recency-sequel: last three history items are the franchise, target is the next sequel', () => {
    const t = trap('recency-sequel');
    const h = historyOf(t.userId);
    expect(targetOf(t.userId)).toBe(t.targetItemId);
    expect(h.slice(-3)).toEqual(t.lastHistoryItemIds);
    const tg = genres(t.targetItemId);
    for (const i of t.lastHistoryItemIds) {
      expect(genres(i).some((g) => tg.includes(g))).toBe(true);
      expect(title(i)?.startsWith('Star Quest')).toBe(true);
    }
    expect(title(t.targetItemId)).toBe('Star Quest IV');
    // Only the recent items point at the target: no earlier history item shares a genre with it.
    for (const i of h.slice(0, -3)) expect(genres(i).some((g) => tg.includes(g))).toBe(false);
  });

  it('ceiling-miss: target in catalogue with zero co-occurrence, while >= 30 other candidates co-occur', () => {
    const t = trap('ceiling-miss');
    const h = historyOf(t.userId);
    const hs = new Set(h);
    expect(targetOf(t.userId)).toBe(t.targetItemId);
    expect(catalogue.has(t.targetItemId)).toBe(true);
    for (const i of h) expect(cooccur(i, t.targetItemId)).toBe(false);
    const scored = split.catalogue.filter((c) => !hs.has(c) && h.some((i) => cooccur(i, c)));
    expect(scored.length).toBeGreaterThanOrEqual(30);
  });

  it('cold-target: target has no pre-T interaction', () => {
    const t = trap('cold-target');
    expect(targetOf(t.userId)).toBe(t.targetItemId);
    expect(prePop(t.targetItemId)).toBe(0);
    expect(catalogue.has(t.targetItemId)).toBe(false);
    expect(split.coldTargetUserIds).toContain(t.userId);
  });

  it('duplicate-titles: two ids, one title, both candidates-in-principle', () => {
    const t = trap('duplicate-titles');
    expect(t.targetItemId).not.toBe(t.twinItemId);
    expect(title(t.targetItemId)).toBe(DUPLICATE_TITLE);
    expect(title(t.twinItemId)).toBe(DUPLICATE_TITLE);
    expect(targetOf(t.userId)).toBe(t.targetItemId);
    expect(catalogue.has(t.targetItemId) && catalogue.has(t.twinItemId)).toBe(true);
    const h = historyOf(t.userId);
    expect(h.includes(t.targetItemId) || h.includes(t.twinItemId)).toBe(false);
  });

  it('tie-timestamps: equal-ts target rows resolve to the smaller item id, against file order', () => {
    const t = trap('tie-timestamps');
    const rows = ds.interactions.filter((r) => r.userId === t.userId && r.ts === t.ts);
    expect(rows.map((r) => r.itemId).sort((a, b) => a - b)).toEqual(t.tiedItemIds);
    expect(t.ts).toBeGreaterThanOrEqual(split.T);
    expect(targetOf(t.userId)).toBe(Math.min(...t.tiedItemIds));
    expect(t.targetItemId).toBe(Math.min(...t.tiedItemIds));
    const lines = fx.uData.split('\n');
    const pos = (item: number) => lines.indexOf(lines.find((l) => l.startsWith(`${t.userId}\t${item}\t`)) ?? '');
    expect(pos(Math.max(...t.tiedItemIds))).toBeLessThan(pos(Math.min(...t.tiedItemIds)));
    // History tie: both rows share a ts and appear in item-id order.
    const h = user(t.userId).history.filter((r) => r.ts === t.historyTs).map((r) => r.itemId);
    expect(h).toEqual(t.historyTiedItemIds);
  });

  it('title-injection: the injection item is in the catalogue and is a candidate-in-principle for the user', () => {
    const t = trap('title-injection');
    expect(t.title).toBe(INJECTION_TITLE);
    expect(title(t.itemId)).toBe(INJECTION_TITLE);
    expect(catalogue.has(t.itemId)).toBe(true);
    expect(historyOf(t.userId)).not.toContain(t.itemId);
    expect(targetOf(t.userId)).not.toBe(t.itemId);
    expect(prePop(t.itemId)).toBeGreaterThanOrEqual(10);
  });

  it('k-shortage: |catalogue \\ history| < 20', () => {
    const t = trap('k-shortage');
    const h = new Set(historyOf(t.userId));
    const available = split.catalogue.filter((i) => !h.has(i)).length;
    expect(available).toBeLessThanOrEqual(t.maxAvailable);
    expect(available).toBeLessThan(20);
  });

  it('duplicate-metadata-different-id: identical metadata, distinct accepted ids', () => {
    const t = trap('duplicate-metadata-different-id');
    const [a, b] = t.itemIds.map((i) => ds.itemById.get(i));
    expect(t.itemIds[0]).not.toBe(t.itemIds[1]);
    expect(a).toBeDefined();
    expect({ ...a, itemId: 0 }).toEqual({ ...b, itemId: 0 });
  });

  it('format-chaos and planted-position-bias are recorded as mock behaviours', () => {
    const fc = trap('format-chaos');
    expect(fc.behaviour).toBe('mock');
    expect(fc.assignments.map((a) => a.mode).sort()).toEqual([...FORMAT_CHAOS_MODES].sort());
    const pb = trap('planted-position-bias');
    expect(pb).toMatchObject({ behaviour: 'mock', preset: 'planted-bias', controlPreset: 'unbiased' });
    expect(pb.positionBias).toBeGreaterThan(0);
    expect(pb.positionBias).toBeLessThanOrEqual(1);
  });
});
