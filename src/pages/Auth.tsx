import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

export function Auth({ mode }: { mode: 'login' | 'signup' }) {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', signup ? '/api/auth/signup' : '/api/auth/login', { email, password });
      await refresh();
      window.location.hash = '#/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing auth">
      <header className="nav"><a className="brand" href="#/">MotionForge <span>AI</span></a></header>
      <form className="card-form" onSubmit={(e) => void submit(e)}>
        <h1>{signup ? 'Create your account' : 'Welcome back'}</h1>
        <label className="field"><span>Email</span>
          <input type="text" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field"><span>Password{signup ? ' (at least 10 characters)' : ''}</span>
          <input type="password" autoComplete={signup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={signup ? 10 : 1} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn primary big" disabled={busy}>{busy ? 'Please wait…' : signup ? 'Sign up' : 'Log in'}</button>
        <p className="muted">
          {signup ? <>Already set up? <a href="#/login">Log in</a></> : <>This is a private app; only the owner can sign in.</>}
        </p>
        <p className="muted small-note">You can also <a href="#/editor">use the editor without an account</a>; your work then stays in this browser.</p>
      </form>
    </div>
  );
}
