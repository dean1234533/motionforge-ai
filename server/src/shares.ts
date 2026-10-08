import { randomToken } from './crypto';
import { HttpError } from './http';
import type { Env } from './types';
import { getProject } from './projects';

const now = () => Math.floor(Date.now() / 1000);

export async function createShare(env: Env, userId: string, projectId: string) {
  await getProject(env.DB, userId, projectId);
  const token = randomToken(24);
  await env.DB.prepare('INSERT INTO shares(token, project_id, user_id, created_at) VALUES(?, ?, ?, ?)').bind(token, projectId, userId, now()).run();
  return { token };
}

export async function listShares(env: Env, userId: string, projectId: string) {
  await getProject(env.DB, userId, projectId);
  const { results } = await env.DB.prepare('SELECT token, created_at FROM shares WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC')
    .bind(projectId, userId)
    .all<{ token: string; created_at: number }>();
  return results.map((s) => ({ token: s.token, createdAt: s.created_at }));
}

export async function revokeShare(env: Env, userId: string, token: string) {
  const r = await env.DB.prepare('DELETE FROM shares WHERE token = ? AND user_id = ?').bind(token, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Share link not found.');
}

/** Public, read-only view. Exposes the scene and asset ids, never the owner. */
export async function getShared(env: Env, token: string) {
  const s = await env.DB.prepare('SELECT project_id, user_id FROM shares WHERE token = ?').bind(token).first<{ project_id: string; user_id: string }>();
  if (!s) throw new HttpError(404, 'This link is no longer available.');
  const project = await getProject(env.DB, s.user_id, s.project_id);
  const { results } = await env.DB.prepare('SELECT asset_id, has_frames FROM assets WHERE project_id = ?').bind(s.project_id).all<{ asset_id: string; has_frames: number }>();
  return {
    ownerId: s.user_id,
    projectId: s.project_id,
    view: { name: project.name, scene: project.scene, assets: results.map((a) => ({ id: a.asset_id, hasFrames: a.has_frames === 1 })) },
  };
}
