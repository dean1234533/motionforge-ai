import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export function Invite({ token }: { token: string }) {
  const { user, loading, refresh } = useSession();
  const [info, setInfo] = useState<{ teamName: string; role: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ teamName: string; role: string }>('GET', `/api/invites/${token}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : 'This invitation is no longer valid.'));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      await api('POST', `/api/invites/${token}/accept`, {});
      await refresh();
      window.location.hash = '#/teams';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept the invitation.');
      setBusy(false);
    }
  };

  return (
    <div className="landing auth">
      <header className="nav"><a className="brand" href="#/">MotionForge <span>AI</span></a></header>
      <div className="card-form">
        <h1>Team invitation</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {info && (
          <>
            <p>You have been invited to join <b>{info.teamName}</b> as {info.role === 'editor' ? 'an editor' : 'a viewer'}.</p>
            {loading ? <p className="muted">Loading…</p> : user ? (
              <button type="button" className="btn primary big" disabled={busy} onClick={() => void accept()}>{busy ? 'Joining…' : 'Accept invitation'}</button>
            ) : (
              <>
                <p className="muted">Log in or create an account with the email address this invitation was sent to, then open this link again.</p>
                <p><a className="btn primary" href="#/login">Log in</a> <a className="btn" href="#/signup">Sign up</a></p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
