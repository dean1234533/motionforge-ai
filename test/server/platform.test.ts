import { describe, expect, it } from 'vitest';
import { signForTest } from '../../server/src/billing';
import { emptyScene, newObject } from '../../src/scene/defaults';
import { makeApp } from './harness';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const FRAME = 'data:image/png;base64,iVBORw0KGgo=';

async function setup(deps = {}, envExtra = {}) {
  const app = makeApp(deps, envExtra);
  const u = await app.user();
  const p = await app.call('POST', '/api/projects', { name: 'Bird' }, u.cookie);
  return { ...app, u, projectId: p.body.project.id as string };
}

describe('assets', () => {
  it('stores, lists, serves and deletes images, checking the real file type', async () => {
    const { call, raw, u, projectId } = await setup();
    const base = `/api/projects/${projectId}/assets/bird-1`;
    expect((await raw('PUT', `${base}?name=${encodeURIComponent('../my bird<1>.png')}`, PNG, u.cookie, 'image/png')).status).toBe(201);

    const list = await call('GET', `/api/projects/${projectId}/assets`, undefined, u.cookie);
    expect(list.body.assets).toEqual([{ id: 'bird-1', name: 'my-bird1.png', mime: 'image/png', bytes: PNG.length, hasFrames: false, hd: false }]);

    const got = await call('GET', base, undefined, u.cookie);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(Array.from(got.bytes)).toEqual(Array.from(PNG));

    // a text file claiming to be a PNG is refused
    const fake = await raw('PUT', `/api/projects/${projectId}/assets/evil`, new TextEncoder().encode('<script>alert(1)</script>'), u.cookie, 'image/png');
    expect(fake.status).toBe(415);
    expect((await raw('PUT', `${base}x`, new Uint8Array(0), u.cookie)).status).toBe(400);
    expect((await raw('PUT', `/api/projects/${projectId}/assets/BAD_ID`, PNG, u.cookie)).status).toBe(400);

    expect((await call('DELETE', base, undefined, u.cookie)).status).toBe(200);
    expect((await call('GET', base, undefined, u.cookie)).status).toBe(404);
  });

  it('rejects oversized uploads', async () => {
    const { raw, u, projectId } = await setup();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await raw('PUT', `/api/projects/${projectId}/assets/big`, big, u.cookie)).status).toBe(413);
  });

  it('keeps assets private to the owner', async () => {
    const { call, raw, u, projectId, user } = await setup();
    await raw('PUT', `/api/projects/${projectId}/assets/a1`, PNG, u.cookie);
    const other = await user();
    expect((await call('GET', `/api/projects/${projectId}/assets/a1`, undefined, other.cookie)).status).toBe(404);
    expect((await raw('PUT', `/api/projects/${projectId}/assets/a2`, PNG, other.cookie)).status).toBe(404);
  });

  it('saves generated frames and drops them when the source is replaced', async () => {
    const { call, raw, u, projectId } = await setup();
    const base = `/api/projects/${projectId}/assets/a1`;
    await raw('PUT', base, PNG, u.cookie);
    expect((await call('PUT', `${base}/frames`, [FRAME, FRAME], u.cookie)).status).toBe(201);
    expect((await call('GET', `${base}/frames`, undefined, u.cookie)).body).toEqual([FRAME, FRAME]);
    expect((await call('PUT', `${base}/frames`, ['javascript:alert(1)'], u.cookie)).status).toBe(400);
    await raw('PUT', base, PNG, u.cookie);
    expect((await call('GET', `${base}/frames`, undefined, u.cookie)).status).toBe(404);
  });
});

