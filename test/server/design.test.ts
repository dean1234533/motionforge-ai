import { describe, expect, it } from 'vitest';
import type { Env } from '../../server/src/types';
import { makeApp } from './harness';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

interface Call {
  url: string;
  auth: string | null;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** OpenAI images and a Replicate model whose schema offers a fixed set of aspect ratios. */
function mockFetch() {
  const calls: Call[] = [];
  let polls = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body });
    if (url === 'https://api.openai.com/v1/images/generations') return new Response(JSON.stringify({ data: [{ b64_json: b64(PNG) }] }));
    if (url === 'https://api.replicate.com/v1/models/ideogram-ai/ideogram-v3-turbo') {
      return new Response(JSON.stringify({
        latest_version: {
          id: 'ideover1',
          openapi_schema: { components: { schemas: {
            Input: { properties: { prompt: { type: 'string' }, aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }] } } },
            aspect_ratio: { enum: ['1:1', '16:9', '9:16', '3:4', '4:3', '2:3', '3:2'] },
          } } },
        },
      }));
    }
    if (url === 'https://api.replicate.com/v1/predictions') return new Response(JSON.stringify({ id: 'd1' }));
    if (url === 'https://api.replicate.com/v1/predictions/d1') {
      polls++;
      return new Response(JSON.stringify(polls < 2 ? { status: 'processing' } : { status: 'succeeded', output: ['https://replicate.delivery/x/logo.png'] }));
    }
    if (url === 'https://replicate.delivery/x/logo.png') return new Response(PNG);
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function setup(envExtra: Partial<Env>) {
  const m = mockFetch();
  const app = makeApp({ providers: undefined, tools: undefined, fetchFn: m.fetchFn }, envExtra);
  const u = await app.user();
  const pid = (await app.call('POST', '/api/projects', { name: 'Brand Studio' }, u.cookie)).body.project.id as string;
  return { ...app, ...m, u, pid };
}

const design = (pid: string, key: string, extra: object = {}) => ({
  projectId: pid,
  kind: 'design',
  prompt: 'Professional logo design for the brand "Aqua Vibe".',
  title: 'Aqua Vibe',
  idempotencyKey: key,
  ...extra,
});

describe('Brand Studio designs (mocked HTTP; not verified against the live services)', () => {
  it('uses OpenAI with the requested canvas and keeps the prompt as written', async () => {
    const app = await setup({ OPENAI_IMAGE_MODEL: 'img-model', OPENAI_API_KEY: 'sk-platform', OPENAI_IMAGE_TRANSPARENT: '1' });
    const created = await app.call('POST', '/api/jobs', design(app.pid, 'design-key-0001', { aspect: 'portrait', transparent: true }), app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ kind: 'design', status: 'complete', cost: 6 });
    expect(job.result.assetId).toMatch(/^design-[0-9a-f]{8}$/);

    expect(app.calls[0].body).toMatchObject({ model: 'img-model', size: '1024x1536', background: 'transparent', output_format: 'png' });
    expect(app.calls[0].body.prompt).toBe('Professional logo design for the brand "Aqua Vibe".');
    const assets = (await app.call('GET', `/api/projects/${app.pid}/assets`, undefined, app.u.cookie)).body.assets;
    expect(assets[0].name).toMatch(/^aqua-vibe-[0-9a-f]{8}\.png$/);
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(14);
  });

  it('accepts longer briefs than other jobs, and falls back to a square canvas', async () => {
    const app = await setup({ OPENAI_IMAGE_MODEL: 'img-model', OPENAI_API_KEY: 'sk-platform' });
    const long = `Flyer. ${'Details. '.repeat(120)}`;
    await app.call('POST', '/api/jobs', design(app.pid, 'design-key-0002', { prompt: long, aspect: 'banana', transparent: true }), app.u.cookie);
    await app.settle();
    expect(app.calls[0].body.prompt.length).toBeGreaterThan(500);
    expect(app.calls[0].body.size).toBe('1024x1024');
    // The model was not marked as supporting transparency.
    expect(app.calls[0].body.background).toBeUndefined();
  });

  it('defaults to Ideogram on Replicate, picking a portrait ratio the model offers', async () => {
    const app = await setup({ REPLICATE_API_TOKEN: 'r8_platform' });
    const tools = (await app.call('GET', '/api/modes', undefined, app.u.cookie)).body.tools;
    expect(tools.find((t: { kind: string }) => t.kind === 'design')).toMatchObject({ provider: 'replicate:ideogram-ai/ideogram-v3-turbo', platformKey: true });

    const created = await app.call('POST', '/api/jobs', design(app.pid, 'design-key-0003', { aspect: 'portrait' }), app.u.cookie);
    await app.settle();
    const start = app.calls.find((c) => c.url.endsWith('/predictions'))!;
    expect(start.body).toEqual({ version: 'ideover1', input: { prompt: 'Professional logo design for the brand "Aqua Vibe".', aspect_ratio: '3:4' } });
    expect(start.auth).toBe('Bearer r8_platform');

    for (let i = 0; i < 3; i++) await app.resume();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ status: 'complete' });
    const a = await app.call('GET', `/api/projects/${app.pid}/assets/${job.result.assetId}`, undefined, app.u.cookie);
    expect(Array.from(a.bytes)).toEqual(Array.from(PNG));
  });

  it('uses Cloudflare AI when that is all the server has', async () => {
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    const AI = { run: async (model: string, input: Record<string, unknown>) => (calls.push({ model, input }), { image: b64(JPEG) }) };
    const app = await setup({ AI });
    const created = await app.call('POST', '/api/jobs', design(app.pid, 'design-key-0004'), app.u.cookie);
    await app.settle();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ kind: 'design', status: 'complete' });
    expect(calls[0]).toMatchObject({ model: '@cf/black-forest-labs/flux-1-schnell', input: { steps: 8 } });
    // Plain image generation appends "isolated subject" wording; designs do not.
    expect(calls[0].input.prompt).toBe('Professional logo design for the brand "Aqua Vibe".');
  });

  it('works with only each person\'s own Replicate key', async () => {
    const app = await setup({});
    const tool = (await app.call('GET', '/api/modes', undefined, app.u.cookie)).body.tools.find((t: { kind: string }) => t.kind === 'design');
    expect(tool).toMatchObject({ available: true, platformKey: false, keyProvider: 'replicate' });
    const r = await app.call('POST', '/api/jobs', design(app.pid, 'design-key-0005'), app.u.cookie);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/your own key/);
  });

  it('honours an operator-chosen Replicate design model over OpenAI', async () => {
    const app = await setup({ REPLICATE_DESIGN_MODEL: 'recraft-ai/recraft-v3', OPENAI_IMAGE_MODEL: 'img-model', REPLICATE_API_TOKEN: 'r8' });
    const tool = (await app.call('GET', '/api/modes', undefined, app.u.cookie)).body.tools.find((t: { kind: string }) => t.kind === 'design');
    expect(tool.provider).toBe('replicate:recraft-ai/recraft-v3');
  });
});

