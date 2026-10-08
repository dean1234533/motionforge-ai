import { clearCookie, createSession, getUser, login, logout, rateLimit, sessionCookie, signup, validateCredentials } from './auth';
import { balance, ensureMonthlyGrant } from './credits';
import { HttpError, json, readJson } from './http';
import { cancelJob, createJob, estimate, getJob, jobView, listJobs, retryJob, runJob } from './jobs';
import { listKeys, removeKey, saveKey, testKey } from './keys';
import { createProject, deleteProject, getProject, listExports, listProjects, listVersions, logExport, restoreVersion, updateProject } from './projects';
import { defaultProviders } from './providers';
import type { ProviderRegistry } from './providers';
import type { Env, UserRow } from './types';

export interface Deps {
  providers: ProviderRegistry;
  fetchFn: typeof fetch;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const defaults: Deps = { providers: defaultProviders, fetchFn: (...a) => fetch(...a) };

function secure(res: Response): Response {
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('referrer-policy', 'no-referrer');
  return res;
}

export async function handle(req: Request, env: Env, deps: Deps = defaults, ctx?: Ctx): Promise<Response> {
  try {
    return secure(await route(req, env, deps, ctx));
  } catch (e) {
    if (e instanceof HttpError) return secure(json({ error: e.message }, e.status));
    console.error('Unhandled error', e instanceof Error ? e.name : 'unknown');
    return secure(json({ error: 'Something went wrong. Please try again.' }, 500));
  }
}

async function route(req: Request, env: Env, deps: Deps, ctx?: Ctx): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const db = env.DB;

  if (!path.startsWith('/api/')) throw new HttpError(404, 'Not found.');

  // CSRF: browsers cannot send this custom header cross-site without a CORS preflight, which we never allow.
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers.get('x-requested-with') !== 'motionforge') throw new HttpError(403, 'Missing request header.');
    const origin = req.headers.get('origin');
    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'Origin not allowed.');
  }

  const ip = req.headers.get('cf-connecting-ip') ?? 'local';

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/auth/signup' && method === 'POST') {
    await rateLimit(db, `signup:${ip}`, 10, 3600);
    const b = await readJson(req);
    const { email, password } = validateCredentials(b.email, b.password);
    const user = await signup(db, email, password);
    await ensureMonthlyGrant(db, user.id);
    const token = await createSession(db, user.id);
    return json({ user }, 201, { 'set-cookie': sessionCookie(token) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const b = await readJson(req);
    const { email, password } = validateCredentials(b.email, b.password);
    await rateLimit(db, `login:${ip}:${email}`, 10, 900);
    const user = await login(db, email, password);
    const token = await createSession(db, user.id);
    return json({ user }, 200, { 'set-cookie': sessionCookie(token) });
  }

  const user: UserRow | null = await getUser(db, req);
  if (path === '/api/auth/logout' && method === 'POST') {
    await logout(db, req);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }
  if (!user) throw new HttpError(401, 'Please log in.');

  if (path === '/api/me' && method === 'GET') {
    await ensureMonthlyGrant(db, user.id);
    return json({ user, credits: await balance(db, user.id) });
  }

  // --- keys ---
  if (path === '/api/keys' && method === 'GET') return json({ keys: await listKeys(db, user.id) });
  let m = path.match(/^\/api\/keys\/([a-z]+)(\/test)?$/);
  if (m) {
    const provider = m[1];
    if (m[2] && method === 'POST') {
      await rateLimit(db, `keytest:${user.id}`, 20, 3600);
      return json(await testKey(db, env.KEY_ENCRYPTION_SECRET, user.id, provider, deps.fetchFn));
    }
    if (!m[2] && method === 'PUT') {
      await saveKey(db, env.KEY_ENCRYPTION_SECRET, user.id, provider, (await readJson(req)).apiKey);
      return json({ ok: true });
    }
    if (!m[2] && method === 'DELETE') {
      await removeKey(db, user.id, provider);
      return json({ ok: true });
    }
  }

  // --- projects ---
  if (path === '/api/projects' && method === 'GET') return json({ projects: await listProjects(db, user.id) });
  if (path === '/api/projects' && method === 'POST') {
    const b = await readJson(req);
    return json({ project: await createProject(db, user.id, b.name, b.scene) }, 201);
  }
  m = path.match(/^\/api\/projects\/([0-9a-f-]{36})(?:\/(versions|exports)(?:\/(\d+)\/restore)?)?$/);
  if (m) {
    const id = m[1];
    if (!m[2]) {
      if (method === 'GET') return json({ project: await getProject(db, user.id, id) });
      if (method === 'PUT') {
        const b = await readJson(req);
        return json({ project: await updateProject(db, user.id, id, { name: b.name, scene: b.scene }) });
      }
      if (method === 'DELETE') {
        await deleteProject(db, user.id, id);
        return json({ ok: true });
      }
    } else if (m[2] === 'versions') {
      if (method === 'GET' && !m[3]) return json({ versions: await listVersions(db, user.id, id) });
      if (method === 'POST' && m[3]) return json({ project: await restoreVersion(db, user.id, id, Number(m[3])) });
    } else if (m[2] === 'exports') {
      if (method === 'GET') return json({ exports: await listExports(db, user.id, id) });
      if (method === 'POST') {
        await logExport(db, user.id, id, (await readJson(req)).format);
        return json({ ok: true }, 201);
      }
    }
  }

  // --- generation ---
  if (path === '/api/estimate' && method === 'GET') {
    const e = estimate(url.searchParams.get('mode') ?? '', deps.providers);
    return json({ ...e, balance: await balance(db, user.id) });
  }
  if (path === '/api/jobs' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) throw new HttpError(400, 'projectId is required.');
    return json({ jobs: await listJobs(db, user.id, projectId) });
  }
  if (path === '/api/jobs' && method === 'POST') {
    await rateLimit(db, `jobs:${user.id}`, 30, 3600);
    const { job, created } = await createJob(db, env, deps.providers, user.id, await readJson(req));
    if (created) ctx?.waitUntil(runJob(db, env, deps.providers, job.id));
    return json({ job: jobView(job), credits: await balance(db, user.id) }, created ? 202 : 200);
  }
  m = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(retry|cancel))?$/);
  if (m) {
    const id = m[1];
    if (!m[2] && method === 'GET') return json({ job: jobView(await getJob(db, user.id, id)) });
    if (m[2] === 'retry' && method === 'POST') {
      await retryJob(db, user.id, id);
      ctx?.waitUntil(runJob(db, env, deps.providers, id));
      return json({ job: jobView(await getJob(db, user.id, id)) }, 202);
    }
    if (m[2] === 'cancel' && method === 'POST') {
      await cancelJob(db, user.id, id);
      return json({ job: jobView(await getJob(db, user.id, id)), credits: await balance(db, user.id) });
    }
  }

  throw new HttpError(404, 'Not found.');
}
