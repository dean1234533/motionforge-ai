import { useEffect, useState } from 'react';
import { AppNav } from '../components/AppNav';
import { api, when } from '../lib/api';

interface ProjectSummary {
  id: string;
  name: string;
  objects: number;
  updatedAt: number;
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setProjects((await api<{ projects: ProjectSummary[] }>('GET', '/api/projects')).projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your projects.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const remove = async (p: ProjectSummary) => {
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/projects/${p.id}`);
      setProjects((list) => list?.filter((x) => x.id !== p.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that project.');
    }
  };

  return (
    <div className="landing">
      <AppNav current="dashboard" />
      <div className="row between">
        <h1>Your projects</h1>
        <a className="btn primary" href="#/new">New project</a>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!projects && !error && <p className="muted">Loading…</p>}
      {projects && projects.length === 0 && (
        <div className="empty-card">
          <h2>No projects yet</h2>
          <p className="muted">Upload an image, describe how it should move, and export code for any website.</p>
          <a className="btn primary" href="#/new">Create your first animation</a>
        </div>
      )}
      <ul className="cards">
        {projects?.map((p) => (
          <li key={p.id}>
            <b>{p.name}</b>
            <span>{p.objects} layer{p.objects === 1 ? '' : 's'} · edited {when(p.updatedAt)}</span>
            <div className="row">
              <a className="btn small" href={`#/editor/${p.id}`}>Open</a>
              <button type="button" className="btn small ghost danger" onClick={() => void remove(p)} aria-label={`Delete ${p.name}`}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
