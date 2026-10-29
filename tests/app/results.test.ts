import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ARM_IDS, zeroRepairs } from '../../src/core/arms/types.ts';
import { buildTrainingData } from '../../src/core/arms/train.ts';
import { loadDataset } from '../../src/core/data/movielens.ts';
import { generateSynthetic } from '../../src/core/data/synthetic.ts';
import { reconstructLocalInspection } from '../../src/core/report/local-inspection.ts';
import { MOCK_STAMP } from '../../src/core/report/results-md.ts';
import { buildReport } from '../../src/core/report/table.ts';
import type { ResultRow, RunIdentity } from '../../src/core/runner/store.ts';
import { computeManifestHash, freezeManifest, userKeyOf } from '../../src/core/split/manifest.ts';
import { temporalSplit } from '../../src/core/split/temporal.ts';
import { completedResultsMarkdown } from '../../src/app/results-export.ts';
import { FailureList, Results } from '../../src/app/pages/Results.tsx';
import { Inspector } from '../../src/app/pages/Inspector.tsx';
import { Run } from '../../src/app/pages/Run.tsx';
import type { ConsoleState } from '../../src/app/state.ts';

const generated = generateSynthetic(38);
const loaded = loadDataset({ uData: new TextEncoder().encode(generated.uData), uItem: generated.uItem });
if (!loaded.ok) throw new Error(loaded.error);
const { dataset, report: validation } = loaded;
const { decision, split } = temporalSplit(dataset.interactions, { seed: 38 });
const manifest = freezeManifest({ dataset, report: validation, decision, split },
  { randomSaltHex: '0123456789abcdef0123456789abcdef', frozenAt: '2026-10-24T20:00:00.000Z' });
const identity: RunIdentity = { schemaVersion: 1, runId: 'named-failure-regression', mode: 'mock', split: 'heldout',
  datasetHash: manifest.datasetHash, manifestHash: manifest.manifestHash, configHash: 'c'.repeat(64), preregHash: null };
const userId = split.heldoutUserIds.find((id) => {
  const target = split.users.get(id)?.target;
  return target && split.catalogue.includes(target.itemId);
});
if (userId === undefined) throw new Error('Fixture needs a held-out non-cold target.');
const target = split.users.get(userId)!.target!;
const targetTitle = dataset.itemById.get(target.itemId)!.title;
const userKey = userKeyOf(manifest.salt, userId);
const candidates = [target.itemId, ...split.catalogue.filter((id) => id !== target.itemId).slice(0, 29)];
const demoted = [...candidates.slice(1, 11), target.itemId, ...candidates.slice(11)];
const rows: ResultRow[] = ARM_IDS.map((arm) => ({ runId: identity.runId, arm, variant: 'base', repeatIndex: 0, userKey,
  candidateIds: candidates, rankedIds: arm === 'llm-list' || arm === 'jev-point' ? demoted : candidates,
  presentedIds: [], kEff: candidates.length, flags: [], targetRank: arm === 'llm-list' || arm === 'jev-point' ? 11 : 1,
  inCandidates: true, targetPopularity: 1, coldTarget: false, repairs: zeroRepairs(), formatFailure: false, callIds: [] }));
const report = buildReport({ rows, calls: [], train: buildTrainingData(dataset.interactions, manifest.T, dataset.items),
  mode: 'mock', primaryArm: 'llm-list', seed: 38 });

function clickHandler(node: ReactNode, label: string): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.type === 'button' && node.props.children === label) return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const found = clickHandler(child, label); if (found) return found;
  }
  return undefined;
}

