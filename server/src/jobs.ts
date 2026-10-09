import { sanitizeText } from '../../src/lib/sanitize';
import { projectAccess } from './access';
import { putJobFile, readAssetRaw, saveAsset } from './assets';
import { balance, charge, ensureMonthlyGrant, refund } from './credits';
import { HttpError } from './http';
import { readKey } from './keys';
import { MODES, PendingError, TOOLS, stagesFor } from './providers';
import type { JobKind, Mode, ProviderRegistry, Registry, ServerProvider } from './providers';
import type { D1Database, Env } from './types';

const now = () => Math.floor(Date.now() / 1000);

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  kind: JobKind;
  mode: Mode;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  stage: string;
  stage_done: number;
  error: string | null;
  cost: number;
  input: string;
  state: string;
  attempts: number;
}

const COLUMNS = 'id, user_id, project_id, kind, mode, status, stage, stage_done, error, cost, input, state, attempts';
const KINDS: JobKind[] = ['motion', 'image-gen', 'upscale'];

export const jobView = (j: JobRow) => {
  const state = JSON.parse(j.state) as Record<string, unknown>;
  return {
    id: j.id,
    projectId: j.project_id,
    kind: j.kind,
    mode: j.mode,
    status: j.status,
    stage: j.status === 'failed' ? 'Failed' : j.stage,
    error: j.error,
    cost: j.cost,
    attempts: j.attempts,
    result:
      j.status === 'complete'
        ? { plan: state.plan ?? null, videoUrl: state.video ? `/api/jobs/${j.id}/video` : null, assetId: (state.assetId as string | undefined) ?? null }
        : null,
  };
};

export function estimate(mode: string, providers: ProviderRegistry) {
  if (!Object.hasOwn(MODES, mode)) throw new HttpError(400, 'Unknown generation mode.');
  const m = mode as Mode;
  const provider = providers[m];
  return {
    mode: m,
    label: MODES[m].label,
    cost: MODES[m].cost,
    provider: provider?.id ?? null,
    available: Boolean(provider),
    generatesMotion: Boolean(provider?.generatesMotion),
    note: provider ? undefined : 'This mode is not available yet.',
  };
}

export function estimateTools(reg: Registry) {
  return (['image-gen', 'upscale'] as const).map((kind) => {
    const p = reg.tools[kind];
    return {
      kind,
      label: TOOLS[kind].label,
      cost: TOOLS[kind].cost,
      ownKeyCost: 0,
      provider: p?.id ?? null,
      keyProvider: p?.keyProviders?.[0] ?? null,
      available: Boolean(p),
      /** True when credits can pay for it (the server holds a key). Otherwise only "your own key" works. */
      platformKey: Boolean(p?.platformKey),
    };
  });
}

