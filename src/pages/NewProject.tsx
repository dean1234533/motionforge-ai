import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AppNav } from '../components/AppNav';
import { api } from '../lib/api';

export function NewProject() {
  const [name, setName] = useState('Untitled animation');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string; role: string }[]>([]);
  const [teamId, setTeamId] = useState('');

  useEffect(() => {
    api<{ teams: { id: string; name: string; role: string }[] }>('GET', '/api/teams')
      .then((r) => setTeams(r.teams.filter((t) => t.role !== 'viewer')))
      .catch(() => undefined);
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ project: { id: string } }>('POST', '/api/projects', { name, teamId: teamId || undefined });
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
        {teams.length > 0 && (
          <label className="field"><span>Who can open it</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">Only me</option>
              {teams.map((t) => <option key={t.id} value={t.id}>Team: {t.name}</option>)}
            </select>
          </label>
        )}
        <p className="muted">Next you will add an image and describe how it should move.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn primary big" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
      </form>
    </div>
  );
}
