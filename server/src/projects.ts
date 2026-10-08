import { parseScene } from '../../src/scene/schema';
import { emptyScene } from '../../src/scene/defaults';
import { sanitizeText } from '../../src/lib/sanitize';
import { HttpError } from './http';
import type { D1Database } from './types';

const now = () => Math.floor(Date.now() / 1000);
const MAX_VERSIONS = 50;

interface ProjectRow {
  id: string;
  name: string;
  scene: string;
  created_at: number;
  updated_at: number;
}

const view = (r: ProjectRow) => ({ id: r.id, name: r.name, scene: JSON.parse(r.scene), createdAt: r.created_at, updatedAt: r.updated_at });

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
    .prepare('SELECT id, name, scene, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200')
    .bind(userId)
    .all<ProjectRow>();
  return results.map((r) => ({ id: r.id, name: r.name, objects: JSON.parse(r.scene).objects.length, updatedAt: r.updated_at }));
}

export async function getProject(db: D1Database, userId: string, id: string) {
  const r = await db
    .prepare('SELECT id, name, scene, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<ProjectRow>();
  if (!r) throw new HttpError(404, 'Project not found.');
  return view(r);
}

export async function createProject(db: D1Database, userId: string, name: unknown, scene: unknown) {
  const id = crypto.randomUUID();
  const t = now();
  await db
    .prepare('INSERT INTO projects(id, user_id, name, scene, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
    .bind(id, userId, cleanName(name), cleanScene(scene ?? emptyScene()), t, t)
    .run();
  return getProject(db, userId, id);
}

export async function updateProject(db: D1Database, userId: string, id: string, patch: { name?: unknown; scene?: unknown }) {
  const current = await getProject(db, userId, id);
  const name = patch.name === undefined ? current.name : cleanName(patch.name);
  const scene = patch.scene === undefined ? JSON.stringify(current.scene) : cleanScene(patch.scene);
  const t = now();
  if (scene !== JSON.stringify(current.scene)) {
    await db.prepare('INSERT INTO project_versions(project_id, scene, created_at) VALUES(?, ?, ?)').bind(id, JSON.stringify(current.scene), t).run();
    await db
      .prepare('DELETE FROM project_versions WHERE project_id = ? AND id NOT IN (SELECT id FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT ?)')
      .bind(id, id, MAX_VERSIONS)
      .run();
  }
  await db.prepare('UPDATE projects SET name = ?, scene = ?, updated_at = ? WHERE id = ? AND user_id = ?').bind(name, scene, t, id, userId).run();
  return getProject(db, userId, id);
}

export async function deleteProject(db: D1Database, userId: string, id: string) {
  const r = await db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Project not found.');
}

export async function listVersions(db: D1Database, userId: string, id: string) {
  await getProject(db, userId, id);
  const { results } = await db
    .prepare('SELECT id, created_at FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT 50')
    .bind(id)
    .all<{ id: number; created_at: number }>();
  return results.map((v) => ({ id: v.id, createdAt: v.created_at }));
}

export async function restoreVersion(db: D1Database, userId: string, id: string, versionId: number) {
  await getProject(db, userId, id);
  const v = await db.prepare('SELECT scene FROM project_versions WHERE id = ? AND project_id = ?').bind(versionId, id).first<{ scene: string }>();
  if (!v) throw new HttpError(404, 'Version not found.');
  return updateProject(db, userId, id, { scene: JSON.parse(v.scene) });
}

const FORMATS = ['html', 'snippet', 'zip', 'react'];
export async function logExport(db: D1Database, userId: string, projectId: string, format: unknown) {
  await getProject(db, userId, projectId);
  if (typeof format !== 'string' || !FORMATS.includes(format)) throw new HttpError(400, 'Unknown export format.');
  await db
    .prepare('INSERT INTO exports(id, project_id, user_id, format, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), projectId, userId, format, now())
    .run();
}

export async function listExports(db: D1Database, userId: string, projectId: string) {
  await getProject(db, userId, projectId);
  const { results } = await db
    .prepare('SELECT id, format, created_at FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
    .bind(projectId)
    .all<{ id: string; format: string; created_at: number }>();
  return results.map((e) => ({ id: e.id, format: e.format, createdAt: e.created_at }));
}
