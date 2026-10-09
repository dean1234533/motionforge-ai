import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../server/src/migrations';
import { ensureSchema } from '../server/src/schema';
import { sweepOrphanFiles } from '../server/src/d1files';
import { makeApp, sqliteD1 } from './server/harness';

const tables = (app: ReturnType<typeof makeApp>) =>
  (app.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);

describe('self-applying migrations', () => {
  it('creates every table on first use and records each migration once', async () => {
    const app = makeApp();
    await ensureSchema(app.env.DB);
    expect(tables(app)).toEqual(expect.arrayContaining(['users', 'projects', 'jobs', 'ledger', 'assets', 'shares', 'subscriptions', 'teams', 'team_members', 'team_invites', '_migrations']));
    const applied = (app.sqlite.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('is safe to run again and to run concurrently', async () => {
    const app = makeApp();
    await Promise.all([ensureSchema(app.env.DB), ensureSchema(app.env.DB), ensureSchema(app.env.DB)]);
    await ensureSchema(app.env.DB);
    expect((app.sqlite.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(MIGRATIONS.length);
  });

  it('applies only the missing migrations to a database that is part way there', async () => {
    const app = makeApp();
    app.sqlite.exec('CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const stmt of MIGRATIONS[0].statements) app.sqlite.exec(stmt);
    app.sqlite.prepare('INSERT INTO _migrations(id, applied_at) VALUES(?, 1)').run(MIGRATIONS[0].id);
    await ensureSchema(app.env.DB);
    expect(tables(app)).toEqual(expect.arrayContaining(['teams', 'assets']));
    expect((app.sqlite.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(MIGRATIONS.length);
  });

  it('works through the API on a brand-new database, and saves keys without a host secret', async () => {
    const app = makeApp({}, { KEY_ENCRYPTION_SECRET: '' });
    const u = await app.user();
    expect((await app.call('GET', '/api/me', undefined, u.cookie)).status).toBe(200);
    const r = await app.call('PUT', '/api/keys/openai', { apiKey: 'sk-abcdefgh1234' }, u.cookie);
    expect(r.status).toBe(200);
  });

  it('clears out stored files left behind by projects deleted before files were cleaned up', async () => {
    const app = makeApp({}, { FILES: undefined } as never); // files kept in the database
    const u = await app.user();
    const pid = (await app.call('POST', '/api/projects', { name: 'Old' }, u.cookie)).body.project.id as string;
    const keep = (await app.call('POST', '/api/projects', { name: 'Keep' }, u.cookie)).body.project.id as string;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
    for (const p of [pid, keep]) expect((await app.raw('PUT', `/api/projects/${p}/assets/bird-1`, png, u.cookie)).status).toBe(201);
    app.sqlite.prepare('INSERT INTO file_chunks(key, idx, type, data) VALUES(?, 0, NULL, ?)').run('jobs/00000000-0000-0000-0000-000000000000/video.mp4', 'AAAA');
    app.sqlite.prepare('DELETE FROM projects WHERE id = ?').run(pid); // the old way: files stayed behind

    expect(await sweepOrphanFiles(sqliteD1(app.sqlite))).toBe(2);
    const left = app.sqlite.prepare('SELECT key FROM file_chunks').all() as { key: string }[];
    expect(left.map((r) => r.key)).toEqual([expect.stringContaining(`/p/${keep}/a/bird-1`)]);
  });
});
