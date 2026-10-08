import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { handle } from '../../server/src/router';
import type { Deps } from '../../server/src/router';
import { defaultProviders } from '../../server/src/providers';
import type { D1Database, Env } from '../../server/src/types';

export function sqliteD1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...v: unknown[]) {
          params = v.map((x) => (x === undefined ? null : x));
          return api;
        },
        async first<T>() {
          return ((stmt.get(...params) as T | undefined) ?? null) as T | null;
        },
        async all<T>() {
          return { results: stmt.all(...params) as T[] };
        },
        async run() {
          return { meta: { changes: stmt.run(...params).changes } };
        },
      };
      return api;
    },
  };
}

export const SECRET = Buffer.alloc(32, 7).toString('base64');

export function makeApp(deps: Partial<Deps> = {}) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync('server/migrations/0001_init.sql', 'utf8'));
  const env: Env = { DB: sqliteD1(sqlite), KEY_ENCRYPTION_SECRET: SECRET };
  const pending: Promise<unknown>[] = [];
  const full: Deps = { providers: defaultProviders, fetchFn: async () => new Response('{}'), ...deps };

  async function call(method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-requested-with': 'motionforge', ...extra };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await handle(
      new Request(`http://app.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      full,
      { waitUntil: (p) => void pending.push(p) },
    );
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
  }

  async function settle() {
    while (pending.length) await pending.shift();
  }

  let n = 0;
  async function user(email = `user${++n}@example.com`) {
    const r = await call('POST', '/api/auth/signup', { email, password: 'correct horse battery' });
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    return { cookie, email, id: r.body.user.id as string };
  }

  return { call, settle, user, sqlite, env };
}
