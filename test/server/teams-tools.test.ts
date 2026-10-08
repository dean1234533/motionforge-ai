import { describe, expect, it } from 'vitest';
import { emptyScene, newObject } from '../../src/scene/defaults';
import { makeApp } from './harness';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

type App = ReturnType<typeof makeApp>;
async function pro(app: App, email?: string) {
  const u = await app.user(email);
  app.sqlite.prepare('UPDATE users SET plan = ? WHERE id = ?').run('professional', u.id);
  return u;
}

async function teamWith(app: App) {
  const owner = await pro(app);
  const team = (await app.call('POST', '/api/teams', { name: 'Studio' }, owner.cookie)).body.team as { id: string };
  return { owner, teamId: team.id };
}

async function join(app: App, owner: { cookie: string }, teamId: string, role: 'editor' | 'viewer') {
  const member = await app.user();
  const { token } = (await app.call('POST', `/api/teams/${teamId}/invites`, { email: member.email, role }, owner.cookie)).body;
  expect((await app.call('POST', `/api/invites/${token}/accept`, {}, member.cookie)).status).toBe(200);
  return member;
}

describe('teams', () => {
  it('only the Professional plan can create teams', async () => {
    const app = makeApp();
    const free = await app.user();
    expect((await app.call('POST', '/api/teams', { name: 'Nope' }, free.cookie)).status).toBe(402);
    const owner = await pro(app);
    const r = await app.call('POST', '/api/teams', { name: '  Studio <b>  ' }, owner.cookie);
    expect(r.status).toBe(201);
    expect((await app.call('GET', '/api/teams', undefined, owner.cookie)).body.teams).toEqual([{ id: r.body.team.id, name: 'Studio <b>', role: 'owner', members: 1 }]);
  });

  it('invites by single-use link that only the invited email can accept', async () => {
    const app = makeApp();
    const { owner, teamId } = await teamWith(app);
    const invited = await app.user('invited@example.com');
    const other = await app.user('other@example.com');
    const { token } = (await app.call('POST', `/api/teams/${teamId}/invites`, { email: 'Invited@Example.com', role: 'viewer' }, owner.cookie)).body;

    // anyone with the link can see what it is for, without signing in
    expect((await app.call('GET', `/api/invites/${token}`)).body).toEqual({ teamName: 'Studio', role: 'viewer' });
    expect((await app.call('POST', `/api/invites/${token}/accept`, {}, other.cookie)).status).toBe(403);
    expect((await app.call('POST', `/api/invites/${token}/accept`, {}, invited.cookie)).status).toBe(200);
    expect((await app.call('POST', `/api/invites/${token}/accept`, {}, invited.cookie)).status).toBe(404);
    expect((await app.call('GET', '/api/teams', undefined, invited.cookie)).body.teams[0]).toMatchObject({ name: 'Studio', role: 'viewer' });

    // invites are only visible to the owner
    const detail = await app.call('GET', `/api/teams/${teamId}`, undefined, owner.cookie);
    expect(detail.body.team.members).toHaveLength(2);
    expect((await app.call('GET', `/api/teams/${teamId}`, undefined, invited.cookie)).body.team.invites).toEqual([]);
    expect((await app.call('POST', `/api/teams/${teamId}/invites`, { email: 'x@example.com', role: 'viewer' }, invited.cookie)).status).toBe(403);
    expect((await app.call('GET', `/api/teams/${teamId}`, undefined, other.cookie)).status).toBe(404);
  });

  it('rejects expired invites and enforces the member limit', async () => {
    const app = makeApp();
    const { owner, teamId } = await teamWith(app);
    const { token } = (await app.call('POST', `/api/teams/${teamId}/invites`, { email: 'late@example.com', role: 'editor' }, owner.cookie)).body;
    app.sqlite.prepare('UPDATE team_invites SET expires_at = 1').run();
    expect((await app.call('GET', `/api/invites/${token}`)).status).toBe(404);
    for (let i = 0; i < 9; i++) {
      expect((await app.call('POST', `/api/teams/${teamId}/invites`, { email: `p${i}@example.com`, role: 'viewer' }, owner.cookie)).status).toBe(201);
    }
    expect((await app.call('POST', `/api/teams/${teamId}/invites`, { email: 'toomany@example.com', role: 'viewer' }, owner.cookie)).status).toBe(409);
  });

  it('gives viewers read-only access and editors edit access to team projects', async () => {
    const app = makeApp();
    const { owner, teamId } = await teamWith(app);
    const viewer = await join(app, owner, teamId, 'viewer');
    const outsider = await app.user();

    const created = await app.call('POST', '/api/projects', { name: 'Shared bird', teamId }, owner.cookie);
    const pid = created.body.project.id as string;
    await app.raw('PUT', `/api/projects/${pid}/assets/a1`, PNG, owner.cookie);

    // viewer: can see and export, cannot change
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, viewer.cookie)).body.project).toMatchObject({ role: 'viewer', teamId });
    const list = (await app.call('GET', '/api/projects', undefined, viewer.cookie)).body.projects;
    expect(list).toEqual([expect.objectContaining({ id: pid, teamName: 'Studio' })]);
    expect((await app.call('GET', `/api/projects/${pid}/assets/a1`, undefined, viewer.cookie)).bytes.length).toBe(PNG.length);
    expect((await app.call('POST', `/api/projects/${pid}/exports`, { format: 'html' }, viewer.cookie)).status).toBe(201);
    expect((await app.call('PUT', `/api/projects/${pid}`, { name: 'Hacked' }, viewer.cookie)).status).toBe(403);
    expect((await app.raw('PUT', `/api/projects/${pid}/assets/a2`, PNG, viewer.cookie)).status).toBe(403);
    expect((await app.call('POST', `/api/projects/${pid}/shares`, {}, viewer.cookie)).status).toBe(403);
    expect((await app.call('POST', '/api/jobs', { projectId: pid, mode: 'free', prompt: 'fly', idempotencyKey: 'viewer-key-1' }, viewer.cookie)).status).toBe(403);
    expect((await app.call('DELETE', `/api/projects/${pid}`, undefined, viewer.cookie)).status).toBe(403);

    // strangers learn nothing
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, outsider.cookie)).status).toBe(404);
    expect((await app.call('GET', '/api/projects', undefined, outsider.cookie)).body.projects).toEqual([]);

    // promote to editor
    await app.call('PUT', `/api/teams/${teamId}/members/${viewer.id}`, { role: 'editor' }, owner.cookie);
    const scene = { ...emptyScene(), objects: [newObject('bird', 'a1', 'Bird')] };
    expect((await app.call('PUT', `/api/projects/${pid}`, { scene }, viewer.cookie)).status).toBe(200);
    expect((await app.raw('PUT', `/api/projects/${pid}/assets/a2`, PNG, viewer.cookie)).status).toBe(201);
    // files are stored under the creator, so the creator sees the editor's upload
    expect((await app.call('GET', `/api/projects/${pid}/assets/a2`, undefined, owner.cookie)).bytes.length).toBe(PNG.length);
    expect((await app.call('POST', '/api/jobs', { projectId: pid, mode: 'free', prompt: 'fly', idempotencyKey: 'editor-key-1' }, viewer.cookie)).status).toBe(202);
    // an editor still cannot delete, or move the project out of the team
    expect((await app.call('DELETE', `/api/projects/${pid}`, undefined, viewer.cookie)).status).toBe(403);
    expect((await app.call('PUT', `/api/projects/${pid}`, { teamId: null }, viewer.cookie)).status).toBe(403);
  });

  it('removing a member, leaving, or deleting the team ends access', async () => {
    const app = makeApp();
    const { owner, teamId } = await teamWith(app);
    const a = await join(app, owner, teamId, 'editor');
    const b = await join(app, owner, teamId, 'viewer');
    const pid = (await app.call('POST', '/api/projects', { name: 'P', teamId }, owner.cookie)).body.project.id as string;

    expect((await app.call('DELETE', `/api/teams/${teamId}/members/${a.id}`, undefined, b.cookie)).status).toBe(403);
    expect((await app.call('DELETE', `/api/teams/${teamId}/members/${a.id}`, undefined, owner.cookie)).status).toBe(200);
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, a.cookie)).status).toBe(404);

    expect((await app.call('DELETE', `/api/teams/${teamId}/members/${b.id}`, undefined, b.cookie)).status).toBe(200); // leave
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, b.cookie)).status).toBe(404);
    expect((await app.call('DELETE', `/api/teams/${teamId}/members/${owner.id}`, undefined, owner.cookie)).status).toBe(409);

    const c = await join(app, owner, teamId, 'viewer');
    expect((await app.call('DELETE', `/api/teams/${teamId}`, undefined, c.cookie)).status).toBe(403);
    expect((await app.call('DELETE', `/api/teams/${teamId}`, undefined, owner.cookie)).status).toBe(200);
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, c.cookie)).status).toBe(404);
    // the project survives as the creator's personal project
    expect((await app.call('GET', `/api/projects/${pid}`, undefined, owner.cookie)).body.project.teamId).toBeNull();
  });

  it('only a team editor or owner can put a project into a team', async () => {
    const app = makeApp();
    const { owner, teamId } = await teamWith(app);
    const viewer = await join(app, owner, teamId, 'viewer');
    const outsider = await app.user();
    expect((await app.call('POST', '/api/projects', { name: 'x', teamId }, viewer.cookie)).status).toBe(403);
    expect((await app.call('POST', '/api/projects', { name: 'x', teamId }, outsider.cookie)).status).toBe(404);
    const personal = (await app.call('POST', '/api/projects', { name: 'mine' }, owner.cookie)).body.project.id as string;
    expect((await app.call('PUT', `/api/projects/${personal}`, { teamId }, owner.cookie)).body.project.teamId).toBe(teamId);
  });
});