describe('named failure titles stay local and share Inspector reconstruction', () => {
  it('resolves the demoted target with the stored salt/T/seed and selected split, without enriching stored failures', () => {
    // what_bug_this_catches: Results rendered only ranks or guessed target titles from output position rather than local scoring targets.
    const before = JSON.stringify(report.failures);
    const local = reconstructLocalInspection(dataset, JSON.parse(JSON.stringify(manifest)), identity);
    expect(local?.users.get(userKey)?.target).toEqual(target);
    expect(local?.targetTitles.get(userKey)).toBe(targetTitle);
    expect(local?.users.has(userKeyOf(manifest.salt, split.devUserIds[0]))).toBe(false);
    const view = renderToStaticMarkup(createElement(FailureList, { failures: report.failures, local, setPage: vi.fn() }));
    expect(view).toContain('Demoted target title (local)');
    expect(view).toContain(renderToStaticMarkup(createElement('td', null, targetTitle)));
    expect(view).not.toContain('Reselect matching files');
    expect(JSON.stringify(report.failures)).toBe(before);
    expect(report.failures.every((failure) => !('targetTitle' in failure) && !('target' in failure))).toBe(true);
  });
  it('wires Results and Inspector to the same stored manifest rather than a newly loaded local manifest', () => {
    // what_bug_this_catches: one page used a fresh salt/manifest while the other honored the frozen run's user-key mapping.
    const app = { output: { identity, complete: true, report, rows, calls: [] }, run: { config: { manifest } }, plan: null,
      data: { dataset, manifest: { ...manifest, salt: 'f'.repeat(32) } }, setPage: vi.fn() } as unknown as ConsoleState;
    expect(renderToStaticMarkup(createElement(Results, { app }))).toContain(renderToStaticMarkup(createElement('td', null, targetTitle)));
    expect(renderToStaticMarkup(createElement(Inspector, { app }))).toContain(renderToStaticMarkup(createElement('strong', null, targetTitle)));
  });
  it('refuses missing files, changed dataset/file hashes, manifest contents and a different frozen manifest identity', () => {
    // what_bug_this_catches: stale titles from another dataset or a new salt were silently attached to stored pseudonymous failures.
    expect(reconstructLocalInspection(null, manifest, identity)).toBeNull();
    expect(reconstructLocalInspection(dataset, null, identity)).toBeNull();
    expect(reconstructLocalInspection({ ...dataset, hashes: { ...dataset.hashes, datasetHash: 'a'.repeat(64) } }, manifest, identity)).toBeNull();
    for (const file of ['uData', 'uItem'] as const) expect(reconstructLocalInspection({ ...dataset,
      hashes: { ...dataset.hashes, [file]: 'a'.repeat(64) } }, manifest, identity)).toBeNull();
    const swappedSalt = { ...manifest, salt: 'f'.repeat(32) };
    expect(reconstructLocalInspection(dataset, swappedSalt, identity)).toBeNull();
    expect(reconstructLocalInspection(dataset, { ...swappedSalt, manifestHash: computeManifestHash(swappedSalt) }, identity)).toBeNull();
    const wrongCounts = { ...manifest, counts: { ...manifest.counts, heldout: manifest.counts.heldout + 1 } };
    const rehashed = { ...wrongCounts, manifestHash: computeManifestHash(wrongCounts) };
    expect(reconstructLocalInspection(dataset, rehashed, { ...identity, manifestHash: rehashed.manifestHash })).toBeNull();
  });
  it('shows unavailable titles and redirects to Data to reselect matching files', () => {
    // what_bug_this_catches: the missing-title state offered only generic Inspector navigation, leaving no recovery from Results.
    const setPage = vi.fn();
    const local = reconstructLocalInspection({ ...dataset, hashes: { ...dataset.hashes, uItem: 'a'.repeat(64) } }, manifest, identity);
    const tree = FailureList({ failures: report.failures, local, setPage });
    const view = renderToStaticMarkup(tree);
    expect(view).toContain('Target titles unavailable. Reselect the original source files with matching hashes in Data.');
    expect(view).toContain('Unavailable — reselect matching files in Data');
    expect(view).not.toContain(renderToStaticMarkup(createElement('td', null, targetTitle)));
    const recover = clickHandler(tree, 'Reselect matching files'); expect(recover).toBeTypeOf('function');
    recover!(); expect(setPage).toHaveBeenCalledTimes(1); expect(setPage).toHaveBeenCalledWith('Data');
  });
});

describe('completed Markdown export provenance and console defaults', () => {
  it('exports self-contained MOCK run identity and hashes without local target titles or manifest salt', () => {
    // what_bug_this_catches: renaming an exported Markdown file lost its only run identity and lineage; MOCK must remain explicit.
    const markdown = completedResultsMarkdown({ identity, complete: true, report });
    expect(markdown).toContain(MOCK_STAMP);
    for (const field of [`Run ID: \`${identity.runId}\``, 'Split: heldout', 'Mode: mock', 'Complete: true',
      `Dataset hash: \`${identity.datasetHash}\``, `Manifest hash: \`${identity.manifestHash}\``,
      `Config hash: \`${identity.configHash}\``, 'Preregistration hash: none (not preregistered)']) expect(markdown).toContain(field);
    expect(markdown).not.toContain(manifest.salt);
    expect(markdown).not.toContain(targetTitle);
    expect(markdown).toContain(userKey);
  });
  it('keeps dev-live exploratory and includes the held-out preregistration hash', () => {
    // what_bug_this_catches: a dev report inherited the core writer's held-out stamp, or omitted held-out preregistration lineage.
    const liveReport = { ...report, mode: 'live' as const };
    const dev = completedResultsMarkdown({ identity: { ...identity, mode: 'live', split: 'dev' }, complete: true, report: liveReport });
    expect(dev).toContain('DEV LIVE: exploratory selection, not held-out evidence');
    expect(dev).toContain('Split: dev'); expect(dev).toContain('Mode: live');
    expect(dev).not.toContain('Held-out live evaluation'); expect(dev).not.toContain('HELD-OUT LIVE');
    const preregHash = 'd'.repeat(64);
    const heldout = completedResultsMarkdown({ identity: { ...identity, mode: 'live', preregHash }, complete: true, report: liveReport });
    expect(heldout).toContain('HELD-OUT LIVE'); expect(heldout).toContain(`Preregistration hash: \`${preregHash}\``);
  });
  it('refuses incomplete final exports and keeps retained-row status visible without download controls', () => {
    // what_bug_this_catches: a stale/non-null report accidentally exposed final downloads while completion was false.
    expect(() => completedResultsMarkdown({ identity, complete: false, report })).toThrow(/Complete the frozen run/);
    expect(() => completedResultsMarkdown({ identity, complete: true, report: null })).toThrow(/Complete the frozen run/);
    const app = { output: { identity, complete: false, report, rows, calls: [] }, data: null, run: null, plan: null,
      setPage: vi.fn() } as unknown as ConsoleState;
    const view = renderToStaticMarkup(createElement(Results, { app }));
    expect(view).toContain(`Incomplete run: ${rows.length} rows and 0 attempts retained.`);
    expect(view).not.toContain('Download computed Markdown'); expect(view).not.toContain('Download JSONL');
  });
  it('starts with the proposed run/arm caps and the overlapping $2 probe cap', () => {
    // what_bug_this_catches: the initially displayed overlapping probe cap drifted from the frozen PLAN's $2 proposal to $3.
    const app = { branch: 'local', run: null, plan: null, data: null, busy: null, output: null, progress: null,
      canCancel: false } as unknown as ConsoleState;
    const view = renderToStaticMarkup(createElement(Run, { app }));
    for (const [label, value] of [['Run', '5'], ['llm-list', '4'], ['jev-point', '1'], ['probe', '2']]) {
      expect(view).toMatch(new RegExp(`${label} cap<input[^>]*value="${value}"`));
    }
  });
});
