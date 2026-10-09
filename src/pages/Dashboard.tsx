import { useEffect, useRef, useState } from 'react';
import { AppNav } from '../components/AppNav';
import { InstallBanner } from '../components/InstallBanner';
import { api, when } from '../lib/api';

interface ProjectSummary {
  id: string;
  name: string;
  objects: number;
  updatedAt: number;
  teamId: string | null;
  teamName: string | null;
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [notice, setNotice] = useState('');
  const deleteDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (pendingDelete) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [pendingDelete]);

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
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    setNotice('');
    try {
      await api('DELETE', `/api/projects/${p.id}`);
      setProjects((list) => list?.filter((x) => x.id !== p.id) ?? null);
      setPendingDelete(null);
      setNotice(`Deleted "${p.name}".`);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Could not delete that project.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="landing">
      <AppNav current="dashboard" />
      <InstallBanner />
      <div className="row between">
        <h1>Your projects</h1>
        <div className="row">
          <a className="btn" href="#/studio">Brand Studio</a>
          <a className="btn primary" href="#/new">New project</a>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
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
            <b>{p.name}{p.teamName ? <span className="badge">Team: {p.teamName}</span> : null}</b>
            <span>{p.objects} layer{p.objects === 1 ? '' : 's'} · edited {when(p.updatedAt)}</span>
            <div className="row">
              <a className="btn small" href={`#/editor/${p.id}`}>Open</a>
              <button type="button" className="btn danger project-delete" onClick={() => { setDeleteError(''); setPendingDelete(p); }} aria-label={`Delete ${p.name}`}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      <dialog ref={deleteDialog} className="modal-card project-delete-dialog" aria-labelledby="delete-project-title"
        onCancel={(event) => { event.preventDefault(); if (!deleting) setPendingDelete(null); }}>
        <h2 id="delete-project-title">Delete project?</h2>
        <p>Delete <strong>{pendingDelete?.name}</strong> and its saved animation? This cannot be undone.</p>
        {deleteError && <p className="error" role="alert">{deleteError}</p>}
        <div className="row">
          <button type="button" className="btn" autoFocus disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button>
          <button type="button" className="btn danger" disabled={deleting} onClick={() => pendingDelete && void remove(pendingDelete)}>
            {deleting ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      </dialog>
    </div>
  );
}
