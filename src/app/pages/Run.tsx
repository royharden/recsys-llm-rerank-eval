import { useState } from 'react';
import { PreregSchema, type Prereg } from '../../core/prereg/schema.ts';
import { formatMicro } from '../../core/budget/estimate.ts';
import { PRICE_TABLE } from '../../core/contracts/prices.ts';
import type { ConsoleState } from '../state.ts';
import type { Caps, DesignOptions } from '../workers/protocol.ts';
import { Header, Empty, Json, Table } from '../components/common.tsx';

export function Run({ app }: { app: ConsoleState }) {
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [split, setSplit] = useState<'dev' | 'heldout'>('heldout');
  const [preset, setPreset] = useState<'unbiased' | 'planted-bias'>('unbiased');
  const [prompt, setPrompt] = useState<'llm-list.v1' | 'llm-list.v2'>('llm-list.v1');
  const [primary, setPrimary] = useState<'llm-list' | 'jev-point'>('llm-list');
  const [capText, setCapText] = useState({ total: '5', 'llm-list': '4', 'jev-point': '1', probe: '2' });
  const [prereg, setPrereg] = useState<Prereg | null>(null); const [devDiffs, setDevDiffs] = useState<number[]>([]);
  const [attested, setAttested] = useState(false); const [approvalToken, setApprovalToken] = useState('');
  const [importError, setImportError] = useState(''); const [runId, setRunId] = useState('');
  const actualMode = app.branch === 'local' ? 'mock' : mode;
  const caps = Object.fromEntries(Object.entries(capText).map(([key, text]) => [key, text.trim() === '' ? NaN : Math.round(Number(text) * 1e6)])) as unknown as Caps;
  const capsValid = Object.values(caps).every((n) => Number.isSafeInteger(n) && n >= 0);
  const options = (selectMock: boolean): DesignOptions => ({ mode: actualMode, split, preset, prompt, primary, caps,
    selectMock, prereg: actualMode === 'live' && split === 'heldout' ? prereg : null, devDiffs });
  const p = app.plan;
  const token = app.run && p ? `${app.run.id}:${p.estimateHash}` : '';
  const blocked = !p || p.design.issues.length > 0 || (p.identity.mode === 'mock' && !p.design.selected);
  const authBlocked = app.branch === 'persisted' && (!app.session || !app.configured);
  return <><Header eyebrow="02 / Run" title="Freeze the comparison before it starts">Dry run is the default. Review the exact schedule, verification status and worst-case liability before creating a draft, approving it, or starting calls.</Header>
    <section className="card"><h2>Experiment protocol</h2><p>All six arms run on the same users: mostpop, itemknn, random-rerank, tuned-rerank, llm-list and jev-point.</p><p>Frozen probes: history shuffle, reversed candidates, shuffled candidates, masked titles, identical repeat, and Jev question-order shuffle. Probe sample: min(150, n), seeded. Arms and probes cannot be deselected.</p><p className="muted">A model can reorder the candidate pool; its shared ceiling is the fraction of targets in that pool. K is chosen by the dev ceiling rule from 20 or 30 with the full budget bound.</p></section>
    {app.branch === 'persisted' && <section className="card"><h2>Load a saved run</h2><div className="actions"><button className="secondary" disabled={!!app.busy || authBlocked} onClick={() => void app.refreshRuns()}>Refresh my runs</button><label>Run ID<input value={runId} onChange={(e) => setRunId(e.target.value)} disabled={!!app.busy} /></label><button className="secondary" disabled={!!app.busy || authBlocked || !runId.trim()} onClick={() => void app.selectRun(runId.trim())}>Load by ID</button></div>
      {app.runs.length > 0 && <Table caption="Your persisted runs" headings={['Run', 'Mode / split', 'State', 'Action']}>{app.runs.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.mode} / {r.split}</td><td>{r.state}</td><td><button className="secondary" disabled={!!app.busy} onClick={() => void app.selectRun(r.id)}>Load frozen run</button></td></tr>)}</Table>}
    </section>}
    {!app.run && <section className="card"><h2>New design</h2>{!app.data && <Empty>Load and validate data first. <button className="secondary" onClick={() => app.setPage('Data')}>Open Data</button></Empty>}
      <fieldset disabled={!!app.busy || !!p}><legend>Run choices</legend><div className="grid two">
        <label>Split<select value={split} onChange={(e) => setSplit(e.target.value as typeof split)}><option value="dev">Dev — exploratory selection</option><option value="heldout">Held-out — frozen comparison</option></select></label>
        <label>Provider mode<select value={actualMode} disabled={app.branch === 'local'} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="mock">Mock — simulated, $0</option><option value="live">Live — approved remote provider calls</option></select></label>
        {actualMode === 'mock' ? <label>Mock behavior<select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}><option value="unbiased">Unbiased control</option><option value="planted-bias">Planted position bias</option></select></label> : <>
          {split === 'dev' && <><label>Live dev prompt trial<select value={prompt} onChange={(e) => setPrompt(e.target.value as typeof prompt)}><option value="llm-list.v1">v1 — plain</option><option value="llm-list.v2">v2 — recency focused</option></select></label><label>Provisional dev summary primary<select value={primary} onChange={(e) => setPrimary(e.target.value as typeof primary)}><option value="llm-list">llm-list</option><option value="jev-point">jev-point</option></select></label><p className="notice warning">Dev reports are exploratory. Run both prompt trials with live providers, choose the better prompt and primary on dev NDCG@10 (ties: v1, then llm-list), smoke-test probes, and date the frozen preregistration before any held-out run.</p></>}
          {split === 'heldout' && <><label>Dated preregistration JSON (or {'{prereg, devDiffs}'} package)<input type="file" accept=".json,application/json" onChange={(e) => {
            const file = e.target.files?.[0]; setPrereg(null); setDevDiffs([]); setAttested(false); setImportError(''); if (!file) return;
            void (async () => { try { if (file.size > 500000) throw new Error('Preregistration file is too large.'); const raw: unknown = JSON.parse(await file.text());
              const boxed = typeof raw === 'object' && raw !== null && 'prereg' in raw ? raw as { prereg: unknown; devDiffs?: unknown } : { prereg: raw };
              const parsed = PreregSchema.parse(boxed.prereg); const diffs = boxed.devDiffs ?? [];
              if (!Array.isArray(diffs) || diffs.length > 10000 || diffs.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('devDiffs must be a bounded array of finite paired differences.');
              if (parsed.config.mock) throw new Error('A mock-selected primary cannot be imported as live evidence.');
              setPrereg(parsed); setDevDiffs(diffs as number[]);
            } catch (err) { setImportError(err instanceof Error ? err.message : 'Invalid preregistration.'); } })();
          }} /></label>{prereg && <p>Dated {prereg.datedAt}; primary {prereg.config.primaryArm}; prompt {prereg.config.llmListPromptVersion}. Imported choices are owner supplied. {devDiffs.length === 0 && 'No dev differences supplied: MDE will be unavailable.'}</p>}
            <label><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /> I chose these frozen settings from live dev evidence and checked that the imported manifest matches. Mock results did not select the live primary.</label></>}
        </>}
      </div><h3>Maximum liability (USD)</h3><p className="muted">The probe cap overlaps both arm caps. The plan includes up to three attempts per call; no sampling or silent reduction fits a smaller cap.</p><div className="grid two">{(['total', 'llm-list', 'jev-point', 'probe'] as const).map((key) => <label key={key}>{key === 'total' ? 'Run' : key} cap<input type="number" min="0" step="0.000001" value={capText[key]} onChange={(e) => setCapText({ ...capText, [key]: e.target.value })} /></label>)}</div></fieldset>
      {importError && <p className="error" role="alert">{importError}</p>}
      <div className="actions"><button disabled={!!app.busy || !app.data || authBlocked || !capsValid || !!p || (actualMode === 'live' && split === 'heldout' && (!prereg || !attested))} onClick={() => void app.prepare(options(false))}>Compute dry run — no provider calls</button>
        {p && <button className="secondary" disabled={!!app.busy} onClick={app.resetRun}>Revise design</button>}
        {actualMode === 'mock' && <button className="secondary" disabled={!!app.busy || !app.data || authBlocked || !capsValid || !!p?.design.selected} onClick={() => void app.prepare(options(true))}>Select mock variants on dev + freeze design</button>}
      </div><p className="muted">Mock selection simulates both prompt variants and both model arms on dev. The initial dry run uses provisional v1/llm-list choices and makes no provider calls.</p>
    </section>}
    {app.run && <section className="card"><h2>Stored run: {app.run.state}</h2><p className="mono">{app.run.id}</p><p>{app.run.mode.toUpperCase()} / {app.run.split}; exact expected rows {app.run.config.expectedResults.length}; candidate schedule {app.run.config.candidateCounts.length} users.</p><p>Caps: run {formatMicro(app.run.cap_micro)}, llm-list {formatMicro(app.run.arm_caps['llm-list'])}, Jev {formatMicro(app.run.arm_caps['jev-point'])}, overlapping probes {formatMicro(app.run.arm_caps.probe)}.</p><p className="mono">Config {app.run.config_hash}<br />Prereg {app.run.prereg_hash ?? 'none (mock or dev)'}</p>
      <div className="actions"><button className="secondary" disabled={!!app.busy || !app.data || authBlocked} onClick={() => void app.dryStored()}>Recompute frozen dry run</button><button className="secondary" disabled={!!app.busy} onClick={app.resetRun}>New run</button></div>
    </section>}
    {p && <section className="card"><h2>{p.identity.mode === 'mock' ? 'MOCK / ' : ''}Dry-run call plan</h2><p>{p.design.estimate.displayLabel}. {p.design.estimate.boundLabel}. Network: {p.design.estimate.network}.</p><div className="metric-grid"><div className="metric-card"><span>Model requests</span><strong>{p.design.estimate.totals.calls}</strong></div><div className="metric-card"><span>Display estimate</span><strong>{formatMicro(p.design.estimate.totals.displayMicro)}</strong></div><div className="metric-card"><span>Worst-case bound</span><strong>{formatMicro(p.design.estimate.totals.worstCaseMicro)}</strong></div><div className="metric-card"><span>Expected results</span><strong>{p.config.expectedResults.length}</strong></div></div>
      <Table caption="Calls and bounds by arm and variant" headings={['Arm', 'Variant', 'Calls', 'Estimate', 'Worst case', 'Availability']}>{p.design.estimate.lines.map((l) => <tr key={`${l.arm}/${l.variant}`}><td>{l.arm}</td><td>{l.variant}</td><td>{l.calls}</td><td>{formatMicro(l.displayMicro)}</td><td>{formatMicro(l.worstCaseMicro)}</td><td>{l.unavailable ?? 'priced'}</td></tr>)}</Table>
      <p>Price table date: {PRICE_TABLE.datedAt}. Live starts require known prices, verified price/bound entries, immutable model pins and all caps to fit.</p>
      {p.design.issues.length > 0 ? <div className="notice warning"><strong>Start blocked</strong><ul>{p.design.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : <p className="success">The full worst-case plan fits all recorded caps.</p>}
      <p>Frozen k={p.design.frozen.knnK}; K={p.design.frozen.K}; weights {JSON.stringify(p.design.frozen.tunedWeights)}; prompt {p.design.frozen.llmListPromptVersion}; primary {p.design.frozen.primaryArm}{p.identity.split === 'dev' && p.identity.mode === 'live' ? ' (provisional dev summary)' : ''}.</p>
      {!p.design.selected && p.identity.mode === 'mock' && <p className="notice warning">Provisional dry design only. Select mock variants on dev before creating or executing this run.</p>}
      {p.design.tuning && <details><summary>Dev-only tuning evidence</summary><Json value={p.design.tuning} /></details>}
      <details><summary>Frozen identities and hashes</summary><Json value={{ identity: p.identity, estimateHash: p.estimateHash, expectedRows: p.config.expectedResults.length, candidateCounts: p.config.candidateCounts }} /></details>
      {app.branch === 'persisted' && !app.run && <button disabled={!!app.busy || blocked || authBlocked} onClick={() => void app.createDraft()}>Create exact frozen draft</button>}
    </section>}
    {app.run?.state === 'draft' && <section className="card"><h2>Explicit authenticated approval</h2><p>Approval records this run's immutable config, caps and local estimate hash. Approval alone sends no model requests.</p><label><input type="checkbox" checked={!!token && approvalToken === token} disabled={!!app.busy || blocked || authBlocked} onChange={(e) => setApprovalToken(e.target.checked ? token : '')} /> I approve this exact frozen plan and its maximum liability.</label><button disabled={!!app.busy || blocked || authBlocked || !token || approvalToken !== token} onClick={() => { setApprovalToken(''); void app.approve(); }}>Record approval</button></section>}
    <section className="card"><h2>Execute or resume</h2>{app.progress && <><progress value={app.progress.completed} max={app.progress.expected} aria-label="Completed result rows" /><p>{app.progress.completed} / {app.progress.expected} rows; {app.progress.resumed} already stored.</p></>}
      {app.output && !app.output.complete && <p className="notice warning">Incomplete: {app.output.rows.length} result rows and {app.output.calls.length} attempts retained. Resume keeps the same run ID and frozen settings.</p>}
      <div className="actions"><button disabled={!!app.busy || !app.data || authBlocked || (app.branch === 'persisted' ? !app.run || app.run.state === 'draft' || (app.run.state !== 'complete' && blocked) : blocked)} onClick={() => void app.execute()}>{app.run?.state === 'complete' ? 'Read completed results — no calls' : app.run?.state === 'incomplete' || (app.output && !app.output.complete) ? 'Resume same frozen run' : 'Start frozen run'}</button>
        {app.canCancel && <button className="danger" onClick={app.cancel}>Cancel current operation</button>}
      </div><p className="muted">Cancellation retains completed rows and marks persisted execution incomplete. Uncertain sent requests consume their bounds and require explicit review in Ledger before a safe retry.</p>
    </section>
  </>;
}
