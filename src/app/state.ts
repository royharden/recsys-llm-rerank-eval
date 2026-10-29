import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { RawFiles } from '../core/data/movielens.ts';
import type { ValidationReport } from '../core/data/types.ts';
import type { Manifest } from '../core/split/manifest.ts';
import { configHashOf, preregHashOf } from '../core/prereg/schema.ts';
import { createMemoryCache, createMemoryLedger } from '../core/ledger/memory.ts';
import { createMockProvider, createMockRerankClient, mockParams } from '../core/providers/mock.ts';
import { createEdgeRerankClient } from '../core/providers/edge.ts';
import { buildReport, type EvaluationReport } from '../core/report/table.ts';
import { createFrozenArms, reconstructFrozenEvaluation } from '../core/report/resume.ts';
import { runEvaluation } from '../core/runner/run.ts';
import { createMemoryResultStore, type ResultRow, type ResultStore, type RunIdentity } from '../core/runner/store.ts';
import type { CallRow } from '../core/ledger/types.ts';
import { hashCanonical } from '../core/util/hash.ts';
import { supabase, supabaseConfig, supabaseConfigError, activateBrowserSupabase } from '../lib/supabase.ts';
import { currentSession, observeSession, signIn, signUp, signOut, requestPasswordReset } from '../lib/session.ts';
import { preparePersistedConfig, runPersistedEvaluation } from '../lib/evaluation.ts';
import { approveRun, createDraftRun, loadPersistedRun, listPersistedRuns, listUncertainRequests,
  acknowledgeUncertain, createSupabaseStore } from '../lib/supabase-store.ts';
import { identityOfRun, type PersistedConfig, type PersistedRun } from '../lib/run-config.ts';
import { designIssues } from './workflow.ts';
import type { Design, DesignOptions, LoadedData, WorkerRequest, WorkerResponse } from './workers/protocol.ts';

export type Page = 'Setup' | 'Data' | 'Run' | 'Results' | 'Inspector' | 'Ledger';
export interface Plan { design: Design; options: DesignOptions; identity: RunIdentity; config: PersistedConfig; estimateHash: string }
export interface Output { identity: RunIdentity; frozen: PersistedConfig['frozen']; rows: ResultRow[]; calls: CallRow[];
  report: EvaluationReport | null; complete: boolean }

function clientFor(frozen: PersistedConfig['frozen'], data: LoadedData, ledger = createMemoryLedger()) {
  if (frozen.mock) {
    if (frozen.mock.forcedModesHash !== hashCanonical([...data.forcedModes].sort())) throw new Error('Synthetic traps differ from the frozen run.');
    const mock = createMockRerankClient({ adapter: createMockProvider(mockParams(frozen.mock.preset, frozen.mock.seed,
      { forcedModes: new Map(data.forcedModes) })), ledger, cache: createMemoryCache() });
    return { 'llm-list': mock, 'jev-point': mock };
  }
  if (!supabase || !supabaseConfig) throw new Error('Configure the public database connection and sign in for live runs.');
  return {
    'llm-list': createEdgeRerankClient({ client: supabase, ...supabaseConfig, provider: 'anthropic', model: frozen.models['llm-list'].model }),
    'jev-point': createEdgeRerankClient({ client: supabase, ...supabaseConfig, provider: 'typesafe', model: frozen.models['jev-point'].model }),
  };
}

