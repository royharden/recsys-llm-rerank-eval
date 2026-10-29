// Training data for the baselines (PLAN §3), built from PRE-T interactions only (rows with ts >= T are dropped here,
// so no caller can leak post-T information into popularity, similarities or neighbour lists).
//
// - catalogue: items with >= 1 pre-T interaction, ascending id (same definition as SplitResult.catalogue).
// - popularity: pre-T distinct-user count per catalogue item.
// - sim: item–item cosine on the binary user×item matrix, cos(a,b) = co(a,b) / sqrt(pop(a)·pop(b)); built from sparse
//   per-user co-occurrence into a dense Float32Array over the catalogue index (n² floats; ML-100K ≈ 1,682² ≈ 11 MB).
//   Diagonal is 0 (an item is never its own neighbour).
// - neighbours: for every item, its positive-similarity neighbours sorted by sim desc → popularity desc → item id asc,
//   truncated at maxNeighbours (default 100 = the largest finite k in the grid). Zero-similarity "neighbours" add 0 to any
//   score, so dropping them leaves every score unchanged.
import { GENRES } from '../contracts/types.ts';
import type { Interaction, Item } from '../data/types.ts';

export const DEFAULT_MAX_NEIGHBOURS = 100;
export const GENRE_COUNT = GENRES.length;

export interface TrainingData {
  /** The cut: only rows with ts < T were used. */
  readonly T: number;
  /** Catalogue item ids, ascending. */
  readonly catalogue: readonly number[];
  /** itemId → catalogue index. */
  readonly index: ReadonlyMap<number, number>;
  /** Pre-T distinct-user count, by catalogue index. */
  readonly popularity: Int32Array;
  /** Σ popularity over the catalogue (novelty denominator). */
  readonly totalPopularity: number;
  /** Catalogue indices sorted by popularity desc, then item id asc (mostpop order, head set). */
  readonly popularityOrder: Int32Array;
  /** Dense n×n cosine matrix, row-major by catalogue index. */
  readonly sim: Float32Array;
  readonly maxNeighbours: number;
  /** Flat n×maxNeighbours neighbour indices; only the first neighbourCount[i] entries of row i are meaningful. */
  readonly neighbours: Int32Array;
  readonly neighbourCount: Int32Array;
  /** Flat n×19 binary genre matrix by catalogue index (0 rows for items missing from u.item). */
  readonly genres: Uint8Array;
  /** Number of pre-T interactions used. */
  readonly rows: number;
}

export interface TrainingOptions {
  maxNeighbours?: number;
}

function itemsMap(items: readonly Item[] | ReadonlyMap<number, Item>): ReadonlyMap<number, Item> {
  if (items instanceof Map) return items;
  const m = new Map<number, Item>();
  for (const it of items as readonly Item[]) m.set(it.itemId, it);
  return m;
}

