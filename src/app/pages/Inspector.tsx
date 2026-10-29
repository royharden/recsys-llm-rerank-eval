import { useMemo, useState } from 'react';
import { reconstructLocalInspection } from '../../core/report/local-inspection.ts';
import type { ConsoleState } from '../state.ts';
import { Header, Empty, Table, Json } from '../components/common.tsx';

export function Inspector({ app }: { app: ConsoleState }) {
  const [chosen, setChosen] = useState(''); const [arm, setArm] = useState('llm-list'); const [variant, setVariant] = useState('base');
  const out = app.output;
  const manifest = app.run?.config.manifest ?? app.plan?.config.manifest;
  const dataset = app.data?.dataset;
  const local = useMemo(() => reconstructLocalInspection(dataset, manifest, out?.identity), [dataset, manifest, out?.identity]);
  const users = [...new Set(out?.rows.map((r) => r.userKey) ?? [])].sort();
  const userKey = users.includes(chosen) ? chosen : users[0] ?? '';
  const userRows = out?.rows.filter((r) => r.userKey === userKey) ?? [];
  const available = userRows.filter((r) => r.arm === arm);
  const row = available.find((r) => r.variant === variant) ?? available[0] ?? userRows[0];
  const user = local?.users.get(userKey);
  const title = (id: number) => dataset?.itemById.get(id)?.title ?? `Item ${id}`;
  const calls = out?.calls.filter((c) => row?.callIds.includes(c.id)) ?? [];
  return <><Header eyebrow="04 / Inspector" title="Follow one user through the reranker">Read local titles and pre-cutoff history beside stored candidate, presentation and output orders. Only hashes and structured outcomes are stored; raw prompts and responses are not logged.</Header>
    {!out?.rows.length ? <Empty>No stored rows to inspect. Run an evaluation first.</Empty> : !local ? <Empty>Reselect the original source files with matching hashes to inspect local titles and history. <button className="secondary" onClick={() => app.setPage('Data')}>Open Data</button></Empty> : <>
      {out.identity.mode === 'mock' && <p className="notice warning">MOCK: simulated, not a measurement</p>}
      <section className="card"><div className="grid two"><label>User key<select value={userKey} onChange={(e) => setChosen(e.target.value)}>{users.map((u) => <option key={u}>{u}</option>)}</select></label><label>Arm<select value={row?.arm ?? arm} onChange={(e) => { setArm(e.target.value); setVariant('base'); }}>{[...new Set(userRows.map((r) => r.arm))].map((a) => <option key={a}>{a}</option>)}</select></label><label>Variant<select value={row?.variant ?? variant} onChange={(e) => setVariant(e.target.value)}>{(available.length ? available : userRows.filter((r) => r.arm === row?.arm)).map((r) => <option key={r.variant}>{r.variant}</option>)}</select></label></div>
        <p>Cutoff {manifest?.T}; target (local scoring only): <strong>{local.targetTitles.get(userKey) ?? 'unavailable'}</strong>. Target rank {row?.targetRank ?? 'absent'}; in candidates {String(row?.inCandidates)}; cold target {String(row?.coldTarget)}.</p>
      </section>
      <section className="card"><h2>Pre-cutoff history</h2><p>{user?.history.length ?? 0} history items, oldest first. Prompts use only the last 30.</p><ol>{user?.history.map((h) => <li key={h.itemId}>{title(h.itemId)} <span className="muted">(timestamp {h.ts})</span></li>)}</ol></section>
      {row && <section className="card"><h2>Candidates and output order</h2><p>kEff {row.kEff}; flags {row.flags.join(', ') || 'none'}; format failure {String(row.formatFailure)}.</p><Table caption="Locally resolved titles with stored ranks" headings={['Output rank', 'Title', 'Candidate kNN rank', 'Presentation position', 'Target']}>{row.rankedIds.map((id, i) => <tr key={id}><td>{i + 1}</td><td>{title(id)}</td><td>{row.candidateIds.indexOf(id) >= 0 ? row.candidateIds.indexOf(id) + 1 : 'outside kNN pool (mostpop)'}</td><td>{row.presentedIds.indexOf(id) >= 0 ? row.presentedIds.indexOf(id) + 1 : 'not a model presentation'}</td><td>{user?.target?.itemId === id ? 'target' : ''}</td></tr>)}</Table><details><summary>Frozen candidate pool, in kNN order</summary><ol>{row.candidateIds.map((id) => <li key={id}>{title(id)}</li>)}</ol></details><h3>Repairs</h3><Json value={row.repairs} /></section>}
      <section className="card"><h2>Attempt provenance and prompt hashes</h2>{calls.length ? <Table caption="Calls referenced by this result" headings={['Attempt', 'Status', 'Prompt hash', 'Mapping hash', 'Cache provenance']}>{calls.map((c) => <tr key={c.id}><td>{c.attemptNo}</td><td>{c.status}</td><td className="mono">{c.promptHash}</td><td className="mono">{c.mappingHash}</td><td>{c.provenance.kind === 'cache' ? c.provenance.sourceCallId : 'provider'}</td></tr>)}</Table> : <p>This result has no model call (baseline or zero candidates).</p>}</section>
    </>}
  </>;
}
