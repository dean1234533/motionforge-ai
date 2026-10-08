import { useEffect, useState } from 'react';
import { AppNav } from '../components/AppNav';
import { api, when } from '../lib/api';
import { useSession } from '../lib/session';

interface Summary {
  configured: boolean;
  plan: string;
  status: string;
  plans: { id: string; label: string; credits: number }[];
  ledger: { delta: number; reason: string; createdAt: number }[];
}

export function Billing({ status }: { status: string | null }) {
  const { credits, refresh } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        setSummary(await api<Summary>('GET', '/api/billing'));
        if (status === 'success') await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load billing.');
      }
    })();
  }, [status, refresh]);

  const go = async (path: string, body: unknown, id: string) => {
    setBusy(id);
    setError('');
    try {
      const { url } = await api<{ url: string }>('POST', path, body);
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy('');
    }
  };

  return (
    <div className="landing">
      <AppNav current="billing" />
      <h1>Billing and credits</h1>
      {status === 'success' && <p className="ok" role="status">Thanks! Your plan updates as soon as the payment is confirmed; credits can take a minute to appear.</p>}
      {status === 'cancelled' && <p className="muted" role="status">Checkout was cancelled. You have not been charged.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!summary && !error && <p className="muted">Loading…</p>}

      {summary && (
        <>
          <p><b>{credits}</b> credits available · current plan: <b>{summary.plan}</b>{summary.status !== 'none' ? ` (${summary.status})` : ''}</p>
          {!summary.configured && <p className="muted">Paid plans are not enabled on this server yet, so upgrading is unavailable. You keep the free monthly allowance.</p>}
          <ul className="cards">
            {summary.plans.map((p) => (
              <li key={p.id}>
                <b>{p.label}</b>
                <span>{p.credits} credits{p.id === 'free' ? ' every month' : ' with each billing period'}</span>
                {p.id === 'free' ? (
                  <span className="muted">{summary.plan === 'free' ? 'Your current plan' : 'Applies if you cancel'}</span>
                ) : summary.plan === p.id ? (
                  <span className="muted">Your current plan</span>
                ) : (
                  <button type="button" className="btn primary" disabled={!summary.configured || busy !== ''} onClick={() => void go('/api/billing/checkout', { plan: p.id }, p.id)}>
                    {busy === p.id ? 'Opening checkout…' : `Choose ${p.label}`}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {summary.status !== 'none' && (
            <p><button type="button" className="btn" disabled={busy !== ''} onClick={() => void go('/api/billing/portal', {}, 'portal')}>Manage subscription</button></p>
          )}

          <h2>Recent activity</h2>
          {summary.ledger.length === 0 ? <p className="muted">No activity yet.</p> : (
            <table>
              <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Credits</th></tr></thead>
              <tbody>
                {summary.ledger.map((l, i) => (
                  <tr key={i}><td>{when(l.createdAt)}</td><td>{l.reason}</td><td>{l.delta > 0 ? `+${l.delta}` : l.delta}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
