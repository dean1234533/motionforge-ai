import { describe, expect, it } from 'vitest';
import { makeApp } from './harness';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);

type Props = Record<string, unknown>;
const uri = { type: 'string', format: 'uri' };

function modelBody(props: Props, extraSchemas: Record<string, unknown> = {}) {
  return { latest_version: { id: 'ver-abc123', openapi_schema: { components: { schemas: { Input: { properties: props }, ...extraSchemas } } } } };
}

interface Call {
  url: string;
  method: string;
  auth?: string;
  body?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A pretend Replicate that serves model descriptions, accepts predictions, and finishes on the second poll. */
function mockReplicate(models: Record<string, ReturnType<typeof modelBody> | 404>, output = 'https://replicate.delivery/x/out.mp4') {
  const calls: Call[] = [];
  let polls = 0;
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', auth: (init.headers as Record<string, string> | undefined)?.authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const m = url.match(/^https:\/\/api\.replicate\.com\/v1\/models\/(.+)$/);
    if (m) {
      const body = models[m[1]];
      if (body === undefined || body === 404) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(body));
    }
    if (url === 'https://api.replicate.com/v1/predictions') return new Response(JSON.stringify({ id: 'pred9' }));
    if (url === 'https://api.replicate.com/v1/predictions/pred9') return new Response(JSON.stringify(++polls < 2 ? { status: 'processing' } : { status: 'succeeded', output }));
    if (url === output) return new Response(PNG, { headers: { 'content-type': output.endsWith('mp4') ? 'video/mp4' : 'image/png' } });
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function setup(models: Parameters<typeof mockReplicate>[0], env: Record<string, string> = { REPLICATE_API_TOKEN: 'r8_platform' }, output?: string) {
  const m = mockReplicate(models, output);
  const app = makeApp({ providers: undefined, tools: undefined, fetchFn: m.fetchFn }, env);
  const u = await app.user();
  const pid = (await app.call('POST', '/api/projects', { name: 'P' }, u.cookie)).body.project.id as string;
  await app.raw('PUT', `/api/projects/${pid}/assets/bird-1?name=bird.png`, PNG, u.cookie);
  return { ...app, ...m, u, pid };
}

const video = (pid: string, key: string, extra: object = {}) => ({ projectId: pid, mode: 'fast', prompt: 'flap its wings', idempotencyKey: key, assetId: 'bird-1', ...extra });

describe('Replicate models are described by their own schema', () => {
  it('generates a general action sequence with instructed moonwalk mechanics', async () => {
    const app = await setup({ 'bytedance/seedance-1-lite': modelBody({ image: uri, prompt: { type: 'string' } }) });
    const response = await app.call('POST', '/api/jobs', video(app.pid, 'moonwalk-action-001', { prompt: 'Make this robot moon-walk', realistic: true }), app.u.cookie);
    await app.settle();
    const start = app.calls.find((c) => c.method === 'POST')!;
    expect(start.body.input.prompt).toContain('alternating toe-supported steps');
    await app.resume();
    await app.resume();
    const job = (await app.call('GET', `/api/jobs/${response.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job.status).toBe('complete');
    expect(job.result.plan.patch).toMatchObject({ motion: { playback: 'once', cycles: 1 }, flapsPerScroll: 0, bob: 0 });
    expect(job.result.plan.patch.path).toBeUndefined();
  });

  it('rejects providers that cannot generate instructed motion', async () => {
    const app = await setup({ 'bytedance/seedance-1-lite': modelBody({ image: uri }) });
    const free = await app.call('POST', '/api/jobs', video(app.pid, 'real-free-action-001', { mode: 'free', realistic: true }), app.u.cookie);
    expect(free.status).toBe(400);
    const paid = await app.call('POST', '/api/jobs', video(app.pid, 'no-prompt-action-001', { realistic: true }), app.u.cookie);
    await app.settle();
    const job = (await app.call('GET', `/api/jobs/${paid.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ status: 'failed', error: expect.stringContaining('cannot accept action instructions') });
    expect(app.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('needs only a token: Fast uses a default model, Professional stays off until chosen', async () => {
    const app = await setup({});
    const modes = (await app.call('GET', '/api/modes', undefined, app.u.cookie)).body.modes as { mode: string; available: boolean; provider: string | null }[];
    expect(modes.find((m) => m.mode === 'fast')).toMatchObject({ available: true, provider: 'replicate:bytedance/seedance-1-lite' });
    expect(modes.find((m) => m.mode === 'professional')!.available).toBe(false);

    const withPro = await setup({}, { REPLICATE_API_TOKEN: 't', REPLICATE_PRO_MODEL: 'bytedance/seedance-1-pro', REPLICATE_FAST_MODEL: 'wan-video/wan-2.2-i2v-fast' });
    const m2 = (await withPro.call('GET', '/api/modes', undefined, withPro.u.cookie)).body.modes as { mode: string; provider: string | null }[];
    expect(m2.find((m) => m.mode === 'fast')!.provider).toBe('replicate:wan-video/wan-2.2-i2v-fast');
    expect(m2.find((m) => m.mode === 'professional')!.provider).toBe('replicate:bytedance/seedance-1-pro');
  });

  it('finds the image input, uses the latest version, picks a short clip and a fixed camera', async () => {
    const app = await setup({
      'bytedance/seedance-1-lite': modelBody(
        { start_image: uri, last_frame_image: uri, prompt: { type: 'string' }, duration: { allOf: [{ $ref: '#/components/schemas/duration' }] }, camera_fixed: { type: 'boolean' }, resolution: { type: 'string' } },
        { duration: { enum: [10, 5] } },
      ),
    });
    const id = (await app.call('POST', '/api/jobs', video(app.pid, 'discover-key-001'), app.u.cookie)).body.job.id;
    await app.settle();
    const getModel = app.calls.find((c) => c.url.endsWith('/models/bytedance/seedance-1-lite'))!;
    expect(getModel.auth).toBe('Bearer r8_platform');
    const start = app.calls.find((c) => c.method === 'POST')!;
    expect(start.body.version).toBe('ver-abc123');
    expect(Object.keys(start.body.input).sort()).toEqual(['camera_fixed', 'duration', 'prompt', 'start_image']);
    expect(start.body.input.start_image).toMatch(/^data:image\/png;base64,/);
    expect(start.body.input).toMatchObject({ duration: 5, camera_fixed: true });
    expect(start.body.input.prompt).toContain('flap its wings');
    expect(start.body.input.prompt).toContain('Preserve its identity');
    await app.resume();
    await app.resume();
    expect((await app.call('GET', `/api/jobs/${id}`, undefined, app.u.cookie)).body.job.status).toBe('complete');
  });

  it('prefers a plain "image" input over other picture inputs', async () => {
    const app = await setup({ 'bytedance/seedance-1-lite': modelBody({ last_frame_image: uri, image: uri, prompt: { type: 'string' } }) });
    await app.call('POST', '/api/jobs', video(app.pid, 'discover-key-002'), app.u.cookie);
    await app.settle();
    expect(Object.keys(app.calls.find((c) => c.method === 'POST')!.body.input).sort()).toEqual(['image', 'prompt']);
  });

  it('explains clearly when a model cannot take an image, or does not exist', async () => {
    const textOnly = await setup({ 'bytedance/seedance-1-lite': modelBody({ prompt: { type: 'string' } }) });
    const id = (await textOnly.call('POST', '/api/jobs', video(textOnly.pid, 'discover-key-003'), textOnly.u.cookie)).body.job.id;
    await textOnly.settle();
    expect((await textOnly.call('GET', `/api/jobs/${id}`, undefined, textOnly.u.cookie)).body.job).toMatchObject({ status: 'failed', error: expect.stringContaining('does not accept an image') });

    const missing = await setup({});
    const id2 = (await missing.call('POST', '/api/jobs', video(missing.pid, 'discover-key-004'), missing.u.cookie)).body.job.id;
    await missing.settle();
    expect((await missing.call('GET', `/api/jobs/${id2}`, undefined, missing.u.cookie)).body.job.error).toContain('could not find the model');
    expect((await missing.call('POST', `/api/jobs/${id2}/cancel`, {}, missing.u.cookie)).status).toBe(200);
  });

  it('bring-your-own-key works with no platform token, using the person\'s own key for every call', async () => {
    const app = await setup({ 'bytedance/seedance-1-lite': modelBody({ image: uri, prompt: { type: 'string' } }) }, {});
    await app.call('PUT', '/api/keys/replicate', { apiKey: 'r8_user_key_ZZZZ' }, app.u.cookie);
    const created = await app.call('POST', '/api/jobs', video(app.pid, 'discover-key-005', { mode: 'byok', keyProvider: 'replicate' }), app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    for (const c of app.calls.filter((x) => x.url.includes('api.replicate.com'))) expect(c.auth).toBe('Bearer r8_user_key_ZZZZ');
    expect(app.calls.some((c) => c.url.endsWith('/models/bytedance/seedance-1-lite'))).toBe(true);
  });
});

describe('upscaling with a named model', () => {
  const upscale = (pid: string, key: string, scale?: number) => ({ projectId: pid, kind: 'upscale', idempotencyKey: key, assetId: 'bird-1', scale });

  it('uses the closest scale the model offers, and no scale if it has none', async () => {
    const withScale = await setup({ 'recraft-ai/recraft-crisp-upscale': modelBody({ image: uri, scale: { enum: [2, 3] } }) }, { REPLICATE_API_TOKEN: 't' }, 'https://replicate.delivery/x/big.png');
    await withScale.call('POST', '/api/jobs', upscale(withScale.pid, 'discover-up-001', 4), withScale.u.cookie);
    await withScale.settle();
    expect(withScale.calls.find((c) => c.method === 'POST')!.body.input).toMatchObject({ scale: 3 });

    const noScale = await setup({ 'recraft-ai/recraft-crisp-upscale': modelBody({ image: uri }) }, { REPLICATE_API_TOKEN: 't' }, 'https://replicate.delivery/x/big.png');
    const id = (await noScale.call('POST', '/api/jobs', upscale(noScale.pid, 'discover-up-002'), noScale.u.cookie)).body.job.id;
    await noScale.settle();
    expect(Object.keys(noScale.calls.find((c) => c.method === 'POST')!.body.input)).toEqual(['image']);
    await noScale.resume();
    await noScale.resume();
    const job = (await noScale.call('GET', `/api/jobs/${id}`, undefined, noScale.u.cookie)).body.job;
    expect(job).toMatchObject({ status: 'complete', cost: 0 });
    const assets = (await noScale.call('GET', `/api/projects/${noScale.pid}/assets`, undefined, noScale.u.cookie)).body.assets;
    expect(assets.find((a: { id: string }) => a.id === job.result.assetId)).toMatchObject({ name: 'bird-hd.png', hd: true });
  });
});