describe('sharing', () => {
  it('serves a read-only public view and stops when revoked', async () => {
    const { call, raw, u, projectId, user } = await setup();
    const scene = { ...emptyScene(), objects: [newObject('bird', 'a1', 'Bird')] };
    await call('PUT', `/api/projects/${projectId}`, { scene }, u.cookie);
    await raw('PUT', `/api/projects/${projectId}/assets/a1`, PNG, u.cookie);
    await call('PUT', `/api/projects/${projectId}/assets/a1/frames`, [FRAME], u.cookie);

    const { token } = (await call('POST', `/api/projects/${projectId}/shares`, {}, u.cookie)).body;
    const pub = await call('GET', `/api/share/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.scene.objects).toHaveLength(1);
    expect(pub.body.assets).toEqual([{ id: 'a1', hasFrames: true, hd: false }]);
    expect(pub.text).not.toMatch(/user\d|@example|"userId"/);

    expect((await call('GET', `/api/share/${token}/assets/a1`)).bytes.length).toBe(PNG.length);
    expect((await call('GET', `/api/share/${token}/assets/a1/frames`)).body).toEqual([FRAME]);
    // visitors cannot write
    expect((await call('PUT', `/api/projects/${projectId}`, { name: 'x' })).status).toBe(401);

    const other = await user();
    expect((await call('POST', `/api/projects/${projectId}/shares`, {}, other.cookie)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${projectId}/shares/${token}`, undefined, other.cookie)).status).toBe(404);

    expect((await call('DELETE', `/api/projects/${projectId}/shares/${token}`, undefined, u.cookie)).status).toBe(200);
    expect((await call('GET', `/api/share/${token}`)).status).toBe(404);
    expect((await call('GET', '/api/share/not-a-real-token-123456')).status).toBe(404);
  });
});

describe('billing', () => {
  const SECRET = 'whsec_test_secret';
  const env = {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_CREATOR: 'price_creator',
    STRIPE_PRICE_PROFESSIONAL: 'price_pro',
    APP_URL: 'https://app.example.com',
  };
  const now = () => Math.floor(Date.now() / 1000);

  async function webhook(app: Awaited<ReturnType<typeof setup>>, event: object, opts: { secret?: string; t?: number } = {}) {
    const payload = JSON.stringify(event);
    const sig = await signForTest(payload, opts.secret ?? SECRET, opts.t ?? now());
    return app.call('POST', '/api/webhooks/stripe', undefined, undefined, {}).then(async () => {
      // send the exact payload bytes that were signed
      const res = await app.raw('POST', '/api/webhooks/stripe', new TextEncoder().encode(payload), undefined, 'application/json');
      void sig;
      return res;
    });
  }

  // The harness signs per request, so build the signed call directly.
  async function signedWebhook(app: Awaited<ReturnType<typeof setup>>, event: object, opts: { secret?: string; t?: number } = {}) {
    const payload = JSON.stringify(event);
    const sig = await signForTest(payload, opts.secret ?? SECRET, opts.t ?? now());
    const { handle } = await import('../../server/src/router');
    const res = await handle(
      new Request('http://app.test/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': sig }, body: payload }),
      app.env,
      { fetchFn: async () => new Response('{}') },
    );
    return { status: res.status, body: await res.json() };
  }
  void webhook;

  it('reports billing as unconfigured instead of faking checkout', async () => {
    const { call, u } = await setup();
    expect((await call('POST', '/api/billing/checkout', { plan: 'creator' }, u.cookie)).status).toBe(501);
    const s = await call('GET', '/api/billing', undefined, u.cookie);
    expect(s.body).toMatchObject({ configured: false, plan: 'free', status: 'none' });
  });

  it('creates a Stripe checkout session for the signed-in user', async () => {
    const seen: { url: string; body: string; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/abc' }));
    }) as unknown as typeof fetch;
    const { call, u } = await setup({ fetchFn }, env);
    const r = await call('POST', '/api/billing/checkout', { plan: 'creator' }, u.cookie);
    expect(r.body.url).toBe('https://checkout.stripe.com/c/pay/abc');
    const params = new URLSearchParams(seen[0].body);
    expect(seen[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(seen[0].auth).toBe('Bearer sk_test_x');
    expect(params.get('line_items[0][price]')).toBe('price_creator');
    expect(params.get('client_reference_id')).toBe(u.id);
    expect(params.get('mode')).toBe('subscription');
    expect((await call('POST', '/api/billing/checkout', { plan: 'enterprise' }, u.cookie)).status).toBe(400);
  });

  it('rejects unsigned, forged and stale webhooks', async () => {
    const app = await setup({}, env);
    const event = { id: 'evt_1', type: 'invoice.paid', data: { object: {} } };
    expect((await signedWebhook(app, event, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await signedWebhook(app, event, { t: now() - 3600 })).status).toBe(400);
    expect((await app.call('POST', '/api/webhooks/stripe', event)).status).toBe(400);
    expect((await signedWebhook(app, event)).status).toBe(200);
  });

  it('upgrades a plan, grants credits once per invoice, and downgrades on cancellation', async () => {
    const app = await setup({}, env);
    await signedWebhook(app, {
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: app.u.id, customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'creator' } } },
    });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.user.plan).toBe('creator');

    const invoice = { id: 'evt_inv_1', type: 'invoice.paid', data: { object: { customer: 'cus_1' } } };
    await signedWebhook(app, invoice);
    await signedWebhook(app, invoice); // Stripe retries deliveries
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(320);

    const summary = await app.call('GET', '/api/billing', undefined, app.u.cookie);
    expect(summary.body).toMatchObject({ configured: true, plan: 'creator', status: 'active' });

    await signedWebhook(app, { id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.user.plan).toBe('free');
    expect((await app.call('GET', '/api/billing', undefined, app.u.cookie)).body.status).toBe('canceled');
  });

  it('ignores checkout events for unknown users or plans', async () => {
    const app = await setup({}, env);
    await signedWebhook(app, { id: 'evt_a', type: 'checkout.session.completed', data: { object: { client_reference_id: 'nobody', customer: 'cus_9', metadata: { plan: 'creator' } } } });
    await signedWebhook(app, { id: 'evt_b', type: 'checkout.session.completed', data: { object: { client_reference_id: app.u.id, customer: 'cus_9', metadata: { plan: 'god-mode' } } } });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.user.plan).toBe('free');
  });
});

