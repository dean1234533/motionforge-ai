import { projectAccess } from './access';
import { randomToken } from './crypto';
import { HttpError } from './http';
import { getProject } from './projects';
import type { Env } from './types';

const now = () => Math.floor(Date.now() / 1000);

export async function createShare(env: Env, actorId: string, projectId: string) {
  await projectAccess(env.DB, actorId, projectId, 'write');
  const token = randomToken(24);
  await env.DB.prepare('INSERT INTO shares(token, project_id, user_id, created_at) VALUES(?, ?, ?, ?)').bind(token, projectId, actorId, now()).run();
  return { token };
}

export async function listShares(env: Env, actorId: string, projectId: string) {
  await projectAccess(env.DB, actorId, projectId, 'write');
  const { results } = await env.DB.prepare('SELECT token, created_at FROM shares WHERE project_id = ? ORDER BY created_at DESC')
    .bind(projectId)
    .all<{ token: string; created_at: number }>();
  return results.map((s) => ({ token: s.token, createdAt: s.created_at }));
}

export async function revokeShare(env: Env, actorId: string, projectId: string, token: string) {
  await projectAccess(env.DB, actorId, projectId, 'write');
  const r = await env.DB.prepare('DELETE FROM shares WHERE token = ? AND project_id = ?').bind(token, projectId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Share link not found.');
}

/** Public, read-only view. Exposes the scene and asset ids, never the owner. */
export async function getShared(env: Env, token: string) {
  const s = await env.DB.prepare('SELECT s.project_id, p.user_id FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.token = ?')
    .bind(token)
    .first<{ project_id: string; user_id: string }>();
  if (!s) throw new HttpError(404, 'This link is no longer available.');
  const project = await getProject(env.DB, s.user_id, s.project_id);
  const { results } = await env.DB.prepare('SELECT asset_id, has_frames, hd FROM assets WHERE project_id = ?').bind(s.project_id).all<{ asset_id: string; has_frames: number; hd: number }>();
  return {
    ownerId: s.user_id,
    projectId: s.project_id,
    view: { name: project.name, scene: project.scene, assets: results.map((a) => ({ id: a.asset_id, hasFrames: a.has_frames === 1, hd: a.hd === 1 })) },
  };
}
