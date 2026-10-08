import { clearCookie, createSession, getUser, login, logout, rateLimit, sessionCookie, signup, validateCredentials } from './auth';
import { deleteAsset, getJobFile, listAssets, readAsset, readAssetRaw, readFramesRaw, saveAsset, saveFrames, MAX_ASSET_BYTES, MAX_FRAMES_BYTES, readFrames } from './assets';
import { billingSummary, createCheckout, createPortal, handleStripeEvent, verifyStripeSignature } from './billing';
import { balance, ensureMonthlyGrant } from './credits';
import { HttpError, json, readJson } from './http';
import { cancelJob, createJob, estimate, estimateTools, getJob, jobView, listJobs, retryJob, runJob } from './jobs';
import { listKeys, removeKey, saveKey, testKey } from './keys';
import { createProject, deleteProject, getProject, listExports, listProjects, listVersions, logExport, restoreVersion, updateProject } from './projects';
import { defaultProviders } from './providers';
import type { ProviderRegistry, Registry, ToolRegistry } from './providers';
import { providersFromEnv, toolsFromEnv } from './replicate';
import { createShare, getShared, listShares, revokeShare } from './shares';
import { acceptInvite, createTeam, deleteTeam, getTeam, inviteMember, listTeams, previewInvite, removeMember, revokeInvite, setMemberRole } from './teams';
import { projectAccess } from './access';
import { ensureSchema } from './schema';
import { sendMail } from './mail';
import type { Env, UserRow } from './types';

export interface Deps {
  /** Override the registries (tests). By default they are built from the environment. */
  providers?: ProviderRegistry;
  tools?: ToolRegistry;
  fetchFn: typeof fetch;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const defaults: Deps = { fetchFn: (...a) => fetch(...a) };

export const resolveRegistry = (env: Env, deps: Deps): Registry => ({
  modes: deps.providers ?? providersFromEnv(env, deps.fetchFn, defaultProviders),
  tools: deps.tools ?? toolsFromEnv(env, deps.fetchFn),
});

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

async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) throw new HttpError(413, 'That upload is too large.');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > max) throw new HttpError(413, 'That upload is too large.');
  return bytes;
}

const bin = (bytes: Uint8Array, type: string, cache = 'private, max-age=300') =>
  new Response(bytes as unknown as BodyInit, { headers: { 'content-type': type, 'cache-control': cache, 'content-security-policy': "default-src 'none'" } });

