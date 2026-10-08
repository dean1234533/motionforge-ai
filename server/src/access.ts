import { HttpError } from './http';
import type { D1Database } from './types';

export type Need = 'read' | 'write';

export interface Access {
  projectId: string;
  /** Who created the project. Files are stored under this user. */
  ownerId: string;
  teamId: string | null;
  /** The caller's role on this project. */
  role: 'owner' | 'editor' | 'viewer';
  canDelete: boolean;
}

/**
 * The single place that decides who may touch a project.
 * Strangers get 404 (not 403) so project ids cannot be probed.
 */
export async function projectAccess(db: D1Database, actorId: string, projectId: string, need: Need): Promise<Access> {
  const p = await db.prepare('SELECT user_id, team_id FROM projects WHERE id = ?').bind(projectId).first<{ user_id: string; team_id: string | null }>();
  if (!p) throw new HttpError(404, 'Project not found.');

  let role: Access['role'] | null = null;
  let canDelete = false;
  if (p.user_id === actorId) {
    role = 'owner';
    canDelete = true;
  } else if (p.team_id) {
    const m = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(p.team_id, actorId).first<{ role: string }>();
    if (m) {
      role = m.role === 'viewer' ? 'viewer' : 'editor';
      canDelete = m.role === 'owner';
    }
  }
  if (!role) throw new HttpError(404, 'Project not found.');
  if (need === 'write' && role === 'viewer') throw new HttpError(403, 'You have view-only access to this project.');
  return { projectId, ownerId: p.user_id, teamId: p.team_id, role, canDelete };
}