export async function getJob(db: D1Database, userId: string, id: string): Promise<JobRow> {
  const j = await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ? AND user_id = ?`).bind(id, userId).first<JobRow>();
  if (!j) throw new HttpError(404, 'Job not found.');
  return j;
}

export async function listJobs(db: D1Database, userId: string, projectId: string) {
  await projectAccess(db, userId, projectId, 'read');
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM jobs WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(userId, projectId)
    .all<JobRow>();
  return results.map(jobView);
}

export async function createJob(db: D1Database, env: Env, reg: Registry, userId: string, body: Record<string, unknown>) {
  const kind = (body.kind ?? 'motion') as JobKind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown job type.');
  const idem = body.idempotencyKey;
  if (typeof idem !== 'string' || idem.length < 8 || idem.length > 80) throw new HttpError(400, 'An idempotencyKey of 8 to 80 characters is required.');
  if (typeof body.projectId !== 'string') throw new HttpError(400, 'projectId is required.');
  const promptRaw = typeof body.prompt === 'string' ? sanitizeText(body.prompt) : '';
  if (!promptRaw && kind !== 'upscale') throw new HttpError(400, 'Describe what you want.');
  const prompt = promptRaw || 'upscale';

  // Same key from the same user returns the same job, never a second charge.
  const existing = await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE user_id = ? AND idempotency_key = ?`).bind(userId, idem).first<JobRow>();
  if (existing) return { job: existing, created: false };

  await projectAccess(db, userId, body.projectId, 'write');

  // Work out which provider, label and price this job uses.
  let provider: ServerProvider | undefined;
  let mode: Mode = 'free';
  let label: string;
  let cost: number;
  let useOwnKey = false;
  if (kind === 'motion') {
    if (typeof body.mode !== 'string' || !Object.hasOwn(MODES, body.mode)) throw new HttpError(400, 'Choose a generation mode.');
    mode = body.mode as Mode;
    provider = reg.modes[mode];
    label = MODES[mode].label;
    cost = MODES[mode].cost;
    useOwnKey = mode === 'byok';
  } else {
    provider = reg.tools[kind];
    label = TOOLS[kind].label;
    useOwnKey = body.useOwnKey === true;
    cost = useOwnKey ? 0 : TOOLS[kind].cost;
    if (useOwnKey) mode = 'byok';
  }
  if (!provider) throw new HttpError(501, `${label} is not available yet.`);
  if (kind === 'motion' && body.realistic === true && !provider.generatesMotion) {
    throw new HttpError(400, 'Realistic subject actions require an image-to-video provider. Choose Fast, Professional or bring your own Replicate key.');
  }
  if (!useOwnKey && kind !== 'motion' && !provider.platformKey) {
    throw new HttpError(400, `${label} is not paid for by this server. Connect your own key in Settings and choose “use my own key”.`);
  }

  let assetId: string | undefined;
  let sourceName: string | undefined;
  if (provider.needsImage) {
    assetId = typeof body.assetId === 'string' ? body.assetId : undefined;
    const asset = assetId ? await db.prepare('SELECT name FROM assets WHERE project_id = ? AND asset_id = ?').bind(body.projectId, assetId).first<{ name: string }>() : null;
    if (!asset) throw new HttpError(400, 'Choose one of this project\'s images.');
    sourceName = asset.name;
  }

  let keyProvider: string | undefined;
  if (useOwnKey) {
    keyProvider = typeof body.keyProvider === 'string' ? body.keyProvider : provider.keyProviders?.[0];
    if (!keyProvider || (provider.keyProviders && !provider.keyProviders.includes(keyProvider))) {
      throw new HttpError(400, `This works with: ${(provider.keyProviders ?? ['a saved key']).join(', ')}.`);
    }
    if (!(await readKey(db, env.KEY_ENCRYPTION_SECRET, userId, keyProvider))) throw new HttpError(400, 'Connect an API key for that provider in Settings first.');
  }

  const scale = body.scale === 4 ? 4 : 2;
  await ensureMonthlyGrant(db, userId);
  const id = crypto.randomUUID();
  const t = now();
  await db
    .prepare(
      `INSERT INTO jobs(id, user_id, project_id, kind, mode, provider_name, status, stage, cost, idempotency_key, input, attempts, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, userId, body.projectId, kind, mode, provider.id, stagesFor(kind)[0], cost, idem, JSON.stringify({ prompt, keyProvider, assetId, sourceName, scale }), t, t)
    .run();

  if (!(await charge(db, userId, cost, `${label}`, `job:${id}:charge`))) {
    await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
    throw new HttpError(402, `This needs ${cost} credits and you have ${await balance(db, userId)}.`);
  }
  return { job: await getJob(db, userId, id), created: true };
}

/** Runs (or resumes) a job. Each finished stage is saved, so a retry continues where it stopped. */
export async function runJob(db: D1Database, env: Env, reg: Registry, jobId: string): Promise<void> {
  const claimed = await db
    .prepare("UPDATE jobs SET status = 'running', error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
    .bind(now(), jobId)
    .run();
  if (!claimed.meta.changes) return;

  const job = (await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;
  const provider = job.kind === 'motion' ? reg.modes[job.mode] : reg.tools[job.kind];
  const stages = stagesFor(job.kind);
  let apiKey: string | undefined;
  let state = JSON.parse(job.state) as Record<string, unknown>;
  try {
    if (!provider) throw new Error('This is not available.');
    const input = JSON.parse(job.input) as { prompt: string; keyProvider?: string; assetId?: string; sourceName?: string; scale?: number };
    if (input.keyProvider) apiKey = (await readKey(db, env.KEY_ENCRYPTION_SECRET, job.user_id, input.keyProvider)) ?? undefined;
    const owner = await db.prepare('SELECT user_id FROM projects WHERE id = ?').bind(job.project_id).first<{ user_id: string }>();
    if (!owner) throw new Error('The project no longer exists.');
    const assets = {
      read: (assetId: string) => readAssetRaw(env, owner.user_id, job.project_id, assetId),
      putJobFile: (name: string, bytes: Uint8Array, type: string) => putJobFile(env, job.id, name, bytes, type),
      saveAsset: (assetId: string, name: string, bytes: Uint8Array, hd = false) => saveAsset(env, job.user_id, job.project_id, assetId, name, bytes, hd),
    };

    for (let i = job.stage_done + 1; i < stages.length; i++) {
      await db.prepare('UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ?').bind(stages[i], now(), jobId).run();
      const out = await provider.step(stages[i], { kind: job.kind, input, state, apiKey, assets });
      if (out) state = { ...state, ...out };
      await db.prepare('UPDATE jobs SET stage_done = ?, state = ?, updated_at = ? WHERE id = ?').bind(i, JSON.stringify(state), now(), jobId).run();
    }
    await db.prepare("UPDATE jobs SET status = 'complete', stage = 'Complete', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
  } catch (e) {
    if (e instanceof PendingError) {
      // Remote work is still going. Park the job; the cron resumer will poll it again.
      state = { ...state, ...e.statePatch };
      await db.prepare("UPDATE jobs SET status = 'queued', state = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(state), now(), jobId).run();
      return;
    }
    let message = e instanceof Error ? e.message : 'The job failed.';
    if (apiKey) message = message.split(apiKey).join('[redacted]');
    await db.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(message.slice(0, 300), now(), jobId).run();
  }
}

/** Cron entry point: resume parked jobs, and rescue ones whose worker died mid-run. */
export async function resumeJobs(db: D1Database, env: Env, reg: Registry, limit = 20): Promise<number> {
  const t = now();
  await db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running' AND updated_at < ?").bind(t - 300).run();
  // Priority processing: Professional-plan jobs go first, then oldest first.
  const { results } = await db
    .prepare(
      `SELECT j.id FROM jobs j JOIN users u ON u.id = j.user_id
       WHERE j.status = 'queued' AND j.updated_at < ?
       ORDER BY (u.plan = 'professional') DESC, j.updated_at LIMIT ?`,
    )
    .bind(t - 15, limit)
    .all<{ id: string }>();
  for (const r of results) await runJob(db, env, reg, r.id);
  return results.length;
}

/** Retrying never charges again: the original charge row is unique per job. */
export async function retryJob(db: D1Database, userId: string, id: string): Promise<void> {
  const j = await getJob(db, userId, id);
  if (j.status !== 'failed') throw new HttpError(409, 'Only failed jobs can be retried.');
  await db.prepare("UPDATE jobs SET status = 'queued', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'failed'").bind(now(), id).run();
}

export async function cancelJob(db: D1Database, userId: string, id: string): Promise<void> {
  const j = await getJob(db, userId, id);
  if (j.status !== 'failed') throw new HttpError(409, 'Only failed jobs can be cancelled.');
  const r = await db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'failed'").bind(now(), id).run();
  if (r.meta.changes) await refund(db, userId, j.cost, 'Refund for cancelled job', `job:${id}:refund`);
}