async function route(req: Request, rawEnv: Env, deps: Deps, ctx?: Ctx): Promise<Response> {
  const url = new URL(req.url);
  // Links in Stripe and email default to the address the app is being served from.
  const env: Env = rawEnv.APP_URL ? rawEnv : { ...rawEnv, APP_URL: url.origin };
  const path = url.pathname;
  const method = req.method;
  const db = env.DB;
  const reg = resolveRegistry(env, deps);
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';

  if (!path.startsWith('/api/')) throw new HttpError(404, 'Not found.');
  if (path === '/api/health') return json({ ok: true });
  await ensureSchema(env.DB);

  // Stripe calls this itself, so it cannot send our CSRF header. The signature is the authentication.
  if (path === '/api/webhooks/stripe' && method === 'POST') {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(501, 'Billing is not configured yet.');
    const payload = await req.text();
    if (payload.length > 1_000_000) throw new HttpError(413, 'Too large.');
    if (!(await verifyStripeSignature(payload, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'Invalid signature.');
    await handleStripeEvent(db, JSON.parse(payload));
    return json({ received: true });
  }

  // CSRF: browsers cannot send this custom header cross-site without a CORS preflight, which we never allow.
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers.get('x-requested-with') !== 'motionforge') throw new HttpError(403, 'Missing request header.');
    const origin = req.headers.get('origin');
    if (origin && env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'Origin not allowed.');
  }

  // Public, read-only shared projects.
  let m = path.match(/^\/api\/share\/([A-Za-z0-9_-]{16,64})(?:\/assets\/([a-z0-9-]{1,40})(\/frames)?)?$/);
  if (m && method === 'GET') {
    await rateLimit(db, `share:${ip}`, 240, 60);
    const shared = await getShared(env, m[1]);
    if (!m[2]) return json(shared.view);
    if (m[3]) {
      const frames = await readFramesRaw(env, shared.ownerId, shared.projectId, m[2]);
      if (!frames) throw new HttpError(404, 'No frames.');
      return bin(new TextEncoder().encode(frames), 'application/json');
    }
    const a = await readAssetRaw(env, shared.ownerId, shared.projectId, m[2]);
    if (!a) throw new HttpError(404, 'Image not found.');
    return bin(a.bytes, a.type);
  }

  // What an invitation is for, shown before the person signs in.
  m = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{16,64})$/);
  if (m && method === 'GET') {
    await rateLimit(db, `invite:${ip}`, 60, 60);
    return json(await previewInvite(db, m[1]));
  }

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

  // --- billing ---
  if (path === '/api/billing' && method === 'GET') return json(await billingSummary(env, user.id, user.plan));
  if (path === '/api/billing/checkout' && method === 'POST') {
    await rateLimit(db, `checkout:${user.id}`, 10, 3600);
    return json(await createCheckout(env, deps.fetchFn, user, (await readJson(req)).plan));
  }
  if (path === '/api/billing/portal' && method === 'POST') return json(await createPortal(env, deps.fetchFn, user.id));

  // --- keys ---
  if (path === '/api/keys' && method === 'GET') return json({ keys: await listKeys(db, user.id) });
  m = path.match(/^\/api\/keys\/([a-z]+)(\/test)?$/);
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

  // --- teams ---
  if (path === '/api/teams' && method === 'GET') return json({ teams: await listTeams(db, user.id) });
  if (path === '/api/teams' && method === 'POST') return json({ team: await createTeam(db, user, (await readJson(req)).name) }, 201);
  m = path.match(/^\/api\/teams\/([0-9a-f-]{36})(?:\/(invites|members)(?:\/([A-Za-z0-9_-]+))?)?$/);
  if (m) {
    const [, teamId, kind, sub] = m;
    if (!kind) {
      if (method === 'GET') return json({ team: await getTeam(db, user.id, teamId) });
      if (method === 'DELETE') {
        await deleteTeam(db, user.id, teamId);
        return json({ ok: true });
      }
    } else if (kind === 'invites') {
      if (method === 'POST' && !sub) {
        await rateLimit(db, `invite-create:${user.id}`, 30, 3600);
        const b = await readJson(req);
        return json(
          await inviteMember(db, user.id, teamId, b.email, b.role, {
            inviterEmail: user.email,
            appUrl: env.APP_URL,
            send: (mail) => sendMail(env, deps.fetchFn, mail),
          }),
          201,
        );
      }
      if (method === 'DELETE' && sub) {
        await revokeInvite(db, user.id, teamId, sub);
        return json({ ok: true });
      }
    } else if (kind === 'members' && sub) {
      if (method === 'PUT') {
        await setMemberRole(db, user.id, teamId, sub, (await readJson(req)).role);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await removeMember(db, user.id, teamId, sub);
        return json({ ok: true });
      }
    }
  }
  m = path.match(/^\/api\/invites\/([A-Za-z0-9_-]{16,64})\/accept$/);
  if (m && method === 'POST') return json(await acceptInvite(db, user, m[1]));

  // --- projects ---
  if (path === '/api/projects' && method === 'GET') return json({ projects: await listProjects(db, user.id) });
  if (path === '/api/projects' && method === 'POST') {
    const b = await readJson(req);
    return json({ project: await createProject(db, user, b.name, b.scene, b.teamId) }, 201);
  }
  m = path.match(/^\/api\/projects\/([0-9a-f-]{36})(?:\/(versions|exports|assets|shares)(?:\/([A-Za-z0-9_-]+))?(?:\/(restore|frames))?)?$/);
  if (m) {
    const id = m[1];
    const [, , kind, sub, action] = m;
    if (!kind) {
      if (method === 'GET') return json({ project: await getProject(db, user.id, id) });
      if (method === 'PUT') {
        const b = await readJson(req);
        return json({ project: await updateProject(db, user.id, id, { name: b.name, scene: b.scene, teamId: b.teamId }) });
      }
      if (method === 'DELETE') {
        await deleteProject(db, user.id, id);
        return json({ ok: true });
      }
    } else if (kind === 'versions') {
      if (method === 'GET' && !sub) return json({ versions: await listVersions(db, user.id, id) });
      if (method === 'POST' && sub && action === 'restore') return json({ project: await restoreVersion(db, user.id, id, Number(sub)) });
    } else if (kind === 'exports') {
      if (method === 'GET' && !sub) return json({ exports: await listExports(db, user.id, id) });
      if (method === 'POST' && !sub) {
        await logExport(db, user.id, id, (await readJson(req)).format);
        return json({ ok: true }, 201);
      }
    } else if (kind === 'shares') {
      if (method === 'GET' && !sub) return json({ shares: await listShares(env, user.id, id) });
      if (method === 'POST' && !sub) {
        await rateLimit(db, `share-create:${user.id}`, 30, 3600);
        return json(await createShare(env, user.id, id), 201);
      }
      if (method === 'DELETE' && sub) {
        await revokeShare(env, user.id, id, sub);
        return json({ ok: true });
      }
    } else if (kind === 'assets') {
      if (method === 'GET' && !sub) return json({ assets: await listAssets(env, user.id, id) });
      if (sub && !action) {
        if (method === 'PUT') {
          await rateLimit(db, `upload:${user.id}`, 120, 3600);
          const name = url.searchParams.get('name') ?? 'image';
          await saveAsset(env, user.id, id, sub, name, await readBytes(req, MAX_ASSET_BYTES));
          return json({ ok: true }, 201);
        }
        if (method === 'GET') {
          const a = await readAsset(env, user.id, id, sub);
          if (!a) throw new HttpError(404, 'Image not found.');
          return bin(a.bytes, a.type);
        }
        if (method === 'DELETE') {
          await deleteAsset(env, user.id, id, sub);
          return json({ ok: true });
        }
      }
      if (sub && action === 'frames') {
        if (method === 'PUT') {
          await saveFrames(env, user.id, id, sub, new TextDecoder().decode(await readBytes(req, MAX_FRAMES_BYTES)));
          return json({ ok: true }, 201);
        }
        if (method === 'GET') {
          const f = await readFrames(env, user.id, id, sub);
          if (!f) throw new HttpError(404, 'No frames.');
          return bin(new TextEncoder().encode(f), 'application/json');
        }
      }
    }
  }

  // --- generation ---
  if (path === '/api/estimate' && method === 'GET') {
    const e = estimate(url.searchParams.get('mode') ?? '', reg.modes);
    return json({ ...e, balance: await balance(db, user.id) });
  }
  if (path === '/api/modes' && method === 'GET') {
    return json({
      modes: (['free', 'fast', 'professional', 'byok'] as const).map((mode) => estimate(mode, reg.modes)),
      tools: estimateTools(reg),
      balance: await balance(db, user.id),
    });
  }
  if (path === '/api/jobs' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    if (!projectId) throw new HttpError(400, 'projectId is required.');
    return json({ jobs: await listJobs(db, user.id, projectId) });
  }
  if (path === '/api/jobs' && method === 'POST') {
    await rateLimit(db, `jobs:${user.id}`, 30, 3600);
    const { job, created } = await createJob(db, env, reg, user.id, await readJson(req));
    if (created) ctx?.waitUntil(runJob(db, env, reg, job.id));
    return json({ job: jobView(job), credits: await balance(db, user.id) }, created ? 202 : 200);
  }
  m = path.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(retry|cancel|video))?$/);
  if (m) {
    const id = m[1];
    if (!m[2] && method === 'GET') return json({ job: jobView(await getJob(db, user.id, id)) });
    if (m[2] === 'video' && method === 'GET') {
      const job = await getJob(db, user.id, id);
      await projectAccess(db, user.id, job.project_id, 'read');
      const v = await getJobFile(env, id, 'video.mp4');
      if (!v) throw new HttpError(404, 'No video.');
      return bin(v.bytes, v.type);
    }
    if (m[2] === 'retry' && method === 'POST') {
      await retryJob(db, user.id, id);
      ctx?.waitUntil(runJob(db, env, reg, id));
      return json({ job: jobView(await getJob(db, user.id, id)) }, 202);
    }
    if (m[2] === 'cancel' && method === 'POST') {
      await cancelJob(db, user.id, id);
      return json({ job: jobView(await getJob(db, user.id, id)), credits: await balance(db, user.id) });
    }
  }

  throw new HttpError(404, 'Not found.');
}
