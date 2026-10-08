import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../server/src/migrations';
import { ensureSchema } from '../server/src/schema';
import { makeApp } from './server/harness';

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

  it('works through the API on a brand-new database, and saving keys fails clearly without a secret', async () => {
    const app = makeApp({}, { KEY_ENCRYPTION_SECRET: '' });
    const u = await app.user();
    expect((await app.call('GET', '/api/me', undefined, u.cookie)).status).toBe(200);
    const r = await app.call('PUT', '/api/keys/openai', { apiKey: 'sk-abcdefgh1234' }, u.cookie);
    expect(r.status).toBe(501);
    expect(r.body.error).toContain('KEY_ENCRYPTION_SECRET');
  });
});
