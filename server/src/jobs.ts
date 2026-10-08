import { sanitizeText } from '../../src/lib/sanitize';
import { putJobFile, readAsset } from './assets';
import { balance, charge, ensureMonthlyGrant, refund } from './credits';
import { HttpError } from './http';
import { readKey } from './keys';
import { MODES, PendingError, STAGES } from './providers';
import type { Mode, ProviderRegistry } from './providers';
import type { D1Database, Env } from './types';

const now = () => Math.floor(Date.now() / 1000);

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
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

const COLUMNS = 'id, user_id, project_id, mode, status, stage, stage_done, error, cost, input, state, attempts';

export const jobView = (j: JobRow) => {
  const state = JSON.parse(j.state) as Record<string, unknown>;
  return {
    id: j.id,
    projectId: j.project_id,
    mode: j.mode,
    status: j.status,
    stage: j.status === 'failed' ? 'Failed' : j.stage,
    error: j.error,
    cost: j.cost,
    attempts: j.attempts,
    result: j.status === 'complete' ? { plan: state.plan ?? null, videoUrl: state.video ? `/api/jobs/${j.id}/video` : null } : null,
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
    note: provider ? undefined : 'This mode is not available yet.',
  };
}

export async function getJob(db: D1Database, userId: string, id: string): Promise<JobRow> {
  const j = await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ? AND user_id = ?`).bind(id, userId).first<JobRow>();
  if (!j) throw new HttpError(404, 'Job not found.');
  return j;
}

export async function listJobs(db: D1Database, userId: string, projectId: string) {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM jobs WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(userId, projectId)
    .all<JobRow>();
  return results.map(jobView);
}

export async function createJob(db: D1Database, env: Env, providers: ProviderRegistry, userId: string, body: Record<string, unknown>) {
  const mode = body.mode;
  if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) throw new HttpError(400, 'Choose a generation mode.');
  const idem = body.idempotencyKey;
  if (typeof idem !== 'string' || idem.length < 8 || idem.length > 80) throw new HttpError(400, 'An idempotencyKey of 8 to 80 characters is required.');
  const prompt = typeof body.prompt === 'string' ? sanitizeText(body.prompt) : '';
  if (!prompt) throw new HttpError(400, 'Describe the animation.');
  if (typeof body.projectId !== 'string') throw new HttpError(400, 'projectId is required.');

  // Same key from the same user returns the same job, never a second charge.
  const existing = await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE user_id = ? AND idempotency_key = ?`).bind(userId, idem).first<JobRow>();
  if (existing) return { job: existing, created: false };

  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(body.projectId, userId).first();
  if (!project) throw new HttpError(404, 'Project not found.');

  const m = mode as Mode;
  const provider = providers[m];
  if (!provider) throw new HttpError(501, `${MODES[m].label} mode is not available yet.`);

  let assetId: string | undefined;
  if (m !== 'free') {
    assetId = typeof body.assetId === 'string' ? body.assetId : undefined;
    const asset = assetId ? await db.prepare('SELECT asset_id FROM assets WHERE project_id = ? AND asset_id = ? AND user_id = ?').bind(body.projectId, assetId, userId).first() : null;
    if (!asset) throw new HttpError(400, 'Choose one of this project\'s images to animate.');
  }

  let keyProvider: string | undefined;
  if (m === 'byok') {
    keyProvider = typeof body.keyProvider === 'string' ? body.keyProvider : undefined;
    if (!keyProvider || (provider.keyProviders && !provider.keyProviders.includes(keyProvider))) {
      throw new HttpError(400, `This mode works with: ${(provider.keyProviders ?? ['a saved key']).join(', ')}.`);
    }
    if (!(await readKey(db, env.KEY_ENCRYPTION_SECRET, userId, keyProvider))) throw new HttpError(400, 'Connect an API key for that provider in Settings first.');
  }

  await ensureMonthlyGrant(db, userId);
  const cost = MODES[m].cost;
  const id = crypto.randomUUID();
  const t = now();
  await db
    .prepare(
      `INSERT INTO jobs(id, user_id, project_id, mode, provider_name, status, stage, cost, idempotency_key, input, attempts, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, userId, body.projectId, m, provider.id, STAGES[0], cost, idem, JSON.stringify({ prompt, keyProvider, assetId }), t, t)
    .run();

  if (!(await charge(db, userId, cost, `${MODES[m].label} generation`, `job:${id}:charge`))) {
    await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
    throw new HttpError(402, `This needs ${cost} credits and you have ${await balance(db, userId)}.`);
  }
  return { job: await getJob(db, userId, id), created: true };
}

/** Runs (or resumes) a job. Each finished stage is saved, so a retry continues where it stopped. */
export async function runJob(db: D1Database, env: Env, providers: ProviderRegistry, jobId: string): Promise<void> {
  const claimed = await db
    .prepare("UPDATE jobs SET status = 'running', error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
    .bind(now(), jobId)
    .run();
  if (!claimed.meta.changes) return;

  const job = (await db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;
  const provider = providers[job.mode];
  let apiKey: string | undefined;
  let state = JSON.parse(job.state) as Record<string, unknown>;
  try {
    if (!provider) throw new Error('This mode is not available.');
    const input = JSON.parse(job.input) as { prompt: string; keyProvider?: string; assetId?: string };
    if (job.mode === 'byok' && input.keyProvider) apiKey = (await readKey(db, env.KEY_ENCRYPTION_SECRET, job.user_id, input.keyProvider)) ?? undefined;
    const assets = {
      read: (assetId: string) => readAsset(env, job.user_id, job.project_id, assetId),
      putJobFile: (name: string, bytes: Uint8Array, type: string) => putJobFile(env, job.id, name, bytes, type),
    };

    for (let i = job.stage_done + 1; i < STAGES.length; i++) {
      await db.prepare('UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ?').bind(STAGES[i], now(), jobId).run();
      const out = await provider.step(STAGES[i], { input, state, apiKey, assets });
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
export async function resumeJobs(db: D1Database, env: Env, providers: ProviderRegistry): Promise<number> {
  const t = now();
  await db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running' AND updated_at < ?").bind(t - 300).run();
  const { results } = await db.prepare("SELECT id FROM jobs WHERE status = 'queued' AND updated_at < ? ORDER BY updated_at LIMIT 20").bind(t - 15).all<{ id: string }>();
  for (const r of results) await runJob(db, env, providers, r.id);
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
