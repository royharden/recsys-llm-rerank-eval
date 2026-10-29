import { useState } from 'react';
import type { ConsoleState } from '../state.ts';
import { Header } from '../components/common.tsx';

export function Setup({ app }: { app: ConsoleState }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [action, setAction] = useState<'signin' | 'signup'>('signin');
  const authDisabled = !!app.busy || !app.configured || app.branch !== 'persisted';
  return <><Header eyebrow="Experiment console" title="Measure the reranker, keep the evidence">Compare six recommendation strategies on the same frozen temporal split. Start with a simulated run, then use a separately approved live experiment.</Header>
    <div className="grid two"><section className="card"><h2>1. Choose where the run lives</h2><div className="stack">
      <label><input type="radio" name="branch" checked={app.branch === 'local'} disabled={!!app.busy} onChange={() => app.chooseBranch('local')} /> Local mock</label>
      <p>No account or connection needed. Simulated results stay in this tab; reload loses them.</p>
      <label><input type="radio" name="branch" checked={app.branch === 'persisted'} disabled={!!app.busy} onChange={() => app.chooseBranch('persisted')} /> Persisted experiment</label>
      <p>Uses your configured database account, immutable approval, durable results and resume. Live calls send titles and recent history to the model providers.</p>
      <p className="pill">{app.configured ? 'Public database connection configured' : 'Database connection not configured'}</p>
      {!app.configured && app.branch === 'persisted' && <p className="notice warning">Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the environment, then reload. Only public connection settings belong in the browser.</p>}
    </div></section>
    <section className="card"><h2>2. Your account</h2>{app.configError && <p className="error">{app.configError}</p>}{app.branch === 'local' && <p className="muted">Choose persisted mode to activate account access. Local mock does not activate authentication.</p>}{app.session ? <><p>Signed in as <strong>{app.session.user.email}</strong></p><p className="muted">Session refresh and expiry are monitored. An expired session requires sign-in before persisted actions can continue.</p><button disabled={!!app.busy} onClick={() => { setPassword(''); void app.authenticate('signout'); }}>Sign out</button></>
      : <form onSubmit={(e) => { e.preventDefault(); const secret = password; setPassword(''); void app.authenticate(action, email, secret); }}>
        <label>Email<input autoComplete="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={authDisabled} /></label>
        <label>Password<input autoComplete={action === 'signin' ? 'current-password' : 'new-password'} type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} disabled={authDisabled} /></label>
        <label>Account action<select value={action} onChange={(e) => setAction(e.target.value as typeof action)} disabled={!!app.busy}><option value="signin">Sign in</option><option value="signup">Create account</option></select></label>
        <div className="actions"><button disabled={authDisabled}>{action === 'signin' ? 'Sign in' : 'Create account'}</button><button className="secondary" type="button" disabled={authDisabled || !email} onClick={() => { setPassword(''); void app.authenticate('reset', email); }}>Request password reset</button></div>
      </form>}</section></div>
    <section className="card"><h2>One target, one honest comparison</h2><p>Pre-cutoff interactions train item-kNN and popularity. Dev users select parameters; held-out users measure the frozen choice. A target outside the candidate set remains a miss. Repair and format failures stay in every denominator.</p><p>A confidence interval spanning zero means no detectable difference, not equivalence. Masking titles does not remove possible model memorisation.</p><button disabled={!!app.busy || (app.branch === 'persisted' && !app.session)} onClick={() => app.setPage('Data')}>Continue to data</button></section>
  </>;
}
