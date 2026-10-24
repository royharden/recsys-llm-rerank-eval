// MovieLens 100K parsers (u.data, u.item) with line-numbered rejects and size bounds (PLAN §3). Pure: bytes/text in, data out.
import { z } from 'zod';
import { hashCanonical, sha256Hex } from '../util/hash.ts';
import { GENRES, type Genre } from './types.ts';
import type { Dataset, DatasetHashes, Interaction, Item, LoadResult, Reject, ValidationReport } from './types.ts';

export interface Limits {
  maxUDataBytes: number;
  maxUItemBytes: number;
  /** Maximum u.data lines. ML-100K has 100,000. */
  maxRows: number;
  /** Maximum u.item lines. ML-100K has 1,682. */
  maxItems: number;
  maxLineChars: number;
  maxTitleChars: number;
  maxReportedRejects: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxUDataBytes: 16 * 1024 * 1024,
  maxUItemBytes: 2 * 1024 * 1024,
  maxRows: 200_000,
  maxItems: 10_000,
  maxLineChars: 1_000,
  maxTitleChars: 300,
  maxReportedRejects: 1_000,
};

const U_ITEM_FIELDS = 5 + GENRES.length; // id|title|release|video release|IMDb URL|19 flags

// ---------- byte decoding ----------

/** ISO-8859-1 decode, implemented manually: each byte is one code point U+0000..U+00FF. */
// Strict ISO-8859-1 (byte = code point). Do not replace with TextDecoder('latin1'): that is windows-1252 and remaps 0x80-0x9F.
export function latin1Decode(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return s;
}

/** ISO-8859-1 encode; throws on code points above U+00FF. */
export function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new Error(`latin1Encode: U+${c.toString(16)} at index ${i} is not latin-1`);
    out[i] = c;
  }
  return out;
}

/** Split into lines; tolerates CRLF and a single trailing newline (which does not count as a line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------- row schemas ----------

const posIntStr = z.string().regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer').transform(Number);

export const UDataRowSchema = z.object({
  userId: posIntStr,
  itemId: posIntStr,
  rating: z.string().regex(/^[1-5]$/, 'must be an integer 1..5').transform(Number),
  ts: z.string().regex(/^[0-9]{1,15}$/, 'must be a non-negative integer').transform(Number),
});

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const RELEASE_DATE = new RegExp(`^(?:[0-3][0-9]-(?:${MONTHS})-[0-9]{4})?$`);

export function makeUItemRowSchema(maxTitleChars: number) {
  return z.object({
    itemId: posIntStr,
    title: z.string().trim().min(1, 'must not be empty').max(maxTitleChars, `must be at most ${maxTitleChars} characters`),
    releaseDate: z.string().regex(RELEASE_DATE, 'must be dd-Mon-yyyy or empty'),
    genres: z.array(z.enum(['0', '1'], { errorMap: () => ({ message: 'genre flags must be 0 or 1' }) })).length(GENRES.length),
  });
}

const FIELD_NAMES: Record<string, string> = {
  userId: 'user id',
  itemId: 'item id',
  rating: 'rating',
  ts: 'timestamp',
  title: 'title',
  releaseDate: 'release date',
  genres: 'genre flags',
};

function describeIssue(err: z.ZodError, values: Record<string, unknown>): string {
  const issue = err.issues[0];
  const field = String(issue.path[0] ?? '');
  const raw = values[field];
  const shown = typeof raw === 'string' ? ` (got "${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}")` : '';
  return `invalid ${FIELD_NAMES[field] ?? field}: ${issue.message}${shown}`;
}

// ---------- u.data ----------

export interface ParsedRow extends Interaction {
  line: number;
}

export interface ParsedUData {
  rows: ParsedRow[];
  rejects: Reject[];
  lineCount: number;
}

/** Row-level validation of u.data (`user \t item \t rating \t ts`). Cross-file checks happen in loadDataset. */
export function parseUData(text: string, limits: Limits = DEFAULT_LIMITS): ParsedUData {
  const lines = splitLines(text);
  const rows: ParsedRow[] = [];
  const rejects: Reject[] = [];
  const reject = (line: number, reason: string): void => {
    rejects.push({ file: 'u.data', line, reason });
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.length > limits.maxLineChars) return reject(line, `line too long (> ${limits.maxLineChars} characters)`);
    if (raw.trim() === '') return reject(line, 'empty line');
    const f = raw.split('\t');
    if (f.length !== 4) return reject(line, `expected 4 tab-separated fields, got ${f.length}`);
    const values = { userId: f[0], itemId: f[1], rating: f[2], ts: f[3] };
    const parsed = UDataRowSchema.safeParse(values);
    if (!parsed.success) return reject(line, describeIssue(parsed.error, values));
    rows.push({ ...parsed.data, line });
  });
  return { rows, rejects, lineCount: lines.length };
}

// ---------- u.item ----------

export interface ParsedUItem {
  /** Accepted items, ascending itemId. */
  items: Item[];
  rejects: Reject[];
  lineCount: number;
}

