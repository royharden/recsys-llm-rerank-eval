// Dataset types. Contract types (Genre, PromptItem, CandidateItem) live in contracts/ so the rerank function can vendor them.
import type { PromptItem } from '../contracts/types.ts';

export { GENRES } from '../contracts/types.ts';
export type { Genre, PromptItem, CandidateItem } from '../contracts/types.ts';

/** One accepted u.data row. Ratings are kept for validation/reporting only; no arm or prompt uses them. */
export interface Interaction {
  userId: number;
  itemId: number;
  rating: number;
  ts: number;
}

/** One accepted u.item row (raw title, not yet sanitised for prompts). Same shape as PromptItem. */
export type Item = PromptItem;

export type SourceFile = 'u.data' | 'u.item';

/** A rejected input line: 1-based line number in its file. */
export interface Reject {
  file: SourceFile;
  line: number;
  reason: string;
}

export interface ValidationReport {
  /** Accepted interactions. */
  rows: number;
  /** Distinct users among accepted interactions. */
  users: number;
  /** Accepted u.item entries. */
  items: number;
  /** Distinct items among accepted interactions. */
  ratedItems: number;
  minTs: number | null;
  maxTs: number | null;
  /** Total rejected lines (rejects[] may be truncated to MAX_REPORTED_REJECTS). */
  rejectCount: number;
  rejects: Reject[];
}

export interface DatasetHashes {
  /** sha256 of the u.data bytes. */
  uData: string;
  /** sha256 of the u.item bytes. */
  uItem: string;
  /** sha256(canonicalJson({ uData, uItem })) — salt-independent dataset identity (PLAN §3). */
  datasetHash: string;
}

export interface Dataset {
  /** Accepted interactions in file order. */
  interactions: Interaction[];
  /** Accepted items, ascending itemId. */
  items: Item[];
  itemById: ReadonlyMap<number, Item>;
  hashes: DatasetHashes;
}

export type LoadResult =
  | { ok: true; dataset: Dataset; report: ValidationReport }
  | { ok: false; error: string; report: ValidationReport };
