import { useState } from 'react';
import type { FormEvent } from 'react';
import { AppNav } from '../components/AppNav';
import { api } from '../lib/api';

export function NewProject() {
  const [name, setName] = useState('Untitled animation');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ project: { id: string } }>('POST', '/api/projects', { name });
      window.location.hash = `#/editor/${r.project.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <AppNav current="dashboard" />
      <form className="card-form" onSubmit={(e) => void create(e)}>
        <h1>New project</h1>
        <label className="field"><span>Project name</span>
          <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        </label>
        <p className="muted">Next you will add an image and describe how it should move.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn primary big" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
      </form>
    </div>
  );
}
