import { describe, expect, it } from 'vitest';
import { d1Files } from '../server/src/d1files';
import { ensureSchema } from '../server/src/schema';
import { makeApp } from './server/harness';

async function store() {
  const app = makeApp();
  await ensureSchema(app.env.DB);
  return { files: d1Files(app.env.DB), app };
}

const read = async (files: ReturnType<typeof d1Files>, key: string) => {
  const o = await files.get(key);
  return o ? { bytes: new Uint8Array(await o.arrayBuffer()), type: o.httpMetadata?.contentType } : null;
};

describe('database file storage', () => {
  it('round-trips every byte value, small and large (multi-row)', async () => {
    const { files } = await store();
    const small = Uint8Array.from({ length: 256 }, (_, i) => i);
    await files.put('small', small, { httpMetadata: { contentType: 'image/png' } });
    expect(await read(files, 'small')).toEqual({ bytes: small, type: 'image/png' });

    const big = new Uint8Array(3_000_000).map((_, i) => (i * 31 + (i >> 8)) & 255);
    await files.put('big', big, { httpMetadata: { contentType: 'application/octet-stream' } });
    const back = await read(files, 'big');
    expect(back!.bytes.length).toBe(big.length);
    expect(Buffer.compare(Buffer.from(back!.bytes), Buffer.from(big))).toBe(0);
  });

  it('stores strings, replaces on overwrite, and deletes', async () => {
    const { files, app } = await store();
    await files.put('k', 'hello');
    expect(new TextDecoder().decode((await read(files, 'k'))!.bytes)).toBe('hello');
    await files.put('k', new Uint8Array(2_000_000).fill(7));
    await files.put('k', 'short again');
    expect(new TextDecoder().decode((await read(files, 'k'))!.bytes)).toBe('short again');
    expect((app.sqlite.prepare("SELECT COUNT(*) AS n FROM file_chunks WHERE key = 'k'").get() as { n: number }).n).toBe(1);

    await files.put('a', 'x');
    await files.put('b', 'y');
    await files.delete(['a', 'b']);
    expect(await read(files, 'a')).toBeNull();
    expect(await read(files, 'missing')).toBeNull();
  });

  it('stores an empty file', async () => {
    const { files } = await store();
    await files.put('empty', new Uint8Array(0));
    expect((await read(files, 'empty'))!.bytes.length).toBe(0);
  });
});

describe('the app with no R2 bucket bound', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);

  it('uploads, serves, saves frames, shares and deletes images using the database', async () => {
    const app = makeApp({}, { FILES: undefined });
    const u = await app.user();
    const pid = (await app.call('POST', '/api/projects', { name: 'P' }, u.cookie)).body.project.id as string;
    expect((await app.raw('PUT', `/api/projects/${pid}/assets/a1?name=bird.png`, PNG, u.cookie)).status).toBe(201);
    expect(Array.from((await app.call('GET', `/api/projects/${pid}/assets/a1`, undefined, u.cookie)).bytes)).toEqual(Array.from(PNG));

    const frame = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await app.call('PUT', `/api/projects/${pid}/assets/a1/frames`, [frame, frame], u.cookie)).status).toBe(201);
    expect((await app.call('GET', `/api/projects/${pid}/assets/a1/frames`, undefined, u.cookie)).body).toEqual([frame, frame]);

    const { token } = (await app.call('POST', `/api/projects/${pid}/shares`, {}, u.cookie)).body;
    expect((await app.call('GET', `/api/share/${token}/assets/a1`)).bytes.length).toBe(PNG.length);

    expect((await app.call('DELETE', `/api/projects/${pid}/assets/a1`, undefined, u.cookie)).status).toBe(200);
    expect((await app.call('GET', `/api/projects/${pid}/assets/a1`, undefined, u.cookie)).status).toBe(404);
    expect((app.sqlite.prepare('SELECT COUNT(*) AS n FROM file_chunks').get() as { n: number }).n).toBe(0);
  });
});