describe('vector SVG logos (mocked HTTP; not verified against the live services)', () => {
  const SVG = '<?xml version="1.0"?>\n<!-- made by a vectoriser -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>';

  function vectorFetch(output: string) {
    const calls: Call[] = [];
    let polls = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      if (url === 'https://api.replicate.com/v1/models/recraft-ai/recraft-vectorize') {
        return new Response(JSON.stringify({ latest_version: { id: 'vecver1', openapi_schema: { components: { schemas: { Input: { properties: { image: { type: 'string', format: 'uri' } } } } } } } }));
      }
      if (url === 'https://api.replicate.com/v1/predictions') return new Response(JSON.stringify({ id: 'v1' }));
      if (url === 'https://api.replicate.com/v1/predictions/v1') {
        polls++;
        return new Response(JSON.stringify(polls < 2 ? { status: 'processing' } : { status: 'succeeded', output: 'https://replicate.delivery/x/logo.svg' }));
      }
      if (url === 'https://replicate.delivery/x/logo.svg') return new Response(output);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  async function withDesign(output: string) {
    const m = vectorFetch(output);
    const app = makeApp({ providers: undefined, tools: undefined, fetchFn: m.fetchFn }, { REPLICATE_API_TOKEN: 'r8_platform' });
    const u = await app.user();
    const pid = (await app.call('POST', '/api/projects', { name: 'Brand Studio' }, u.cookie)).body.project.id as string;
    await app.raw('PUT', `/api/projects/${pid}/assets/design-0000abcd?name=aqua-vibe-0000abcd.png`, PNG, u.cookie);
    const vec = (key: string) => app.call('POST', '/api/jobs', { projectId: pid, kind: 'vectorize', assetId: 'design-0000abcd', idempotencyKey: key }, u.cookie);
    return { ...app, ...m, u, pid, vec };
  }

  it('turns a design into an SVG that downloads instead of opening in the page', async () => {
    const app = await withDesign(SVG);
    const created = await app.vec('vector-key-0001');
    expect(created.status).toBe(202);
    await app.settle();
    for (let i = 0; i < 3; i++) await app.resume();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ kind: 'vectorize', status: 'complete', cost: 4 });
    expect(job.result.svgUrl).toBe(`/api/jobs/${job.id}/svg`);

    const start = app.calls.find((c) => c.url.endsWith('/predictions'))!;
    expect(start.body.version).toBe('vecver1');
    expect(start.body.input.image).toMatch(/^data:image\/png;base64,/);

    const file = await app.call('GET', job.result.svgUrl, undefined, app.u.cookie);
    expect(file.status).toBe(200);
    expect(file.text).toBe(SVG);
    expect(file.headers.get('content-type')).toBe('image/svg+xml');
    expect(file.headers.get('content-disposition')).toBe('attachment; filename="aqua-vibe-0000abcd.svg"');
    expect(file.headers.get('content-security-policy')).toBe("default-src 'none'");

    // Nobody else can fetch it.
    const other = await app.user();
    expect((await app.call('GET', job.result.svgUrl, undefined, other.cookie)).status).toBe(404);
  });

  it('rejects a result that is not an SVG', async () => {
    const app = await withDesign('<html><script>alert(1)</script></html>');
    const created = await app.vec('vector-key-0002');
    await app.settle();
    for (let i = 0; i < 3; i++) await app.resume();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ status: 'failed', error: 'The provider did not return an SVG file.' });
    expect((await app.call('GET', `/api/jobs/${job.id}/svg`, undefined, app.u.cookie)).status).toBe(404);
  });

  it('needs one of the project\'s images and no prompt', async () => {
    const app = await withDesign(SVG);
    const r = await app.call('POST', '/api/jobs', { projectId: app.pid, kind: 'vectorize', assetId: 'design-missing', idempotencyKey: 'vector-key-0003' }, app.u.cookie);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/project's images/);
  });
});
