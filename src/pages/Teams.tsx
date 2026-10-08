import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AppNav } from '../components/AppNav';
import { api, when } from '../lib/api';
import { useSession } from '../lib/session';

interface TeamSummary {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  members: number;
}
interface TeamDetail {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  members: { userId: string; email: string; role: string }[];
  invites: { token: string; email: string; role: string; expiresAt: number }[];
}

const inviteUrl = (token: string) => `${window.location.origin}${window.location.pathname}#/invite/${token}`;

export function Teams() {
  const { user } = useSession();
  const [teams, setTeams] = useState<TeamSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTeams((await api<{ teams: TeamSummary[] }>('GET', '/api/teams')).teams);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your teams.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const { team } = await api<{ team: { id: string } }>('POST', '/api/teams', { name });
      setName('');
      await load();
      setOpenId(team.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the team.');
    }
  };

  return (
    <div className="landing">
      <AppNav current="teams" />
      <h1>Teams</h1>
      <p className="muted">Share projects with other people. Everyone on a team can open its projects; editors can change them; viewers can look and export.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <form className="row" onSubmit={(e) => void create(e)}>
        <label className="sr-only" htmlFor="team-name">Team name</label>
        <input id="team-name" type="text" value={name} maxLength={60} placeholder="Team name" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn primary" disabled={!name.trim()}>Create team</button>
      </form>
      {user?.plan !== 'professional' && <p className="muted small-note">Creating a team is part of the Professional plan. You can still join a team you are invited to.</p>}

      {!teams && !error && <p className="muted">Loading…</p>}
      {teams?.length === 0 && <div className="empty-card"><h2>No teams yet</h2><p className="muted">Create one, or open an invitation link someone sent you.</p></div>}
      <ul className="cards">
        {teams?.map((t) => (
          <li key={t.id}>
            <b>{t.name}</b>
            <span>{t.members} {t.members === 1 ? 'person' : 'people'} · you are {t.role === 'owner' ? 'the owner' : `an ${t.role === 'editor' ? 'editor' : 'viewer'}`}</span>
            <button type="button" className="btn small" aria-expanded={openId === t.id} onClick={() => setOpenId(openId === t.id ? null : t.id)}>
              {openId === t.id ? 'Hide' : 'Manage'}
            </button>
          </li>
        ))}
      </ul>
      {openId && <TeamPanel key={openId} teamId={openId} onChanged={load} onGone={() => { setOpenId(null); void load(); }} />}
    </div>
  );
}

function TeamPanel({ teamId, onChanged, onGone }: { teamId: string; onChanged: () => void; onGone: () => void }) {
  const { user } = useSession();
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setTeam((await api<{ team: TeamDetail }>('GET', `/api/teams/${teamId}`)).team);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not load the team.');
    }
  }, [teamId]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setMessage(done);
      await load();
      onChanged();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'That did not work.');
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const { token } = await api<{ token: string }>('POST', `/api/teams/${teamId}/invites`, { email, role });
      setEmail('');
      try {
        await navigator.clipboard.writeText(inviteUrl(token));
      } catch {
        /* the link is also listed below */
      }
    }, 'Invitation link created and copied. Send it to them; it only works for that email address.');
  };

  if (!team) return <p className="muted">{message || 'Loading…'}</p>;
  const owner = team.role === 'owner';

  return (
    <section className="card-panel" aria-label={`${team.name} team`}>
      <h2>{team.name}</h2>
      <table>
        <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {team.members.map((m) => (
            <tr key={m.userId}>
              <td>{m.email}{m.userId === user?.id ? ' (you)' : ''}</td>
              <td>
                {owner && m.role !== 'owner' ? (
                  <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => void act(() => api('PUT', `/api/teams/${teamId}/members/${m.userId}`, { role: e.target.value }), 'Role updated.')}>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer</option>
                  </select>
                ) : m.role}
              </td>
              <td>
                {m.role !== 'owner' && (owner || m.userId === user?.id) && (
                  <button type="button" className="btn small ghost danger" onClick={() => void act(() => api('DELETE', `/api/teams/${teamId}/members/${m.userId}`), m.userId === user?.id ? 'You left the team.' : 'Removed.').then(() => { if (m.userId === user?.id) onGone(); })}>
                    {m.userId === user?.id ? 'Leave' : 'Remove'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {owner && (
        <>
          <h3>Invite someone</h3>
          <form className="row" onSubmit={invite}>
            <label className="sr-only" htmlFor="invite-email">Email address</label>
            <input id="invite-email" type="text" inputMode="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="sr-only" htmlFor="invite-role">Role</label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="btn primary" disabled={!email.trim()}>Create invitation link</button>
          </form>
          <p className="muted small-note">Invitations are links you send yourself; MotionForge does not email them.</p>
          {team.invites.length > 0 && (
            <ul className="list">
              {team.invites.map((i) => (
                <li key={i.token} className="asset">
                  <span className="grow" title={inviteUrl(i.token)}>{i.email} · {i.role} · expires {when(i.expiresAt)}</span>
                  <button type="button" className="btn small" onClick={() => void act(() => navigator.clipboard.writeText(inviteUrl(i.token)), 'Link copied.')}>Copy link</button>
                  <button type="button" className="btn small ghost danger" onClick={() => void act(() => api('DELETE', `/api/teams/${teamId}/invites/${i.token}`), 'Invitation cancelled.')}>Cancel</button>
                </li>
              ))}
            </ul>
          )}
          <h3>Danger zone</h3>
          <button type="button" className="btn ghost danger" onClick={() => { if (window.confirm(`Delete the team "${team.name}"? Its projects stay with the people who created them.`)) void act(() => api('DELETE', `/api/teams/${teamId}`), 'Team deleted.').then(onGone); }}>
            Delete team
          </button>
        </>
      )}
      <p role="status" className="muted small-note">{message}</p>
    </section>
  );
}
