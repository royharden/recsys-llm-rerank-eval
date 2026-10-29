import { useState } from 'react';
import { DEFAULT_LIMITS } from '../../core/data/movielens.ts';
import { loadManifest, type Manifest } from '../../core/split/manifest.ts';
import type { ConsoleState } from '../state.ts';
import { downloadText } from '../workflow.ts';
import { Header, Json, Table } from '../components/common.tsx';

export function Data({ app }: { app: ConsoleState }) {
  const [uData, setUData] = useState<File | null>(null); const [uItem, setUItem] = useState<File | null>(null);
  const [lock, setLock] = useState<Manifest | null>(null); const [error, setError] = useState('');
  async function validate() {
    setError('');
    try {
      if (!uData || !uItem) throw new Error('Select both source files.');
      if (uData.size > DEFAULT_LIMITS.maxUDataBytes || uItem.size > DEFAULT_LIMITS.maxUItemBytes) throw new Error('Source file exceeds the supported size limit (16 MiB u.data, 2 MiB u.item).');
      await app.loadData({ uData: new Uint8Array(await uData.arrayBuffer()), uItem: new Uint8Array(await uItem.arrayBuffer()) }, false, lock);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read source files.'); }
  }
  return <><Header eyebrow="01 / Data" title="Keep raw data on this device">Load MovieLens u.data and u.item, or generate a seeded fixture. The browser validates and hashes the bytes locally. u.user is never read.</Header>
    {app.run && <p className="notice">Reselecting files for {app.run.id}. Its stored manifest, salt, cutoff and seed take priority over an imported lock. Matching bytes are required for resume and inspection.</p>}
    <div className="grid two"><section className="card"><h2>MovieLens files</h2><p className="muted">u.data: tab-separated ratings. u.item: Latin-1 movie metadata. Neither file is uploaded.</p>
      <label>u.data<input type="file" disabled={!!app.busy} onChange={(e) => setUData(e.target.files?.[0] ?? null)} /></label>
      <label>u.item<input type="file" disabled={!!app.busy} onChange={(e) => setUItem(e.target.files?.[0] ?? null)} /></label>
      <label>Existing private manifest lock (optional)<input type="file" accept=".json,application/json" disabled={!!app.busy || !!app.run} onChange={(e) => {
        const file = e.target.files?.[0]; setLock(null); setError(''); if (!file) return;
        void (async () => { try { if (file.size > 100000) throw new Error('Manifest file is too large.'); const result = loadManifest(JSON.parse(await file.text())); if (!result.ok) throw new Error(result.error); setLock(result.manifest); } catch (err) { setError(err instanceof Error ? err.message : 'Invalid manifest.'); } })();
      }} /></label>
      {lock && <p>Imported manifest {lock.manifestHash.slice(0, 16)}…; seed {lock.seed}.</p>}
      <button disabled={!!app.busy || !uData || !uItem} onClick={() => void validate()}>Validate selected files</button>
    </section><section className="card"><h2>Seeded synthetic fixture</h2><p>150 users, 300 items and planted traps exercise cold targets, ties, short candidate lists, malformed output and position bias. This fixture supports simulated comparisons; it cannot establish live MovieLens quality.</p>
      <button disabled={!!app.busy} onClick={() => { setError(''); void app.loadData(null, true, lock); }}>Use synthetic fixture</button>
      <p className="muted">Seed {app.run?.config.manifest.seed ?? lock?.seed ?? 38}. The same generator supports persisted resume.</p>
      {app.data && !app.run && <button className="secondary" disabled={!!app.busy} onClick={() => { app.resetData(); setLock(null); setUData(null); setUItem(null); }}>Start with a different dataset</button>}
    </section></div>
    {error && <p className="error" role="alert">{error}</p>}
    {app.validation && <section className="card"><h2>Validation report</h2><div className="metric-grid">{[['Accepted ratings', app.validation.rows], ['Users', app.validation.users], ['Items', app.validation.items], ['Rejected lines', app.validation.rejectCount]].map(([label, value]) => <div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {app.validation.rejects.length > 0 && <Table caption="Rejected lines (bounded excerpt)" headings={['File', 'Line', 'Reason']}>{app.validation.rejects.map((r, i) => <tr key={i}><td>{r.file}</td><td>{r.line}</td><td>{r.reason}</td></tr>)}</Table>}
    </section>}
    {app.data && <section className="card"><h2>Frozen manifest</h2><p>Cutoff T = {app.data.manifest.T}; q = {app.data.manifest.q}; dev {app.data.manifest.counts.dev}; held-out {app.data.manifest.counts.heldout}.</p>
      {app.data.manifest.insufficientPrecision && <p className="notice warning">Insufficient precision: the count-only split rule could not reach 150 held-out users. Small-data caveats will accompany the results.</p>}
      <Json value={{ ...app.data.manifest, salt: '[private salt retained locally; omitted from this preview]' }} />
      <p className="muted">The private lock contains the salt needed to reproduce user keys. Keep it private; result exports omit it.</p><div className="actions"><button className="secondary" onClick={() => downloadText('manifest.lock.json', JSON.stringify(app.data!.manifest, null, 2), 'application/json')}>Save private manifest lock</button><button disabled={!!app.busy} onClick={() => app.setPage('Run')}>Continue to run</button></div>
    </section>}
  </>;
}
