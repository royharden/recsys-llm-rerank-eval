import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openJsonlStore } from '../../src/core/node/jsonl-store.ts';
import type { ResultRow, RunIdentity } from '../../src/core/runner/store.ts';
import { zeroRepairs } from '../../src/core/arms/types.ts';

it('reopens a checkpoint with immutable rows; changed identity and a truncated crash record fail closed', async () => {
  // what_bug_this_catches: salt/config changes silently resume an unrelated result file, or partial JSON is ignored.
  const dir = await mkdtemp(path.join(tmpdir(), 's38-checkpoint-'));
  try {
    const file = path.join(dir, 'results.jsonl');
    const identity: RunIdentity = { schemaVersion: 1, runId: 'mock-checkpoint', mode: 'mock', split: 'heldout',
      datasetHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64), configHash: 'c'.repeat(64), preregHash: null };
    const row: ResultRow = { runId: identity.runId, arm: 'itemknn', variant: 'base', repeatIndex: 0, userKey: 'd'.repeat(16),
      candidateIds: [1], rankedIds: [1], presentedIds: [], kEff: 1, flags: ['short_list'], targetRank: 1,
      inCandidates: true, targetPopularity: 2, coldTarget: false, repairs: zeroRepairs(), formatFailure: false, callIds: [] };
    const first = await openJsonlStore(file, identity); await first.put(row);
    const resumed = await openJsonlStore(file, identity); expect(await resumed.get(row)).toEqual(row);
    await expect(openJsonlStore(file, { ...identity, manifestHash: 'e'.repeat(64) })).rejects.toThrow('identity mismatch');
    await expect(resumed.put({ ...row, targetRank: null })).rejects.toThrow('immutable');
    await appendFile(file, '{"type":"result","value":');
    await expect(openJsonlStore(file, identity)).rejects.toThrow('corrupt JSONL');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