/** Parse u.item bytes (latin-1, pipe-separated). Identical duplicate ids keep the first; conflicting duplicates reject every copy. */
export function parseUItem(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): ParsedUItem {
  const lines = splitLines(latin1Decode(bytes));
  const schema = makeUItemRowSchema(limits.maxTitleChars);
  const rejects: Reject[] = [];
  const reject = (line: number, reason: string): void => {
    rejects.push({ file: 'u.item', line, reason });
  };
  const byId = new Map<number, { line: number; item: Item; key: string }[]>();
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.length > limits.maxLineChars) return reject(line, `line too long (> ${limits.maxLineChars} characters)`);
    if (raw.trim() === '') return reject(line, 'empty line');
    const f = raw.split('|');
    if (f.length !== U_ITEM_FIELDS) return reject(line, `expected ${U_ITEM_FIELDS} pipe-separated fields, got ${f.length}`);
    const values = { itemId: f[0], title: f[1], releaseDate: f[2], genres: f.slice(5) };
    const parsed = schema.safeParse(values);
    if (!parsed.success) return reject(line, describeIssue(parsed.error, values));
    const { itemId, title, releaseDate, genres: flags } = parsed.data;
    const genres: Genre[] = GENRES.filter((_, g) => flags[g] === '1');
    const year = releaseDate === '' ? null : Number(releaseDate.slice(-4));
    const item: Item = { itemId, title, year, genres };
    const key = JSON.stringify([title, releaseDate, flags]);
    const list = byId.get(itemId);
    if (list) list.push({ line, item, key });
    else byId.set(itemId, [{ line, item, key }]);
  });
  const items: Item[] = [];
  for (const [itemId, list] of byId) {
    if (list.length === 1) {
      items.push(list[0].item);
    } else if (list.every((e) => e.key === list[0].key)) {
      items.push(list[0].item);
      for (const e of list.slice(1)) reject(e.line, `duplicate item id ${itemId} (identical to line ${list[0].line})`);
    } else {
      const at = list.map((e) => e.line).join(', ');
      for (const e of list) reject(e.line, `conflicting duplicate item id ${itemId} (lines ${at})`);
    }
  }
  items.sort((a, b) => a.itemId - b.itemId);
  rejects.sort((a, b) => a.line - b.line);
  return { items, rejects, lineCount: lines.length };
}

// ---------- dataset ----------

/** datasetHash = sha256(canonicalJson({ uData: sha256(u.data bytes), uItem: sha256(u.item bytes) })) — no salt (PLAN §3). */
export function computeDatasetHashes(uData: Uint8Array, uItem: Uint8Array): DatasetHashes {
  const h = { uData: sha256Hex(uData), uItem: sha256Hex(uItem) };
  return { ...h, datasetHash: hashCanonical(h) };
}

function emptyReport(rejects: Reject[] = [], limit = DEFAULT_LIMITS.maxReportedRejects): ValidationReport {
  return { rows: 0, users: 0, items: 0, ratedItems: 0, minTs: null, maxTs: null, rejectCount: rejects.length, rejects: rejects.slice(0, limit) };
}

export interface RawFiles {
  uData: Uint8Array;
  uItem: Uint8Array;
}

/** Validate and combine both files. Empty, oversized or fully rejected input yields `{ ok: false }` and no dataset. */
export function loadDataset(files: RawFiles, limits: Limits = DEFAULT_LIMITS): LoadResult {
  const fail = (error: string, report = emptyReport([], limits.maxReportedRejects)): LoadResult => ({ ok: false, error, report });
  if (files.uData.length === 0) return fail('u.data is empty');
  if (files.uItem.length === 0) return fail('u.item is empty');
  if (files.uData.length > limits.maxUDataBytes) return fail(`u.data exceeds ${limits.maxUDataBytes} bytes`);
  if (files.uItem.length > limits.maxUItemBytes) return fail(`u.item exceeds ${limits.maxUItemBytes} bytes`);

  const pItem = parseUItem(files.uItem, limits);
  if (pItem.lineCount > limits.maxItems) return fail(`u.item has more than ${limits.maxItems} lines`);
  // u.data is ASCII; latin-1 decoding is lossless and any non-ASCII byte fails the field patterns with a line number.
  const pData = parseUData(latin1Decode(files.uData), limits);
  if (pData.lineCount > limits.maxRows) return fail(`u.data has more than ${limits.maxRows} lines`);

  const itemById = new Map<number, Item>(pItem.items.map((it) => [it.itemId, it]));
  const dataRejects = pData.rejects.slice();
  const seen = new Map<string, number>();
  const interactions: Interaction[] = [];
  for (const r of pData.rows) {
    if (!itemById.has(r.itemId)) {
      dataRejects.push({ file: 'u.data', line: r.line, reason: `item ${r.itemId} missing from u.item` });
      continue;
    }
    const pair = `${r.userId}|${r.itemId}`;
    const first = seen.get(pair);
    if (first !== undefined) {
      dataRejects.push({ file: 'u.data', line: r.line, reason: `duplicate (user ${r.userId}, item ${r.itemId}); first seen on line ${first}` });
      continue;
    }
    seen.set(pair, r.line);
    interactions.push({ userId: r.userId, itemId: r.itemId, rating: r.rating, ts: r.ts });
  }
  dataRejects.sort((a, b) => a.line - b.line);
  const rejects = [...pItem.rejects, ...dataRejects];

  const users = new Set<number>();
  const rated = new Set<number>();
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const x of interactions) {
    users.add(x.userId);
    rated.add(x.itemId);
    if (x.ts < minTs) minTs = x.ts;
    if (x.ts > maxTs) maxTs = x.ts;
  }
  const report: ValidationReport = {
    rows: interactions.length,
    users: users.size,
    items: pItem.items.length,
    ratedItems: rated.size,
    minTs: interactions.length ? minTs : null,
    maxTs: interactions.length ? maxTs : null,
    rejectCount: rejects.length,
    rejects: rejects.slice(0, limits.maxReportedRejects),
  };
  if (pItem.items.length === 0) return fail('u.item has no valid rows', report);
  if (interactions.length === 0) return fail('u.data has no valid interactions', report);

  const dataset: Dataset = {
    interactions,
    items: pItem.items,
    itemById,
    hashes: computeDatasetHashes(files.uData, files.uItem),
  };
  return { ok: true, dataset, report };
}