export function useConsole() {
  const [page, setPage] = useState<Page>('Setup');
  const [branch, setBranch] = useState<'local' | 'persisted'>('local');
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [data, setData] = useState<LoadedData | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<PersistedRun | null>(null);
  const [runs, setRuns] = useState<PersistedRun[]>([]);
  const [output, setOutput] = useState<Output | null>(null);
  const [progress, setProgress] = useState<{ completed: number; expected: number; resumed: number } | null>(null);
  const [uncertain, setUncertain] = useState<Awaited<ReturnType<typeof listUncertainRequests>>>([]);
  const worker = useRef<Worker | null>(null);
  const pending = useRef<{ id: number; reject: (error: Error) => void } | null>(null);
  const serial = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const stores = useRef(new Map<string, ResultStore>());
  const owner = useRef<string | null>(null);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    abort.current?.abort();
    if (worker.current) { worker.current.terminate(); worker.current = null; }
    pending.current?.reject(new Error('Computation cancelled.')); pending.current = null;
  }, []);
  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    if (branch !== 'persisted') return;
    let active = true;
    const changed = (next: Session | null) => {
      if (!active) return;
      if (owner.current && owner.current !== next?.user.id) {
        generation.current++; cancel(); setRun(null); setRuns([]); setPlan(null); setOutput(null); setUncertain([]);
        setNotice('Your session ended or changed. Sign in again to reload persisted runs.');
      }
      owner.current = next?.user.id ?? null; setSession(next);
    };
    const cleanup = observeSession(supabase, changed);
    void currentSession(supabase).then(changed).catch((e: unknown) => { if (active) setError(messageOf(e)); });
    return () => { active = false; cleanup(); cancel(); };
  }, [branch, cancel]);

  async function perform(label: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(null); setNotice(null);
    try { await work(); } catch (e) { setError(messageOf(e)); }
    finally { setBusy(null); abort.current = null; }
  }
  function compute(request: Omit<Extract<WorkerRequest, { type: 'load' }>, 'id'> | Omit<Extract<WorkerRequest, { type: 'design' }>, 'id'>): Promise<WorkerResponse> {
    worker.current?.terminate();
    const instance = new Worker(new URL('./workers/compute.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    const id = ++serial.current;
    return new Promise((resolve, reject) => {
      pending.current = { id, reject };
      const finish = () => { instance.terminate(); if (worker.current === instance) worker.current = null; if (pending.current?.id === id) pending.current = null; };
      instance.onerror = () => { finish(); reject(new Error('Worker failed to load or compute. Check the application setup, then retry.')); };
      instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id || worker.current !== instance) return;
        const response = event.data; finish();
        if (response.type === 'error') { if (response.report) setValidation(response.report); reject(new Error(response.error)); }
        else resolve(response);
      };
      instance.postMessage({ ...request, id });
    });
  }
  function chooseBranch(next: 'local' | 'persisted') {
    if (busy || next === branch) return;
    if (next === 'persisted') {
      try { activateBrowserSupabase(); } catch { setError('Could not initialize the public database connection. Check configuration and retry.'); return; }
    } else { supabase?.auth.stopAutoRefresh(); setSession(null); owner.current = null; }
    generation.current++; setBranch(next); setRun(null); setPlan(null); setOutput(null); setProgress(null); setUncertain([]); setError(null);
    setNotice(next === 'local' ? 'Local mock selected. Reloading loses all local runs.' : 'Persisted mode selected. Database errors will be shown here.');
  }
  function resetRun() {
    if (busy) return;
    generation.current++; setRun(null); setPlan(null); setOutput(null); setUncertain([]); setProgress(null); setError(null);
  }
  function resetData() { if (!busy) { resetRun(); setData(null); setValidation(null); } }
  async function loadData(files: RawFiles | null, synthetic: boolean, imported: Manifest | null = null) {
    await perform('Validating data', async () => {
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, '0')).join('');
      const result = await compute({ type: 'load', files, synthetic, manifest: run?.config.manifest ?? imported ?? data?.manifest ?? null, salt, seed: 38 });
      if (result.type !== 'loaded') throw new Error('Unexpected worker response.');
      setData(result.data); setValidation(result.data.report); setPlan(null); setOutput(null);
      setNotice(run ? 'Files match the stored manifest. Resume uses its original salt, split and parameters.' : 'Validation passed. Files remain on this device.');
    });
  }
  async function prepare(options: DesignOptions) {
    await perform(options.selectMock ? 'Selecting mock choices on dev' : 'Computing dry run', async () => {
      if (!data) throw new Error('Load valid data first.');
      if (branch === 'local' && options.mode !== 'mock') throw new Error('Local mode supports simulated mock runs only.');
      if (run) throw new Error('Choose New run before changing an existing frozen run.');
      if (branch === 'persisted' && !session) throw new Error('Sign in before preparing a persisted run.');
      const result = await compute({ type: 'design', data, options });
      if (result.type !== 'designed') throw new Error('Unexpected worker response.');
      const design = result.design;
      const identity: RunIdentity = { schemaVersion: 1, runId: crypto.randomUUID(), mode: options.mode, split: options.split,
        datasetHash: data.dataset.hashes.datasetHash, manifestHash: data.manifest.manifestHash,
        configHash: configHashOf(design.frozen), preregHash: options.prereg && options.mode === 'live' && options.split === 'heldout' ? preregHashOf(options.prereg) : null };
      const config = preparePersistedConfig({ identity, dataset: data.dataset, manifest: data.manifest, frozen: design.frozen,
        prereg: identity.preregHash ? options.prereg : null, devDiffs: design.devDiffs, clients: clientFor(design.frozen, data) });
      setPlan({ design, options, identity, config, estimateHash: hashCanonical(design.estimate) }); setOutput(null); setProgress(null);
      setNotice('Dry run computed. No remote provider calls were made. Exact result keys are frozen for this design.');
    });
  }
  function assertPlan(): Plan {
    if (!plan || !data) throw new Error('Compute a dry run first.');
    const issues = designIssues(plan.design.estimate, plan.design.frozen, plan.identity.mode, plan.options.caps);
    if (issues.length) throw new Error(issues.join(' '));
    if (plan.identity.mode === 'mock' && !plan.design.selected) throw new Error('Select mock model choices on dev before freezing this run.');
    if (plan.identity.datasetHash !== data.dataset.hashes.datasetHash || plan.config.manifest.manifestHash !== data.manifest.manifestHash)
      throw new Error('Loaded data changed. Compute a new dry run.');
    return plan;
  }
  async function createDraft() {
    await perform('Creating frozen draft', async () => {
      const epoch = generation.current;
      if (branch !== 'persisted' || !supabase || !session) throw new Error('Choose persisted mode and sign in.');
      const p = assertPlan(); const caps = p.options.caps;
      const draft = await createDraftRun(supabase, { id: p.identity.runId, mode: p.identity.mode, split: p.identity.split,
        config: p.config, capMicro: caps.total, armCaps: { 'llm-list': caps['llm-list'], 'jev-point': caps['jev-point'], probe: caps.probe } });
      if (generation.current !== epoch) return;
      setRun(draft); setNotice('Draft saved. Review caps and approve explicitly before any execution.');
    });
  }
  async function estimateStored(current: PersistedRun) {
    const epoch = generation.current;
    if (!supabase || !supabaseConfig || !data) throw new Error('Sign in and reselect matching source files.');
    const check = await runPersistedEvaluation(supabase, supabaseConfig, current, data.dataset,
      { forcedModes: new Map(data.forcedModes), dryRun: true });
    if (!check.estimate) throw new Error('Missing dry-run estimate.');
    if (generation.current !== epoch) throw new Error('Session changed. Sign in and reload the same frozen run.');
    const caps = { total: current.cap_micro, ...current.arm_caps };
    const issues = designIssues(check.estimate, current.config.frozen, current.mode, caps);
    setPlan({ identity: check.identity, config: current.config, estimateHash: hashCanonical(check.estimate),
      options: { mode: current.mode, split: current.split, caps, preset: current.config.frozen.mock?.preset ?? 'unbiased',
        prompt: current.config.frozen.llmListPromptVersion, primary: current.config.frozen.primaryArm,
        prereg: current.config.prereg, devDiffs: current.config.devDiffs, selectMock: false },
      design: { frozen: current.config.frozen, estimate: check.estimate, issues, selected: true, devDiffs: current.config.devDiffs, tuning: null } });
    return { estimate: check.estimate, issues };
  }
  async function dryStored() { await perform('Checking frozen dry run', async () => { if (!run) throw new Error('Load a run first.'); await estimateStored(run); }); }
  async function approve() {
    await perform('Recording explicit approval', async () => {
      const epoch = generation.current;
      if (!supabase || !run || !session) throw new Error('Sign in and load a draft first.');
      const checked = await estimateStored(run);
      if (checked.issues.length) throw new Error(checked.issues.join(' '));
      const approved = await approveRun(supabase, run, { hash: hashCanonical(checked.estimate), micro: checked.estimate.totals.displayMicro ?? 0 });
      if (generation.current !== epoch) return;
      setRun(approved); setNotice('Approval recorded immutably. Start is a separate action.');
    });
  }
  async function refreshRuns() { await perform('Loading persisted runs', async () => {
    if (!supabase || !session) throw new Error('Sign in to list your persisted runs.');
    const epoch = generation.current; const saved = await listPersistedRuns(supabase);
    if (generation.current === epoch) setRuns(saved);
  }); }
  async function selectRun(id: string) { await perform('Loading frozen run', async () => {
    if (!supabase || !session) throw new Error('Sign in to load a run.');
    const epoch = generation.current;
    const selected = await loadPersistedRun(supabase, id);
    if (generation.current !== epoch) return;
    setRun(selected); setPlan(null); setData(null); setValidation(null); setOutput(null); setProgress(null); setUncertain([]); setPage('Data');
    setNotice('Reselect the original files or synthetic fixture. The stored manifest is authoritative; no retuning will occur.');
  }); }
  async function execute() {
    await perform(run?.state === 'complete' ? 'Reading completed run' : 'Evaluating frozen run', async () => {
      if (!data) throw new Error('Reselect validated matching files first.');
      const epoch = generation.current;
      const controller = new AbortController(); abort.current = controller;
      const onProgress = async (p: { completed: number; expected: number; resumed: number }) => {
        if (generation.current === epoch) setProgress(p);
        if (p.completed % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };
      if (branch === 'persisted') {
        if (!supabase || !supabaseConfig || !session || !run) throw new Error('Load and approve a persisted run first.');
        const current = await loadPersistedRun(supabase, run.id);
        if (current.state === 'draft') throw new Error('Explicit approval is required before start.');
        if (current.state !== 'complete') {
          const checked = await estimateStored(current);
          if (checked.issues.length) throw new Error(checked.issues.join(' '));
        }
        try {
          const result = await runPersistedEvaluation(supabase, supabaseConfig, current, data.dataset,
            { forcedModes: new Map(data.forcedModes), signal: controller.signal, onProgress });
          if (generation.current === epoch) { setOutput({ identity: result.identity, frozen: result.config, rows: result.rows, calls: result.calls, report: result.report, complete: true });
            setRun(await loadPersistedRun(supabase, run.id)); setPage('Results'); }
        } catch (e) {
          if (generation.current === epoch) {
            const fresh = await loadPersistedRun(supabase, current.id); setRun(fresh);
            const store = createSupabaseStore(supabase, fresh); await store.bind(identityOfRun(fresh));
            setOutput({ identity: identityOfRun(fresh), frozen: fresh.config.frozen, rows: await store.rows(), calls: await store.calls(), report: null, complete: false });
          }
          throw e;
        }
      } else {
        const p = assertPlan();
        let store = stores.current.get(p.identity.runId);
        if (!store) { store = createMemoryResultStore(); stores.current.set(p.identity.runId, store); }
        await store.bind(p.identity);
        const prepared = reconstructFrozenEvaluation(data.dataset, p.config.manifest, p.config.frozen, p.identity.split);
        const ledger = createMemoryLedger(await store.calls());
        const arms = createFrozenArms(prepared, p.identity, p.config.frozen, clientFor(p.config.frozen, data, ledger));
        let complete = false;
        try {
          await runEvaluation({ identity: p.identity, contexts: prepared.contexts, arms, probeUserKeys: prepared.probeUserKeys,
            store, ledger, evaluate: prepared.evaluate, signal: controller.signal, onProgress }); complete = true;
        } finally {
          const rows = await store.rows(); const calls = await store.calls();
          if (generation.current === epoch) setOutput({ identity: p.identity, frozen: p.config.frozen, rows, calls, complete,
            report: complete ? buildReport({ rows, calls, train: prepared.train, mode: 'mock', primaryArm: p.config.frozen.primaryArm,
              seed: p.config.frozen.seed, devDiffs: p.config.devDiffs }) : null });
        }
        setPage('Results');
      }
    });
  }
  async function refreshLedger() { await perform('Refreshing uncertain requests', async () => {
    if (!supabase || !session || !run) throw new Error('Load a persisted run first.');
    const epoch = generation.current;
    const unresolved = await listUncertainRequests(supabase, run.id);
    const store = createSupabaseStore(supabase, run); await store.bind(identityOfRun(run));
    const rows = await store.rows(); const calls = await store.calls();
    if (generation.current !== epoch) return;
    setUncertain(unresolved);
    setOutput((old) => ({ identity: identityOfRun(run), frozen: run.config.frozen, rows, calls,
      report: old?.identity.runId === run.id ? old.report : null, complete: run.state === 'complete' }));
  }); }
  async function acknowledge(key: string) { await perform('Acknowledging full-bound liability', async () => {
    if (!supabase || !session || !run) throw new Error('Sign in and load the persisted run.');
    const epoch = generation.current;
    await acknowledgeUncertain(supabase, run.id, key); const unresolved = await listUncertainRequests(supabase, run.id);
    if (generation.current !== epoch) return;
    setUncertain(unresolved);
    setNotice('Acknowledged. The full bound remains consumed. Resume is a separate explicit action. Refresh ledger to inspect the accounting.');
  }); }
  async function authenticate(action: 'signin' | 'signup' | 'reset' | 'signout', email = '', password = '') {
    await perform('Updating account', async () => {
      if (branch !== 'persisted') throw new Error('Choose persisted mode explicitly before account actions.');
      if (action === 'signout') await signOut(supabase);
      else if (action === 'reset') { await requestPasswordReset(supabase, email); setNotice('Password-reset request sent. Check your email.'); }
      else if (action === 'signup') { const next = await signUp(supabase, email, password); setSession(next); setNotice(next ? 'Account created and signed in.' : 'Check your email to confirm the account, then sign in.'); }
      else setSession(await signIn(supabase, email, password));
    });
  }
  const canCancel = !!busy && ['Validating data', 'Selecting mock choices on dev', 'Computing dry run', 'Evaluating frozen run'].includes(busy);
  return { page, setPage, branch, chooseBranch, session, configured: !!supabaseConfig, configError: supabaseConfigError, busy, canCancel, error, notice,
    data, validation, plan, run, runs, output, progress, uncertain, cancel, resetRun, resetData, loadData,
    prepare, createDraft, dryStored, approve, refreshRuns, selectRun, execute, refreshLedger, acknowledge, authenticate };
}
function messageOf(e: unknown): string { return e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String(e.message) : 'Action failed. Retry after checking the connection and session.'; }
export type ConsoleState = ReturnType<typeof useConsole>;