describe('Replicate provider (mocked HTTP; not verified against the live service)', () => {
  const env = { REPLICATE_API_TOKEN: 'r8_platform', REPLICATE_FAST_VERSION: 'abcdef1234567890' };

  function mockReplicate(final: { status: string; output?: unknown; error?: string } = { status: 'succeeded', output: ['https://replicate.delivery/pbxt/out.mp4'] }) {
    const calls: { url: string; method: string; auth?: string; body?: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let polls = 0;
    const fetchFn = (async (url: string, init: RequestInit = {}) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, method: init.method ?? 'GET', auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === 'https://api.replicate.com/v1/predictions') return new Response(JSON.stringify({ id: 'pred123' }));
      if (url === 'https://api.replicate.com/v1/predictions/pred123') {
        polls++;
        return new Response(JSON.stringify(polls < 2 ? { status: 'processing' } : final));
      }
      if (url === 'https://replicate.delivery/pbxt/out.mp4') return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4' } });
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  async function withAsset(fetchFn: typeof fetch) {
    const app = await setup({ providers: undefined, fetchFn }, env);
    await app.raw('PUT', `/api/projects/${app.projectId}/assets/bird-1`, PNG, app.u.cookie);
    return app;
  }
  const body = (projectId: string, key: string, extra: object = {}) => ({ projectId, mode: 'fast', prompt: 'flap its wings', idempotencyKey: key, assetId: 'bird-1', ...extra });

  it('only offers paid modes the operator has configured', async () => {
    const { call, u } = await setup({ providers: undefined }, env);
    const modes = (await call('GET', '/api/modes', undefined, u.cookie)).body.modes as { mode: string; available: boolean; provider: string | null }[];
    expect(Object.fromEntries(modes.map((m) => [m.mode, m.available]))).toEqual({ free: true, fast: true, professional: false, byok: true });
    const bare = await setup({ providers: undefined });
    const bareModes = (await bare.call('GET', '/api/modes', undefined, bare.u.cookie)).body.modes as { mode: string; available: boolean }[];
    // bring-your-own-key needs no server setup, so it is always offered
    expect(bareModes.filter((m) => m.available).map((m) => m.mode)).toEqual(['free', 'byok']);
  });

  it('starts a prediction, parks the job, resumes until it succeeds, and stores the video', async () => {
    const { fetchFn, calls } = mockReplicate();
    const app = await withAsset(fetchFn);
    const created = await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-0001'), app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();

    const parked = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(parked).toMatchObject({ status: 'queued', stage: 'Generating motion' });
    const start = calls.find((c) => c.method === 'POST')!;
    expect(start.auth).toBe('Bearer r8_platform');
    expect(start.body.version).toBe('abcdef1234567890');
    expect(start.body.input.image).toMatch(/^data:image\/png;base64,/);

    await app.resume(); // first poll: still processing
    expect((await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job.status).toBe('queued');
    await app.resume(); // second poll: succeeded, video downloaded
    const done = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(done).toMatchObject({ status: 'complete', cost: 10 });
    expect(done.result.videoUrl).toBe(`/api/jobs/${created.body.job.id}/video`);
    const video = await app.call('GET', done.result.videoUrl, undefined, app.u.cookie);
    expect(Array.from(video.bytes)).toEqual([1, 2, 3, 4]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(10);
  });

  it('checks on a waiting job when the app asks for it, without waiting for the cron', async () => {
    const { fetchFn } = mockReplicate();
    const app = await withAsset(fetchFn);
    const id = (await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-poll'), app.u.cookie)).body.job.id;
    await app.settle();
    const poll = async () => {
      app.sqlite.prepare('UPDATE jobs SET updated_at = updated_at - 10').run();
      await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie);
      await app.settle();
    };
    await poll(); // still processing
    await poll(); // succeeded
    expect((await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie)).body.job.status).toBe('complete');
  });

  it('deleting a project also deletes its images, frames and generated videos', async () => {
    const { fetchFn } = mockReplicate();
    const app = await withAsset(fetchFn);
    await app.call('PUT', `/api/projects/${app.projectId}/assets/bird-1/frames`, ['data:image/webp;base64,AAAA'], app.u.cookie);
    const id = (await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-del'), app.u.cookie)).body.job.id;
    await app.settle();
    await app.resume();
    await app.resume();
    expect((await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie)).body.job.status).toBe('complete');
    const before = [...app.files.store.keys()];
    expect(before).toHaveLength(3);
    expect(before).toEqual(expect.arrayContaining([`jobs/${id}/video.mp4`, expect.stringMatching(/\/a\/bird-1$/), expect.stringMatching(/\/a\/bird-1\.frames\.json$/)]));

    expect((await app.call('DELETE', `/api/projects/${app.projectId}`, undefined, app.u.cookie)).status).toBe(200);
    expect([...app.files.store.keys()]).toEqual([]);
    expect(app.sqlite.prepare('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
    expect(app.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  });

  it('fails cleanly when the provider fails, and does not charge again on retry', async () => {
    const { fetchFn } = mockReplicate({ status: 'failed', error: 'NSFW' });
    const app = await withAsset(fetchFn);
    const id = (await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-0002'), app.u.cookie)).body.job.id;
    await app.settle();
    await app.resume();
    await app.resume();
    const failed = (await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie)).body.job;
    expect(failed).toMatchObject({ status: 'failed', stage: 'Failed', error: 'Generation failed.' });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(10);
    expect((await app.call('POST', `/api/jobs/${id}/cancel`, {}, app.u.cookie)).body.credits).toBe(20);
  });

  it('requires one of the project images for paid modes', async () => {
    const app = await withAsset(mockReplicate().fetchFn);
    expect((await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-0003', { assetId: undefined }), app.u.cookie)).status).toBe(400);
    expect((await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-0004', { assetId: 'missing' }), app.u.cookie)).status).toBe(400);
  });

  it('bring-your-own-key jobs run on the user key, cost nothing, and only accept a Replicate key', async () => {
    const { fetchFn, calls } = mockReplicate();
    const app = await withAsset(fetchFn);
    const b = body(app.projectId, 'idem-rep-0005', { mode: 'byok', keyProvider: 'replicate' });
    expect((await app.call('POST', '/api/jobs', b, app.u.cookie)).status).toBe(400);
    await app.call('PUT', '/api/keys/replicate', { apiKey: 'r8_user_key_ABCD' }, app.u.cookie);
    expect((await app.call('POST', '/api/jobs', { ...b, idempotencyKey: 'idem-rep-0006', keyProvider: 'openai' }, app.u.cookie)).status).toBe(400);
    const created = await app.call('POST', '/api/jobs', b, app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    expect(calls.find((c) => c.method === 'POST')!.auth).toBe('Bearer r8_user_key_ABCD');
    await app.resume();
    await app.resume();
    const done = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body;
    expect(done.job.status).toBe('complete');
    expect(JSON.stringify(done)).not.toContain('r8_user_key');
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(20);
  });

  it('refuses result URLs from untrusted hosts', async () => {
    const { fetchFn } = mockReplicate({ status: 'succeeded', output: 'https://evil.example.com/x.mp4' });
    const app = await withAsset(fetchFn);
    const id = (await app.call('POST', '/api/jobs', body(app.projectId, 'idem-rep-0007'), app.u.cookie)).body.job.id;
    await app.settle();
    await app.resume();
    await app.resume();
    expect((await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie)).body.job).toMatchObject({ status: 'failed', error: 'The provider returned an unexpected result.' });
  });
});
