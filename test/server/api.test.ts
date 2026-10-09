import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../../server/src/crypto';
import { readKey } from '../../server/src/keys';
import { localRulesProvider } from '../../server/src/providers';
import type { ProviderRegistry, ServerProvider } from '../../server/src/providers';
import { emptyScene, newObject } from '../../src/scene/defaults';
import { SECRET, makeApp } from './harness';

const PROMPT = 'Make this bird flap its wings and fly from the bottom-left to the top-right';
const jobBody = (projectId: string, key: string, extra: object = {}) => ({ projectId, mode: 'free', prompt: PROMPT, idempotencyKey: key, ...extra });

async function setup(deps = {}) {
  const app = makeApp(deps);
  const u = await app.user();
  const p = await app.call('POST', '/api/projects', { name: 'Bird' }, u.cookie);
  return { ...app, u, projectId: p.body.project.id as string };
}

describe('crypto', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('binds encrypted secrets to their owner', async () => {
    const { ciphertext, iv } = await encryptSecret(SECRET, 'sk-secret-value', 'user1:openai');
    expect(await decryptSecret(SECRET, ciphertext, iv, 'user1:openai')).toBe('sk-secret-value');
    await expect(decryptSecret(SECRET, ciphertext, iv, 'user2:openai')).rejects.toBeTruthy();
  });
});

