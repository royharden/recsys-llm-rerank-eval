import { describe, expect, it } from 'vitest';
import {
  computeDatasetHashes,
  DEFAULT_LIMITS,
  latin1Decode,
  latin1Encode,
  loadDataset,
  parseUData,
  parseUItem,
  type Limits,
} from '../../src/core/data/movielens.ts';
import type { LoadResult, Reject } from '../../src/core/data/types.ts';
import { canonicalJson } from '../../src/core/util/canonical-json.ts';
import { sha256Hex } from '../../src/core/util/hash.ts';

const flags = (on: number[] = [8]): string => Array.from({ length: 19 }, (_, i) => (on.includes(i) ? '1' : '0')).join('|');
const itemLine = (id: number | string, title = `Movie ${id}`, date = '01-Jan-1995', f = flags()): string =>
  `${id}|${title}|${date}||http://example.invalid/${id}|${f}`;
const GOOD_ITEMS = [1, 2, 3].map((id) => itemLine(id)).join('\n') + '\n';

const load = (uData: string, uItem: string = GOOD_ITEMS, limits: Limits = DEFAULT_LIMITS): LoadResult =>
  loadDataset({ uData: latin1Encode(uData), uItem: latin1Encode(uItem) }, limits);

const only = (r: LoadResult, file: Reject['file']): Reject[] => r.report.rejects.filter((x) => x.file === file);

