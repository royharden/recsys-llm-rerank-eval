// Hand-checkable toy dataset shared by arm/metric/tuning tests (not a test file itself).
//
// Pre-T (T = 100) binary matrix:
//   u1: 1 2 3     u2: 1 2     u3: 2 3 4     u4: 4 5     u5: 8     u6: 9     u7: 7     u8: 7
// popularity (distinct users): 1:2  2:3  3:2  4:2  5:1  7:2  8:1  9:1   Σ = 14;  item 6 is never rated pre-T (cold).
// catalogue = [1, 2, 3, 4, 5, 7, 8, 9]
// cosine: s(1,2) = 2/√6 ≈ .8165, s(1,3) = 1/2, s(2,3) = 2/√6, s(2,4) = 1/√6 ≈ .4082, s(3,4) = 1/2, s(4,5) = 1/√2 ≈ .7071,
//         every other pair 0.
import type { Genre, Interaction, Item } from '../../src/core/data/types.ts';

export const T = 100;

const PRE: [number, number[]][] = [
  [1, [1, 2, 3]],
  [2, [1, 2]],
  [3, [2, 3, 4]],
  [4, [4, 5]],
  [5, [8]],
  [6, [9]],
  [7, [7]],
  [8, [7]],
];

export function toyRows(): Interaction[] {
  const rows: Interaction[] = [];
  let ts = 1;
  for (const [userId, items] of PRE) for (const itemId of items) rows.push({ userId, itemId, rating: 4, ts: ts++ });
  return rows;
}

/** Rows at or after T: must never change anything the baselines compute. */
export function postTRows(): Interaction[] {
  return [
    { userId: 1, itemId: 5, rating: 5, ts: 150 },
    { userId: 4, itemId: 1, rating: 5, ts: T }, // ts == T is post-T
    { userId: 9, itemId: 1, rating: 3, ts: 200 },
    { userId: 9, itemId: 6, rating: 3, ts: 201 },
    { userId: 5, itemId: 9, rating: 3, ts: 202 },
  ];
}

const GENRES_OF: Record<number, Genre[]> = {
  1: ['Action'],
  2: ['Comedy'],
  3: ['Action', 'Comedy'],
  4: ['Drama'],
  5: ['Action'],
  6: ['Horror'],
  7: ['Comedy'],
  8: ['Drama'],
  9: [],
};

export function toyItems(): Item[] {
  return [1, 2, 3, 4, 5, 6, 7, 8, 9].map((itemId) => ({
    itemId,
    title: `Movie ${itemId}`,
    year: 1990 + itemId,
    genres: GENRES_OF[itemId].slice(),
  }));
}

export function toyItemById(): Map<number, Item> {
  return new Map(toyItems().map((it): [number, Item] => [it.itemId, it]));
}

export const S12 = 2 / Math.sqrt(6);
export const S24 = 1 / Math.sqrt(6);
export const S45 = 1 / Math.sqrt(2);