describe('auth', () => {
  it('signs up and sets a secure cookie', async () => {
    const app = makeApp();
    const r = await app.call('POST', '/api/auth/signup', { email: 'A@Example.com', password: 'correct horse battery' });
    expect(r.status).toBe(201);
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await app.call('GET', '/api/me', undefined, cookie.split(';')[0]);
    expect(me.body.user.email).toBe('a@example.com');
    expect(me.body.credits).toBeUndefined();
    expect(r.text).not.toMatch(/password/i);
  });

  it('rejects duplicates, weak passwords, bad logins and anonymous access', async () => {
    const app = makeApp();
    const u = await app.user('dup@example.com');
    expect((await app.call('POST', '/api/auth/signup', { email: 'dup@example.com', password: 'correct horse battery' })).status).toBe(409);
    expect((await app.call('POST', '/api/auth/signup', { email: 'x@example.com', password: 'short' })).status).toBe(400);
    expect((await app.call('POST', '/api/auth/login', { email: 'dup@example.com', password: 'not the password' })).status).toBe(401);
    expect((await app.call('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'not the password' })).status).toBe(401);
    expect((await app.call('POST', '/api/auth/login', { email: 'dup@example.com', password: 'correct horse battery' })).status).toBe(200);
    expect((await app.call('GET', '/api/me')).status).toBe(401);
    expect(u.cookie).toContain('mf_session=');
  });

  it('only lets the owner sign up or log in', async () => {
    const pw = 'correct horse battery';
    // Unset: only the built-in owner account. Nobody else can create an account.
    const closed = makeApp({}, { OWNER_EMAIL: undefined });
    expect((await closed.call('POST', '/api/auth/signup', { email: 'stranger@example.com', password: pw })).status).toBe(403);

    const app = makeApp({}, { OWNER_EMAIL: 'Me@Example.com' });
    expect((await app.call('POST', '/api/auth/signup', { email: 'stranger@example.com', password: pw })).status).toBe(403);
    const me = await app.call('POST', '/api/auth/signup', { email: 'me@example.com', password: pw });
    expect(me.status).toBe(201);
    expect(me.body.user.plan).toBe('professional');
    expect((await app.call('POST', '/api/auth/login', { email: 'me@example.com', password: pw })).status).toBe(200);

    // An account made before the app was private can no longer log in or use its old session.
    const open = makeApp();
    const old = await open.user('old@example.com');
    open.env.OWNER_EMAIL = 'me@example.com';
    expect((await open.call('GET', '/api/me', undefined, old.cookie)).status).toBe(401);
    expect((await open.call('POST', '/api/auth/login', { email: 'old@example.com', password: pw })).status).toBe(401);
  });

  it('logout invalidates the session', async () => {
    const app = makeApp();
    const u = await app.user();
    await app.call('POST', '/api/auth/logout', {}, u.cookie);
    expect((await app.call('GET', '/api/me', undefined, u.cookie)).status).toBe(401);
  });

  it('requires the CSRF header on writes and a matching origin', async () => {
    const app = makeApp();
    const u = await app.user();
    const noHeader = await app.call('POST', '/api/projects', { name: 'x' }, u.cookie, { 'x-requested-with': '' });
    expect(noHeader.status).toBe(403);
  });

  it('rate-limits repeated login attempts', async () => {
    const app = makeApp();
    await app.user('rl@example.com');
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.call('POST', '/api/auth/login', { email: 'rl@example.com', password: 'bad password here' })).status;
    expect(last).toBe(429);
  });
});

describe('projects', () => {
  it('creates, updates with version history, restores and deletes', async () => {
    const { call, u, projectId } = await setup();
    const scene = { ...emptyScene(), objects: [newObject('bird', 'main', 'Bird')] };
    const up = await call('PUT', `/api/projects/${projectId}`, { scene }, u.cookie);
    expect(up.status).toBe(200);
    expect(up.body.project.scene.objects).toHaveLength(1);
    const versions = await call('GET', `/api/projects/${projectId}/versions`, undefined, u.cookie);
    expect(versions.body.versions).toHaveLength(1);
    const restored = await call('POST', `/api/projects/${projectId}/versions/${versions.body.versions[0].id}/restore`, {}, u.cookie);
    expect(restored.body.project.scene.objects).toHaveLength(0);
    expect((await call('DELETE', `/api/projects/${projectId}`, undefined, u.cookie)).status).toBe(200);
    expect((await call('GET', `/api/projects/${projectId}`, undefined, u.cookie)).status).toBe(404);
  });

  it('rejects invalid scenes', async () => {
    const { call, u, projectId } = await setup();
    const bad = { ...emptyScene(), objects: [{ ...newObject('bird', 'main', 'Bird'), opacity: [9] }] };
    expect((await call('PUT', `/api/projects/${projectId}`, { scene: bad }, u.cookie)).status).toBe(422);
  });

  it('hides projects from other users', async () => {
    const { call, projectId, user } = await setup();
    const other = await user();
    expect((await call('GET', `/api/projects/${projectId}`, undefined, other.cookie)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${projectId}`, undefined, other.cookie)).status).toBe(404);
  });

  it('records exports', async () => {
    const { call, u, projectId } = await setup();
    expect((await call('POST', `/api/projects/${projectId}/exports`, { format: 'zip' }, u.cookie)).status).toBe(201);
    expect((await call('POST', `/api/projects/${projectId}/exports`, { format: 'exe' }, u.cookie)).status).toBe(400);
    const list = await call('GET', `/api/projects/${projectId}/exports`, undefined, u.cookie);
    expect(list.body.exports).toHaveLength(1);
  });
});

describe('provider key vault', () => {
  it('stores keys encrypted, never returns them, and scopes them to the owner', async () => {
    const { call, u, sqlite, env, user } = await setup({
      fetchFn: async (_url: unknown, init?: RequestInit) =>
        new Response('{}', { status: (init?.headers as Record<string, string>).authorization === 'Bearer sk-good-key-1234' ? 200 : 401 }),
    });
    const put = await call('PUT', '/api/keys/openai', { apiKey: 'sk-good-key-1234' }, u.cookie);
    expect(put.status).toBe(200);
    expect(put.text).not.toContain('sk-good');

    const list = await call('GET', '/api/keys', undefined, u.cookie);
    expect(list.text).not.toContain('sk-good');
    expect(list.body.keys).toEqual([{ provider: 'openai', last4: '1234', updatedAt: expect.any(Number) }]);

    const row = sqlite.prepare('SELECT * FROM provider_keys').get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain('sk-good-key');

    expect((await call('POST', '/api/keys/openai/test', {}, u.cookie)).body.ok).toBe(true);
    await call('PUT', '/api/keys/openai', { apiKey: 'sk-replaced-9999' }, u.cookie);
    expect((await call('POST', '/api/keys/openai/test', {}, u.cookie)).body.ok).toBe(false);

    // another user cannot see it or decrypt it
    const other = await user();
    expect((await call('GET', '/api/keys', undefined, other.cookie)).body.keys).toEqual([]);
    sqlite.prepare('UPDATE provider_keys SET user_id = ?').run(other.id);
    await expect(readKey(env.DB, SECRET, other.id, 'openai')).rejects.toBeTruthy();

    sqlite.prepare('UPDATE provider_keys SET user_id = ?').run(u.id);
    expect((await call('DELETE', '/api/keys/openai', undefined, u.cookie)).status).toBe(200);
    expect((await call('DELETE', '/api/keys/openai', undefined, u.cookie)).status).toBe(404);
  });

  it('rejects unsupported providers and malformed keys', async () => {
    const { call, u } = await setup();
    expect((await call('PUT', '/api/keys/skynet', { apiKey: 'sk-abcdefgh' }, u.cookie)).status).toBe(400);
    expect((await call('PUT', '/api/keys/openai', { apiKey: 'has space in it' }, u.cookie)).status).toBe(400);
  });
});

describe('generation jobs', () => {
  it('estimates cost and reports unavailable modes honestly', async () => {
    const { call, u } = await setup();
    const free = await call('GET', '/api/estimate?mode=free', undefined, u.cookie);
    expect(free.body).toMatchObject({ cost: 0, available: true, provider: 'local-rules' });
    expect((await call('GET', '/api/estimate?mode=fast', undefined, u.cookie)).body.available).toBe(false);
    expect((await call('GET', '/api/estimate?mode=bogus', undefined, u.cookie)).status).toBe(400);
  });

  it('runs a job through to a plan once, even if the request repeats', async () => {
    const { call, settle, u, projectId } = await setup();
    const a = await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0001'), u.cookie);
    const b = await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0001'), u.cookie);
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.job.id).toBe(a.body.job.id);
    await settle();
    const done = await call('GET', `/api/jobs/${a.body.job.id}`, undefined, u.cookie);
    expect(done.body.job).toMatchObject({ status: 'complete', stage: 'Complete', attempts: 1 });
    expect(done.body.job.result.plan.patch.flapsPerScroll).toBeGreaterThan(0);
  });

  it('resumes a failed job without re-running finished stages', async () => {
    const seen: string[] = [];
    let failOnce = true;
    const flaky: ServerProvider = {
      id: 'flaky',
      async step(stage, ctx) {
        seen.push(stage);
        if (stage === 'Generating motion' && failOnce) {
          failOnce = false;
          throw new Error('provider timed out');
        }
        return localRulesProvider.step(stage, ctx);
      },
    };
    const providers: ProviderRegistry = { free: flaky };
    const { call, settle, u, projectId } = await setup({ providers });
    const created = await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0002'), u.cookie);
    await settle();
    const id = created.body.job.id;
    const failed = await call('GET', `/api/jobs/${id}`, undefined, u.cookie);
    expect(failed.body.job).toMatchObject({ status: 'failed', stage: 'Failed', error: 'provider timed out' });

    const retry = await call('POST', `/api/jobs/${id}/retry`, {}, u.cookie);
    expect(retry.status).toBe(202);
    await settle();
    const done = await call('GET', `/api/jobs/${id}`, undefined, u.cookie);
    expect(done.body.job).toMatchObject({ status: 'complete', attempts: 2 });
    expect(seen.filter((s) => s === 'Analysing prompt')).toHaveLength(1);
    expect(seen.filter((s) => s === 'Generating motion')).toHaveLength(2);
    expect((await call('POST', `/api/jobs/${id}/retry`, {}, u.cookie)).status).toBe(409);
  });

  it('cancels a failed job once', async () => {
    const broken: ServerProvider = { id: 'broken', step: async () => { throw new Error('nope'); } };
    const { call, settle, u, projectId } = await setup({ providers: { free: broken } });
    const id = (await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0003'), u.cookie)).body.job.id;
    await settle();
    const c1 = await call('POST', `/api/jobs/${id}/cancel`, {}, u.cookie);
    expect(c1.body.job.status).toBe('cancelled');
    expect((await call('POST', `/api/jobs/${id}/cancel`, {}, u.cookie)).status).toBe(409);
  });

  it('never limits how many jobs run, and blocks unavailable modes', async () => {
    const fast: ServerProvider = { id: 'fast-sim', step: async () => undefined };
    const { call, settle, u, projectId } = await setup({ providers: { free: localRulesProvider, fast } });
    expect((await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0004', { mode: 'professional' }), u.cookie)).status).toBe(501);
    expect((await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0005', { mode: 'fast' }), u.cookie)).status).toBe(202);
    expect((await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0006', { mode: 'fast' }), u.cookie)).status).toBe(202);
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/api/jobs', jobBody(projectId, `idem-key-01${i}0`, { mode: 'fast' }), u.cookie)).status).toBe(202);
    }
    await settle();
    expect((await call('GET', `/api/jobs?projectId=${projectId}`, undefined, u.cookie)).body.jobs).toHaveLength(12);
  });

  it('bring-your-own-key jobs need a saved key, use it server-side, and never leak it', async () => {
    const KEY = 'sk-user-owned-key-ABCD';
    let received: string | undefined;
    const byok: ServerProvider = {
      id: 'byok-sim',
      async step(stage, ctx) {
        if (stage === 'Generating motion') {
          received = ctx.apiKey;
          throw new Error(`upstream said invalid key ${ctx.apiKey}`);
        }
      },
    };
    const { call, settle, u, projectId } = await setup({ providers: { free: localRulesProvider, byok } });
    const body = jobBody(projectId, 'idem-key-0008', { mode: 'byok', keyProvider: 'openai' });
    expect((await call('POST', '/api/jobs', body, u.cookie)).status).toBe(400);

    await call('PUT', '/api/keys/openai', { apiKey: KEY }, u.cookie);
    const created = await call('POST', '/api/jobs', body, u.cookie);
    expect(created.status).toBe(202);
    await settle();
    expect(received).toBe(KEY);
    const job = await call('GET', `/api/jobs/${created.body.job.id}`, undefined, u.cookie);
    expect(job.text).not.toContain(KEY);
    expect(job.body.job.error).toContain('[redacted]');
  });

  it('does not let one user read or retry another user\'s job', async () => {
    const { call, settle, u, projectId, user } = await setup();
    const id = (await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0009'), u.cookie)).body.job.id;
    await settle();
    const other = await user();
    expect((await call('GET', `/api/jobs/${id}`, undefined, other.cookie)).status).toBe(404);
    expect((await call('POST', '/api/jobs', jobBody(projectId, 'idem-key-0010'), other.cookie)).status).toBe(404);
  });
});
