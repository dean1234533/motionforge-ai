import { sanitizeFilename } from '../../src/lib/sanitize';
import { HttpError } from './http';
import type { Env } from './types';

const now = () => Math.floor(Date.now() / 1000);
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_FRAMES_BYTES = 12 * 1024 * 1024;
const MAX_ASSETS_PER_PROJECT = 30;
const ID = /^[a-z0-9-]{1,40}$/;

/** Identify the real image type from its first bytes; the Content-Type header is not trusted. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp';
  return null;
}

export const assetKey = (userId: string, projectId: string, assetId: string) => `u/${userId}/p/${projectId}/a/${assetId}`;
const framesKey = (userId: string, projectId: string, assetId: string) => `${assetKey(userId, projectId, assetId)}.frames.json`;

async function requireProject(env: Env, userId: string, projectId: string): Promise<void> {
  const p = await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, userId).first();
  if (!p) throw new HttpError(404, 'Project not found.');
}

export function assertAssetId(id: string): void {
  if (!ID.test(id)) throw new HttpError(400, 'Invalid asset id.');
}

export async function saveAsset(env: Env, userId: string, projectId: string, assetId: string, rawName: string, bytes: Uint8Array) {
  assertAssetId(assetId);
  await requireProject(env, userId, projectId);
  if (bytes.length === 0) throw new HttpError(400, 'That file is empty.');
  if (bytes.length > MAX_ASSET_BYTES) throw new HttpError(413, 'Images can be up to 5 MB.');
  const mime = sniffImage(bytes);
  if (!mime) throw new HttpError(415, 'Only PNG, JPG and WebP images are accepted.');
  const existing = await env.DB.prepare('SELECT asset_id FROM assets WHERE project_id = ? AND asset_id = ?').bind(projectId, assetId).first();
  if (!existing) {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?').bind(projectId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ASSETS_PER_PROJECT) throw new HttpError(409, 'This project has reached its image limit.');
  }
  await env.FILES.put(assetKey(userId, projectId, assetId), bytes, { httpMetadata: { contentType: mime } });
  await env.DB.prepare(
    `INSERT INTO assets(project_id, asset_id, user_id, name, mime, bytes, has_frames, created_at) VALUES(?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(project_id, asset_id) DO UPDATE SET name = excluded.name, mime = excluded.mime, bytes = excluded.bytes, has_frames = 0`,
  )
    .bind(projectId, assetId, userId, sanitizeFilename(rawName), mime, bytes.length, now())
    .run();
  // A replaced source invalidates any saved generated frames.
  await env.FILES.delete(framesKey(userId, projectId, assetId));
}

export async function listAssets(env: Env, userId: string, projectId: string) {
  await requireProject(env, userId, projectId);
  const { results } = await env.DB.prepare('SELECT asset_id, name, mime, bytes, has_frames FROM assets WHERE project_id = ? ORDER BY created_at')
    .bind(projectId)
    .all<{ asset_id: string; name: string; mime: string; bytes: number; has_frames: number }>();
  return results.map((a) => ({ id: a.asset_id, name: a.name, mime: a.mime, bytes: a.bytes, hasFrames: a.has_frames === 1 }));
}

export async function readAsset(env: Env, userId: string, projectId: string, assetId: string) {
  assertAssetId(assetId);
  const row = await env.DB.prepare('SELECT mime FROM assets WHERE project_id = ? AND asset_id = ? AND user_id = ?').bind(projectId, assetId, userId).first<{ mime: string }>();
  const obj = row ? await env.FILES.get(assetKey(userId, projectId, assetId)) : null;
  if (!row || !obj) return null;
  return { bytes: new Uint8Array(await obj.arrayBuffer()), type: row.mime };
}

export async function deleteAsset(env: Env, userId: string, projectId: string, assetId: string) {
  assertAssetId(assetId);
  const r = await env.DB.prepare('DELETE FROM assets WHERE project_id = ? AND asset_id = ? AND user_id = ?').bind(projectId, assetId, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Image not found.');
  await env.FILES.delete([assetKey(userId, projectId, assetId), framesKey(userId, projectId, assetId)]);
}

/** Generated frames are stored as a JSON array of image data URLs. */
export async function saveFrames(env: Env, userId: string, projectId: string, assetId: string, text: string) {
  assertAssetId(assetId);
  if (text.length > MAX_FRAMES_BYTES) throw new HttpError(413, 'Those frames are too large.');
  let frames: unknown;
  try {
    frames = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Frames must be a JSON array.');
  }
  const ok = Array.isArray(frames) && frames.length >= 1 && frames.length <= 240 && frames.every((f) => typeof f === 'string' && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(f));
  if (!ok) throw new HttpError(400, 'Frames must be 1 to 240 base64 image data URLs.');
  const r = await env.DB.prepare('UPDATE assets SET has_frames = 1 WHERE project_id = ? AND asset_id = ? AND user_id = ?').bind(projectId, assetId, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'Image not found.');
  await env.FILES.put(framesKey(userId, projectId, assetId), text, { httpMetadata: { contentType: 'application/json' } });
}

export async function readFrames(env: Env, ownerId: string, projectId: string, assetId: string): Promise<string | null> {
  assertAssetId(assetId);
  const row = await env.DB.prepare('SELECT has_frames FROM assets WHERE project_id = ? AND asset_id = ? AND user_id = ?').bind(projectId, assetId, ownerId).first<{ has_frames: number }>();
  if (!row || row.has_frames !== 1) return null;
  const obj = await env.FILES.get(framesKey(ownerId, projectId, assetId));
  return obj ? new TextDecoder().decode(await obj.arrayBuffer()) : null;
}

export async function putJobFile(env: Env, jobId: string, name: string, bytes: Uint8Array, type: string) {
  await env.FILES.put(`jobs/${jobId}/${name}`, bytes, { httpMetadata: { contentType: type } });
}
export async function getJobFile(env: Env, jobId: string, name: string) {
  const obj = await env.FILES.get(`jobs/${jobId}/${name}`);
  return obj ? { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType ?? 'application/octet-stream' } : null;
}
