import { useConsole, type Page } from './state.ts';
import { Setup } from './pages/Setup.tsx';
import { Data } from './pages/Data.tsx';
import { Run } from './pages/Run.tsx';
import { Results } from './pages/Results.tsx';
import { Inspector } from './pages/Inspector.tsx';
import { Ledger } from './pages/Ledger.tsx';

const pages: Page[] = ['Setup', 'Data', 'Run', 'Results', 'Inspector', 'Ledger'];
export function App() {
  const app = useConsole();
  const components = { Setup, Data, Run, Results, Inspector, Ledger };
  const Current = components[app.page];
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="eyebrow">RECSYS / OFFLINE LAB</span><h2>Rerank<br />&amp; evaluate.</h2><p>Evidence before claims.</p></div><nav aria-label="Console pages">{pages.map((page, i) => <button key={page} className={`nav-link${app.page === page ? ' active' : ''}`} aria-current={app.page === page ? 'page' : undefined} onClick={() => app.setPage(page)}><span>{String(i).padStart(2, '0')}</span> {page}</button>)}</nav><p className="muted">Six arms. One frozen split.<br />Null results welcome.</p></aside>
    <div className="workspace"><header className="topbar"><span className="pill">{app.branch === 'local' ? 'Local mock' : 'Persisted mode'}</span><span>{app.branch === 'persisted' ? app.session?.user.email ?? 'Sign-in required' : 'No account needed'}</span><span className="muted">{app.run ? `${app.run.split} / ${app.run.state}` : app.data ? `${app.data.manifest.counts.eligible} eligible users` : 'Ready for local data'}</span></header>
      <main className="content" id="main-content"><div aria-live="polite">{app.branch === 'local' && <p className="notice warning"><strong>LOCAL MOCK — simulated, not persisted.</strong> Reload loses this tab's data and run state. Download computed results before leaving.</p>}{app.busy && <p className="notice" role="status">{app.busy}… {app.canCancel && <button className="secondary" onClick={app.cancel}>Cancel computation / execution</button>}</p>}{app.notice && <p className="notice success">{app.notice}</p>}</div>{app.error && <p className="error" role="alert">{app.error}</p>}<Current app={app} /></main>
    </div></div>;
}
