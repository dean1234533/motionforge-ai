import { parseScene } from '../../src/scene/schema';
import { emptyScene } from '../../src/scene/defaults';
import { sanitizeText } from '../../src/lib/sanitize';
import { projectAccess } from './access';
import { HttpError } from './http';
import { projectLimit } from './plans';
import { requireTeamEditor } from './teams';
import type { D1Database } from './types';

const now = () => Math.floor(Date.now() / 1000);
const MAX_VERSIONS = 50;

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  scene: string;
  team_id: string | null;
  created_at: number;
  updated_at: number;
}

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? sanitizeText(v, 80) : '';
  if (!name) throw new HttpError(400, 'Give the project a name.');
  return name;
}

function cleanScene(v: unknown): string {
  const r = parseScene(v);
  if (!r.ok) throw new HttpError(422, `The animation is not valid: ${r.error}`);
  return JSON.stringify(r.scene);
}

export async function listProjects(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.scene, p.updated_at, p.team_id, t.name AS team_name
       FROM projects p LEFT JOIN teams t ON t.id = p.team_id
       WHERE p.user_id = ? OR p.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
       ORDER BY p.updated_at DESC LIMIT 200`,
    )
    .bind(userId, userId)
    .all<{ id: string; name: string; scene: string; updated_at: number; team_id: string | null; team_name: string | null }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    objects: JSON.parse(r.scene).objects.length,
    updatedAt: r.updated_at,
    teamId: r.team_id,
    teamName: r.team_name,
  }));
}

export async function getProject(db: D1Database, actorId: string, id: string) {
  const access = await projectAccess(db, actorId, id, 'read');
  const r = (await db
    .prepare('SELECT id, user_id, name, scene, team_id, created_at, updated_at FROM projects WHERE id = ?')
    .bind(id)
    .first<ProjectRow>())!;
  return {
    id: r.id,
    name: r.name,
    scene: JSON.parse(r.scene),
    teamId: r.team_id,
    role: access.role,
    canDelete: access.canDelete,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createProject(db: D1Database, user: { id: string; plan: string }, name: unknown, scene: unknown, teamId?: unknown) {
  const userId = user.id;
  const owned = await db.prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?').bind(userId).first<{ n: number }>();
  const limit = projectLimit(user.plan);
  if ((owned?.n ?? 0) >= limit) {
    throw new HttpError(402, `Your ${user.plan === 'free' ? 'Free' : user.plan} plan includes up to ${limit} projects. Delete one or upgrade to add more.`);
  }
  let team: string | null = null;
  if (teamId !== undefined && teamId !== null) {
    if (typeof teamId !== 'string') throw new HttpError(400, 'Invalid team.');
    await requireTeamEditor(db, userId, teamId);
    team = teamId;
  }
  const id = crypto.randomUUID();
  const t = now();
  await db
    .prepare('INSERT INTO projects(id, user_id, name, scene, team_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, cleanName(name), cleanScene(scene ?? emptyScene()), team, t, t)
    .run();
  return getProject(db, userId, id);
}

export async function updateProject(db: D1Database, actorId: string, id: string, patch: { name?: unknown; scene?: unknown; teamId?: unknown }) {
  const access = await projectAccess(db, actorId, id, 'write');
  const current = await getProject(db, actorId, id);
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const scene = patch.scene === undefined ? JSON.stringify(current.scene) : cleanScene(patch.scene);

  let teamId = current.teamId;
  if (patch.teamId !== undefined) {
    if (access.ownerId !== actorId) throw new HttpError(403, 'Only the person who created a project can move it.');
    if (patch.teamId === null) teamId = null;
    else if (typeof patch.teamId === 'string') {
      await requireTeamEditor(db, actorId, patch.teamId);
      teamId = patch.teamId;
    } else throw new HttpError(400, 'Invalid team.');
  }

  const t = now();
  if (scene !== JSON.stringify(current.scene)) {
    await db.prepare('INSERT INTO project_versions(project_id, scene, created_at) VALUES(?, ?, ?)').bind(id, JSON.stringify(current.scene), t).run();
    await db
      .prepare('DELETE FROM project_versions WHERE project_id = ? AND id NOT IN (SELECT id FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT ?)')
      .bind(id, id, MAX_VERSIONS)
      .run();
  }
  await db.prepare('UPDATE projects SET name = ?, scene = ?, team_id = ?, updated_at = ? WHERE id = ?').bind(name, scene, teamId, t, id).run();
  return getProject(db, actorId, id);
}

export async function deleteProject(db: D1Database, actorId: string, id: string) {
  const access = await projectAccess(db, actorId, id, 'write');
  if (!access.canDelete) throw new HttpError(403, 'Only the project creator or team owner can delete this.');
  await db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
}

export async function listVersions(db: D1Database, actorId: string, id: string) {
  await projectAccess(db, actorId, id, 'read');
  const { results } = await db
    .prepare('SELECT id, created_at FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT 50')
    .bind(id)
    .all<{ id: number; created_at: number }>();
  return results.map((v) => ({ id: v.id, createdAt: v.created_at }));
}

export async function restoreVersion(db: D1Database, actorId: string, id: string, versionId: number) {
  await projectAccess(db, actorId, id, 'write');
  const v = await db.prepare('SELECT scene FROM project_versions WHERE id = ? AND project_id = ?').bind(versionId, id).first<{ scene: string }>();
  if (!v) throw new HttpError(404, 'Version not found.');
  return updateProject(db, actorId, id, { scene: JSON.parse(v.scene) });
}

const FORMATS = ['html', 'snippet', 'zip', 'react'];
export async function logExport(db: D1Database, actorId: string, projectId: string, format: unknown) {
  await projectAccess(db, actorId, projectId, 'read');
  if (typeof format !== 'string' || !FORMATS.includes(format)) throw new HttpError(400, 'Unknown export format.');
  await db
    .prepare('INSERT INTO exports(id, project_id, user_id, format, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), projectId, actorId, format, now())
    .run();
}

export async function listExports(db: D1Database, actorId: string, projectId: string) {
  await projectAccess(db, actorId, projectId, 'read');
  const { results } = await db
    .prepare('SELECT id, format, created_at FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
    .bind(projectId)
    .all<{ id: string; format: string; created_at: number }>();
  return results.map((e) => ({ id: e.id, format: e.format, createdAt: e.created_at }));
}