describe('invitation emails (mocked HTTP)', () => {
  const mailEnv = { RESEND_API_KEY: 're_test', MAIL_FROM: 'MotionForge <team@example.com>', APP_URL: 'https://app.example.com' };

  async function ownerWithTeam(fetchFn: typeof fetch, env: Record<string, string>) {
    const app = makeApp({ fetchFn }, env);
    const { owner, teamId } = await teamWith(app);
    return { app, owner, teamId };
  }

  it('emails the invitation with a link only the invited address can use', async () => {
    const sent: { url: string; auth: string; body: { from: string; to: string[]; subject: string; text: string } }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const { app, owner, teamId } = await ownerWithTeam(fetchFn, mailEnv);
    const r = await app.call('POST', `/api/teams/${teamId}/invites`, { email: 'New.Person@Example.com', role: 'editor' }, owner.cookie);
    expect(r.body.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.resend.com/emails');
    expect(sent[0].auth).toBe('Bearer re_test');
    expect(sent[0].body.to).toEqual(['new.person@example.com']);
    expect(sent[0].body.from).toBe('MotionForge <team@example.com>');
    expect(sent[0].body.text).toContain(`https://app.example.com/#/invite/${r.body.token}`);
    expect(sent[0].body.text).toContain('an editor');
    expect(sent[0].body.subject).toContain('Studio');
  });

  it('still creates the invitation when mail fails or is not configured', async () => {
    const broken = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    const a = await ownerWithTeam(broken, mailEnv);
    const failed = await a.app.call('POST', `/api/teams/${a.teamId}/invites`, { email: 'x@example.com', role: 'viewer' }, a.owner.cookie);
    expect(failed.status).toBe(201);
    expect(failed.body.emailed).toBe(false);
    expect(failed.body.token).toBeTruthy();

    let calls = 0;
    const counting = (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch;
    const b = await ownerWithTeam(counting, {});
    const plain = await b.app.call('POST', `/api/teams/${b.teamId}/invites`, { email: 'y@example.com', role: 'viewer' }, b.owner.cookie);
    expect(plain.body.emailed).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('image generation and upscaling (mocked HTTP; not verified against the live services)', () => {
  function mockFetch() {
    const calls: { url: string; method: string; auth?: string; body?: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let polls = 0;
    const fetchFn = (async (url: string, init: RequestInit = {}) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, method: init.method ?? 'GET', auth, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === 'https://api.openai.com/v1/images/generations') return new Response(JSON.stringify({ data: [{ b64_json: b64(PNG) }] }));
      if (url === 'https://api.replicate.com/v1/predictions') return new Response(JSON.stringify({ id: 'up1' }));
      if (url === 'https://api.replicate.com/v1/predictions/up1') {
        polls++;
        return new Response(JSON.stringify(polls < 2 ? { status: 'processing' } : { status: 'succeeded', output: 'https://replicate.delivery/x/big.png' }));
      }
      if (url === 'https://replicate.delivery/x/big.png') return new Response(PNG);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  async function setup(envExtra: Record<string, string>) {
    const m = mockFetch();
    const app = makeApp({ providers: undefined, tools: undefined, fetchFn: m.fetchFn }, envExtra);
    const u = await app.user();
    const pid = (await app.call('POST', '/api/projects', { name: 'P' }, u.cookie)).body.project.id as string;
    return { ...app, ...m, u, pid };
  }
  const gen = (pid: string, key: string, extra: object = {}) => ({ projectId: pid, kind: 'image-gen', prompt: 'a white cloud', idempotencyKey: key, ...extra });

  it('lists which tools the server offers', async () => {
    const bare = await setup({});
    const tools = (await bare.call('GET', '/api/modes', undefined, bare.u.cookie)).body.tools;
    // upscaling is always offered (with the user's own Replicate key); image generation needs a provider
    expect(tools.map((t: { kind: string; available: boolean }) => [t.kind, t.available])).toEqual([['image-gen', false], ['upscale', true]]);
    expect(tools[1]).toMatchObject({ platformKey: false });
    expect((await bare.call('POST', '/api/jobs', gen(bare.pid, 'tool-key-0001'), bare.u.cookie)).status).toBe(501);

    const full = await setup({ OPENAI_IMAGE_MODEL: 'img-model', OPENAI_API_KEY: 'sk-platform', REPLICATE_UPSCALE_VERSION: 'upver1234567', REPLICATE_API_TOKEN: 'r8_platform' });
    const t = (await full.call('GET', '/api/modes', undefined, full.u.cookie)).body.tools;
    expect(t).toEqual([
      expect.objectContaining({ kind: 'image-gen', available: true, cost: 4, ownKeyCost: 0, platformKey: true, provider: 'openai:img-model' }),
      expect.objectContaining({ kind: 'upscale', available: true, cost: 6, platformKey: true }),
    ]);
  });

  it('generates an image with the platform key and adds it to the project', async () => {
    const app = await setup({ OPENAI_IMAGE_MODEL: 'img-model', OPENAI_API_KEY: 'sk-platform' });
    const created = await app.call('POST', '/api/jobs', gen(app.pid, 'tool-key-0002'), app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ kind: 'image-gen', status: 'complete', cost: 4 });
    expect(job.result.assetId).toMatch(/^gen-/);

    const call = app.calls[0];
    expect(call.auth).toBe('Bearer sk-platform');
    expect(call.body.model).toBe('img-model');
    expect(call.body.prompt).toContain('plain solid white background');

    const asset = await app.call('GET', `/api/projects/${app.pid}/assets/${job.result.assetId}`, undefined, app.u.cookie);
    expect(Array.from(asset.bytes)).toEqual(Array.from(PNG));
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(16);
  });

  it('asks for a transparent background when the model supports it', async () => {
    const app = await setup({ OPENAI_IMAGE_MODEL: 'img-model', OPENAI_API_KEY: 'sk-platform', OPENAI_IMAGE_TRANSPARENT: '1' });
    await app.call('POST', '/api/jobs', gen(app.pid, 'tool-key-0003'), app.u.cookie);
    await app.settle();
    expect(app.calls[0].body).toMatchObject({ background: 'transparent', output_format: 'png' });
    expect(app.calls[0].body.prompt).toBe('a white cloud');
  });

  it('without a platform key only your own key works, and then it is free', async () => {
    const app = await setup({ OPENAI_IMAGE_MODEL: 'img-model' });
    expect((await app.call('POST', '/api/jobs', gen(app.pid, 'tool-key-0004'), app.u.cookie)).status).toBe(400);
    expect((await app.call('POST', '/api/jobs', gen(app.pid, 'tool-key-0005', { useOwnKey: true }), app.u.cookie)).status).toBe(400); // no key saved
    await app.call('PUT', '/api/keys/openai', { apiKey: 'sk-user-own-key-9999' }, app.u.cookie);
    const created = await app.call('POST', '/api/jobs', gen(app.pid, 'tool-key-0006', { useOwnKey: true }), app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    expect(app.calls[0].auth).toBe('Bearer sk-user-own-key-9999');
    expect((await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job).toMatchObject({ status: 'complete', cost: 0 });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(20);
  });

  it('surfaces provider errors without leaking the key', async () => {
    const fetchFn = (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    const app = makeApp({ providers: undefined, tools: undefined, fetchFn }, { OPENAI_IMAGE_MODEL: 'm', OPENAI_API_KEY: 'sk-platform' });
    const u = await app.user();
    const pid = (await app.call('POST', '/api/projects', { name: 'P' }, u.cookie)).body.project.id as string;
    const id = (await app.call('POST', '/api/jobs', gen(pid, 'tool-key-0007'), u.cookie)).body.job.id;
    await app.settle();
    const job = (await app.call('GET', `/api/jobs/${id}`, undefined, u.cookie)).body.job;
    expect(job).toMatchObject({ status: 'failed', error: 'The provider rejected the API key.' });
    expect((await app.call('POST', `/api/jobs/${id}/cancel`, {}, u.cookie)).body.credits).toBe(20);
  });

  it('upscales an existing image into a new high-resolution image', async () => {
    const app = await setup({ REPLICATE_UPSCALE_VERSION: 'upver1234567', REPLICATE_API_TOKEN: 'r8_platform' });
    await app.raw('PUT', `/api/projects/${app.pid}/assets/bird-1?name=bird.png`, PNG, app.u.cookie);
    expect((await app.call('POST', '/api/jobs', { projectId: app.pid, kind: 'upscale', idempotencyKey: 'tool-key-0008', assetId: 'missing' }, app.u.cookie)).status).toBe(400);

    const created = await app.call('POST', '/api/jobs', { projectId: app.pid, kind: 'upscale', idempotencyKey: 'tool-key-0009', assetId: 'bird-1', scale: 4 }, app.u.cookie);
    expect(created.status).toBe(202);
    await app.settle();
    expect(app.calls.find((c) => c.method === 'POST')!.body).toMatchObject({ version: 'upver1234567', input: { scale: 4 } });
    await app.resume();
    await app.resume();
    const job = (await app.call('GET', `/api/jobs/${created.body.job.id}`, undefined, app.u.cookie)).body.job;
    expect(job).toMatchObject({ kind: 'upscale', status: 'complete', cost: 6 });
    const assets = (await app.call('GET', `/api/projects/${app.pid}/assets`, undefined, app.u.cookie)).body.assets;
    expect(assets.find((a: { id: string }) => a.id === job.result.assetId)).toMatchObject({ name: 'bird-hd.png', hd: true });
    expect(assets.find((a: { id: string }) => a.id === 'bird-1')).toMatchObject({ hd: false });
    expect((await app.call('GET', '/api/me', undefined, app.u.cookie)).body.credits).toBe(14);
  });

  it('tool jobs on a team project are open to editors only', async () => {
    const app = makeApp({ providers: undefined, tools: undefined, fetchFn: mockFetch().fetchFn }, { OPENAI_IMAGE_MODEL: 'm', OPENAI_API_KEY: 'sk' });
    const { owner, teamId } = await teamWith(app);
    const viewer = await join(app, owner, teamId, 'viewer');
    const pid = (await app.call('POST', '/api/projects', { name: 'P', teamId }, owner.cookie)).body.project.id as string;
    expect((await app.call('POST', '/api/jobs', gen(pid, 'tool-key-0010'), viewer.cookie)).status).toBe(403);
    expect((await app.call('POST', '/api/jobs', gen(pid, 'tool-key-0011'), owner.cookie)).status).toBe(202);
  });
});