describe('loadDataset: valid input', () => {
  it('accepts well-formed files and reports counts', () => {
    const r = load('1\t1\t5\t100\n1\t2\t3\t200\n2\t3\t4\t150\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report).toMatchObject({ rows: 3, users: 2, items: 3, ratedItems: 3, minTs: 100, maxTs: 200, rejectCount: 0 });
    expect(r.dataset.interactions[0]).toEqual({ userId: 1, itemId: 1, rating: 5, ts: 100 });
    expect(r.dataset.items.map((i) => i.itemId)).toEqual([1, 2, 3]);
    expect(r.dataset.itemById.get(2)?.title).toBe('Movie 2');
  });

  it('defines datasetHash as sha256(canonicalJson({uData: sha256(bytes), uItem: sha256(bytes)}))', () => {
    const uData = latin1Encode('1\t1\t5\t100\n');
    const uItem = latin1Encode(GOOD_ITEMS);
    const h = computeDatasetHashes(uData, uItem);
    expect(h.uData).toBe(sha256Hex(uData));
    expect(h.uItem).toBe(sha256Hex(uItem));
    expect(h.datasetHash).toBe(sha256Hex(canonicalJson({ uData: sha256Hex(uData), uItem: sha256Hex(uItem) })));
    const r = loadDataset({ uData, uItem });
    expect(r.ok && r.dataset.hashes).toEqual(h);
  });

  it('tolerates CRLF line endings and a missing trailing newline', () => {
    const r = load('1\t1\t5\t100\r\n2\t2\t4\t200');
    expect(r.ok).toBe(true);
    expect(r.report.rows).toBe(2);
  });
});

describe('loadDataset: u.data rejects (one test per malformed case, with line numbers)', () => {
  const cases: [string, string, RegExp][] = [
    ['too few fields', '1\t1\t5', /expected 4 tab-separated fields, got 3/],
    ['too many fields', '1\t1\t5\t100\t9', /expected 4 tab-separated fields, got 5/],
    ['space-separated row', '1 1 5 100', /expected 4 tab-separated fields, got 1/],
    ['non-integer user id', 'x\t1\t5\t100', /invalid user id/],
    ['zero user id', '0\t1\t5\t100', /invalid user id/],
    ['negative user id', '-1\t1\t5\t100', /invalid user id/],
    ['non-integer item id', '1\t1.5\t5\t100', /invalid item id/],
    ['rating above 5', '1\t1\t6\t100', /invalid rating: must be an integer 1\.\.5/],
    ['rating below 1', '1\t1\t0\t100', /invalid rating/],
    ['fractional rating', '1\t1\t3.5\t100', /invalid rating/],
    ['non-integer timestamp', '1\t1\t5\t12a', /invalid timestamp/],
    ['negative timestamp', '1\t1\t5\t-5', /invalid timestamp/],
    ['non-finite timestamp', '1\t1\t5\tInfinity', /invalid timestamp/],
    ['item missing from u.item', '1\t99\t5\t100', /item 99 missing from u\.item/],
    ['empty line', '', /empty line/],
    ['whitespace-only line', '  \t ', /empty line/],
  ];
  for (const [name, bad, reason] of cases) {
    it(`rejects ${name} on its line`, () => {
      const r = load(`1\t1\t5\t100\n${bad}\n2\t2\t4\t200\n`);
      expect(r.ok).toBe(true);
      const rej = only(r, 'u.data');
      expect(rej).toHaveLength(1);
      expect(rej[0].line).toBe(2);
      expect(rej[0].reason).toMatch(reason);
      expect(r.report.rows).toBe(2);
    });
  }

  it('rejects a duplicate (user, item) pair, keeping the first', () => {
    const r = load('1\t1\t5\t100\n2\t2\t4\t200\n1\t1\t3\t300\n');
    const rej = only(r, 'u.data');
    expect(rej).toEqual([{ file: 'u.data', line: 3, reason: 'duplicate (user 1, item 1); first seen on line 1' }]);
    expect(r.ok && r.dataset.interactions.find((x) => x.userId === 1 && x.itemId === 1)?.rating).toBe(5);
  });

  it('rejects over-long lines', () => {
    // parseUData directly: a 12-char bound would also reject every (longer) u.item line.
    const p = parseUData('1\t1\t5\t100\n1\t2\t5\t1000000000\n', { ...DEFAULT_LIMITS, maxLineChars: 12 });
    expect(p.rejects).toEqual([{ file: 'u.data', line: 2, reason: 'line too long (> 12 characters)' }]);
    expect(p.rows).toHaveLength(1);
  });

  it('caps the reported rejects but counts all of them', () => {
    const r = load('x\nx\nx\n1\t1\t5\t100\n', GOOD_ITEMS, { ...DEFAULT_LIMITS, maxReportedRejects: 1 });
    expect(r.report.rejectCount).toBe(3);
    expect(r.report.rejects).toHaveLength(1);
  });
});

describe('loadDataset: error results (no dataset, no run)', () => {
  it('empty u.data', () => {
    const r = load('');
    expect(r).toMatchObject({ ok: false, error: 'u.data is empty' });
  });

  it('empty u.item', () => {
    expect(load('1\t1\t5\t100\n', '')).toMatchObject({ ok: false, error: 'u.item is empty' });
  });

  it('all u.data rows rejected', () => {
    const r = load('1\t1\t9\t100\nbad\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no valid interactions/);
    expect(r.report.rejects.map((x) => x.line)).toEqual([1, 2]);
  });

  it('all u.item rows rejected', () => {
    const r = load('1\t1\t5\t100\n', 'nonsense\n');
    expect(r).toMatchObject({ ok: false, error: 'u.item has no valid rows' });
  });

  it('u.data over the byte bound', () => {
    const r = load('1\t1\t5\t100\n', GOOD_ITEMS, { ...DEFAULT_LIMITS, maxUDataBytes: 5 });
    expect(r).toMatchObject({ ok: false, error: 'u.data exceeds 5 bytes' });
  });

  it('u.item over the byte bound', () => {
    const r = load('1\t1\t5\t100\n', GOOD_ITEMS, { ...DEFAULT_LIMITS, maxUItemBytes: 5 });
    expect(r).toMatchObject({ ok: false, error: 'u.item exceeds 5 bytes' });
  });

  it('u.data over the row bound', () => {
    const r = load('1\t1\t5\t100\n1\t2\t5\t100\n1\t3\t5\t100\n', GOOD_ITEMS, { ...DEFAULT_LIMITS, maxRows: 2 });
    expect(r).toMatchObject({ ok: false, error: 'u.data has more than 2 lines' });
  });

  it('u.item over the row bound', () => {
    const r = load('1\t1\t5\t100\n', GOOD_ITEMS, { ...DEFAULT_LIMITS, maxItems: 2 });
    expect(r).toMatchObject({ ok: false, error: 'u.item has more than 2 lines' });
  });
});

describe('parseUItem', () => {
  const itemCases: [string, string, RegExp][] = [
    ['wrong field count', '9|Short|01-Jan-1995', /expected 24 pipe-separated fields, got 3/],
    ['non-integer item id', itemLine('x'), /invalid item id/],
    ['empty title', itemLine(9, '   '), /invalid title: must not be empty/],
    ['over-long title', itemLine(9, 't'.repeat(301)), /invalid title: must be at most 300 characters/],
    ['malformed release date', itemLine(9, 'T', '1995-01-01'), /invalid release date/],
    ['genre flag other than 0/1', itemLine(9, 'T', '01-Jan-1995', flags().replace(/^0/, '2')), /invalid genre flags/],
    ['empty line', '', /empty line/],
  ];
  for (const [name, bad, reason] of itemCases) {
    it(`rejects ${name} on its line`, () => {
      const p = parseUItem(latin1Encode(`${GOOD_ITEMS}${bad}\n${itemLine(4)}\n`));
      expect(p.rejects).toHaveLength(1);
      expect(p.rejects[0]).toMatchObject({ file: 'u.item', line: 4 });
      expect(p.rejects[0].reason).toMatch(reason);
      expect(p.items.map((i) => i.itemId)).toEqual([1, 2, 3, 4]);
    });
  }

  it('rejects every copy of a conflicting duplicate id, and its ratings become "missing"', () => {
    const r = load('1\t1\t5\t100\n1\t2\t5\t100\n', `${GOOD_ITEMS}${itemLine(2, 'Other Title')}\n`);
    expect(only(r, 'u.item')).toEqual([
      { file: 'u.item', line: 2, reason: 'conflicting duplicate item id 2 (lines 2, 4)' },
      { file: 'u.item', line: 4, reason: 'conflicting duplicate item id 2 (lines 2, 4)' },
    ]);
    expect(only(r, 'u.data')).toEqual([{ file: 'u.data', line: 2, reason: 'item 2 missing from u.item' }]);
  });

  it('keeps the first of identical duplicate ids and rejects the rest', () => {
    const p = parseUItem(latin1Encode(`${GOOD_ITEMS}${itemLine(2)}\n`));
    expect(p.rejects).toEqual([{ file: 'u.item', line: 4, reason: 'duplicate item id 2 (identical to line 2)' }]);
    expect(p.items).toHaveLength(3);
  });

  it('accepts different ids with identical metadata (not a duplicate)', () => {
    const p = parseUItem(latin1Encode(`${itemLine(1, 'Same')}\n${itemLine(2, 'Same')}\n`));
    expect(p.rejects).toEqual([]);
    expect(p.items.map((i) => i.title)).toEqual(['Same', 'Same']);
  });

  it('decodes latin-1 bytes manually (0xE9 -> U+00E9)', () => {
    const bytes = latin1Encode(`${itemLine(1, 'Café')}\n`);
    expect(bytes.includes(0xe9)).toBe(true);
    expect(bytes.includes(0xc3)).toBe(false);
    expect(parseUItem(bytes).items[0].title).toBe('Café');
  });

  it('maps release date to year (nullable) and flags to genre names in u.item order', () => {
    const p = parseUItem(latin1Encode(`${itemLine(1, 'Dated', '01-Jan-1995', flags([15, 1]))}\n${itemLine(2, 'Undated', '')}\n`));
    expect(p.items[0]).toEqual({ itemId: 1, title: 'Dated', year: 1995, genres: ['Action', 'Sci-Fi'] });
    expect(p.items[1].year).toBeNull();
    expect(p.items[1].genres).toEqual(['Drama']);
  });

  it('accepts ML-100K style "unknown" rows with empty dates and URL', () => {
    const p = parseUItem(latin1Encode(`267|unknown||||${flags([0])}\n`));
    expect(p.rejects).toEqual([]);
    expect(p.items[0]).toEqual({ itemId: 267, title: 'unknown', year: null, genres: ['unknown'] });
  });
});

describe('parseUData', () => {
  it('reports line numbers counting from 1 and ignores one trailing newline', () => {
    const p = parseUData('1\t1\t5\t100\nbad\n');
    expect(p.lineCount).toBe(2);
    expect(p.rows).toEqual([{ userId: 1, itemId: 1, rating: 5, ts: 100, line: 1 }]);
    expect(p.rejects[0].line).toBe(2);
  });
});

describe('latin-1 codec', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...latin1Encode(latin1Decode(all))]).toEqual([...all]);
  });

  it('refuses code points above U+00FF', () => {
    expect(() => latin1Encode('€')).toThrow(/not latin-1/);
  });
});