export function buildTrainingData(
  interactions: readonly Interaction[],
  T: number,
  items: readonly Item[] | ReadonlyMap<number, Item>,
  opts: TrainingOptions = {},
): TrainingData {
  const maxNeighbours = opts.maxNeighbours ?? DEFAULT_MAX_NEIGHBOURS;
  if (!Number.isInteger(maxNeighbours) || maxNeighbours < 1) throw new Error(`buildTrainingData: bad maxNeighbours ${maxNeighbours}`);

  // Binary pre-T matrix as user → set of item ids.
  const byUser = new Map<number, Set<number>>();
  const cat = new Set<number>();
  let rows = 0;
  for (const r of interactions) {
    if (!(r.ts < T)) continue;
    rows++;
    cat.add(r.itemId);
    let s = byUser.get(r.userId);
    if (!s) {
      s = new Set<number>();
      byUser.set(r.userId, s);
    }
    s.add(r.itemId);
  }
  const catalogue = [...cat].sort((a, b) => a - b);
  const n = catalogue.length;
  const index = new Map<number, number>();
  catalogue.forEach((id, i) => index.set(id, i));

  const popularity = new Int32Array(n);
  const sim = new Float32Array(n * n);
  // Users in ascending id order so accumulation is deterministic regardless of input row order.
  for (const userId of [...byUser.keys()].sort((a, b) => a - b)) {
    const idx = [...(byUser.get(userId) as Set<number>)].map((id) => index.get(id) as number).sort((a, b) => a - b);
    for (let x = 0; x < idx.length; x++) {
      const a = idx[x];
      popularity[a]++;
      const row = a * n;
      for (let y = x + 1; y < idx.length; y++) sim[row + idx[y]] += 1; // co-occurrence count, upper triangle (exact in f32 below 2^24)
    }
  }
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const co = sim[a * n + b];
      const c = co > 0 ? co / Math.sqrt(popularity[a] * popularity[b]) : 0;
      sim[a * n + b] = c;
      sim[b * n + a] = c;
    }
    sim[a * n + a] = 0;
  }

  let totalPopularity = 0;
  for (let i = 0; i < n; i++) totalPopularity += popularity[i];

  const popOrder = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => popularity[b] - popularity[a] || catalogue[a] - catalogue[b],
  );
  const popularityOrder = Int32Array.from(popOrder);

  const neighbours = new Int32Array(n * maxNeighbours);
  const neighbourCount = new Int32Array(n);
  for (let a = 0; a < n; a++) {
    const row = a * n;
    const cand: number[] = [];
    for (let b = 0; b < n; b++) if (b !== a && sim[row + b] > 0) cand.push(b);
    cand.sort((x, y) => sim[row + y] - sim[row + x] || popularity[y] - popularity[x] || catalogue[x] - catalogue[y]);
    const m = Math.min(maxNeighbours, cand.length);
    for (let j = 0; j < m; j++) neighbours[a * maxNeighbours + j] = cand[j];
    neighbourCount[a] = m;
  }

  const byId = itemsMap(items);
  const genres = new Uint8Array(n * GENRE_COUNT);
  for (let i = 0; i < n; i++) {
    const it = byId.get(catalogue[i]);
    if (!it) continue;
    for (const g of it.genres) {
      const gi = GENRES.indexOf(g);
      if (gi >= 0) genres[i * GENRE_COUNT + gi] = 1;
    }
  }

  return {
    T,
    catalogue,
    index,
    popularity,
    totalPopularity,
    popularityOrder,
    sim,
    maxNeighbours,
    neighbours,
    neighbourCount,
    genres,
    rows,
  };
}

/** Pre-T distinct-user count of an item (0 for items outside the catalogue, e.g. cold targets). */
export function popularityOf(train: TrainingData, itemId: number): number {
  const i = train.index.get(itemId);
  return i === undefined ? 0 : train.popularity[i];
}

/** Cosine similarity of two items (0 when either is outside the catalogue or a == b). */
export function similarity(train: TrainingData, a: number, b: number): number {
  const ia = train.index.get(a);
  const ib = train.index.get(b);
  if (ia === undefined || ib === undefined) return 0;
  return train.sim[ia * train.catalogue.length + ib];
}

/** The first `k` neighbour item ids of `itemId` (positive similarity only), best first. */
export function neighboursOf(train: TrainingData, itemId: number, k: number = train.maxNeighbours): number[] {
  const i = train.index.get(itemId);
  if (i === undefined) return [];
  const m = Math.min(k, train.neighbourCount[i]);
  const out: number[] = [];
  for (let j = 0; j < m; j++) out.push(train.catalogue[train.neighbours[i * train.maxNeighbours + j]]);
  return out;
}

/**
 * Head set: the top ceil(10% · |catalogue|) items by popularity desc, then id asc (PLAN §5 "head share").
 * Computed as ceil(n / 10) in exact arithmetic (n · 0.1 would give e.g. ceil(3.0000000000000004) = 4 for n = 30).
 */
export function headItems(train: TrainingData): Set<number> {
  const n = train.catalogue.length;
  const m = Math.ceil(n / 10);
  const out = new Set<number>();
  for (let j = 0; j < m && j < n; j++) out.add(train.catalogue[train.popularityOrder[j]]);
  return out;
}
