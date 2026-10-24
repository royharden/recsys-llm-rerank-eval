// In-memory ledger and response cache (local mock branch and the CLI mock path). Not persisted.
import { totalsOf, type CacheEntry, type CallRow, type Ledger, type ResponseCache, type RowFilter } from './types.ts';
import { CallRowSchema } from './schema.ts';

export function createMemoryLedger(initial: readonly CallRow[] = []): Ledger {
  const rows: CallRow[] = [];
  const ids = new Set<string>();
  const attempts = new Map<string, number>();
  const matches = (r: CallRow, f?: RowFilter): boolean =>
    (f?.runId === undefined || r.runId === f.runId) && (f?.arm === undefined || r.arm === f.arm);

  const ledger: Ledger = {
    append(input) {
      const row = CallRowSchema.parse(input);
      if (ids.has(row.id)) throw new Error(`ledger: duplicate row id ${row.id}`);
      const last = attempts.get(row.requestKey) ?? 0;
      if (row.attemptNo <= last) throw new Error(`ledger: attempt ${row.attemptNo} for ${row.requestKey} already recorded`);
      const copy: CallRow = { ...row, provenance: { ...row.provenance }, reportedUsage: row.reportedUsage ? { ...row.reportedUsage } : null };
      rows.push(copy);
      ids.add(row.id);
      attempts.set(row.requestKey, row.attemptNo);
      return { ...copy, provenance: { ...copy.provenance }, reportedUsage: copy.reportedUsage ? { ...copy.reportedUsage } : null };
    },
    rows(filter) {
      return rows.filter((r) => matches(r, filter)).map((r) => ({ ...r, provenance: { ...r.provenance }, reportedUsage: r.reportedUsage ? { ...r.reportedUsage } : null }));
    },
    totals(filter) {
      return totalsOf(rows.filter((r) => matches(r, filter)));
    },
    nextAttemptNo(requestKey) {
      return (attempts.get(requestKey) ?? 0) + 1;
    },
  };
  for (const r of initial) ledger.append(r);
  return ledger;
}

export function createMemoryCache(): ResponseCache {
  const entries = new Map<string, CacheEntry>();
  const clone = (e: CacheEntry): CacheEntry => ({
    ...e,
    finalOrder: e.finalOrder.slice(),
    rawLabelOrder: e.rawLabelOrder ? e.rawLabelOrder.slice() : null,
    probabilities: e.probabilities ? { ...e.probabilities } : null,
    repairs: { ...e.repairs },
    usage: e.usage ? { ...e.usage } : null,
  });
  return {
    get(cacheKey) {
      const e = entries.get(cacheKey);
      return Promise.resolve(e ? clone(e) : null);
    },
    put(entry) {
      if (!entries.has(entry.cacheKey)) entries.set(entry.cacheKey, clone(entry));
      return Promise.resolve();
    },
  };
}
