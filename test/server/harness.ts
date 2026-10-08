import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resumeJobs } from '../../server/src/jobs';
import { handle, resolveProviders } from '../../server/src/router';
import type { Deps } from '../../server/src/router';
import { defaultProviders } from '../../server/src/providers';
import type { D1Database, Env, R2Bucket } from '../../server/src/types';

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

export function fakeR2(): R2Bucket & { store: Map<string, { bytes: Uint8Array; type?: string }> } {
  const store = new Map<string, { bytes: Uint8Array; type?: string }>();
  return {
    store,
    async put(key, value, opts) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
      store.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType });
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return { arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength) as ArrayBuffer, httpMetadata: { contentType: o.type } };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}

export const SECRET = Buffer.alloc(32, 7).toString('base64');

export function makeApp(deps: Partial<Deps> = {}, envExtra: Partial<Env> = {}) {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const f of ['0001_init.sql', '0002_assets_sharing_billing.sql']) sqlite.exec(readFileSync(`server/migrations/${f}`, 'utf8'));
  const files = fakeR2();
  const env: Env = { DB: sqliteD1(sqlite), FILES: files, KEY_ENCRYPTION_SECRET: SECRET, ...envExtra };
  const pending: Promise<unknown>[] = [];
  const full: Deps = { providers: defaultProviders, fetchFn: async () => new Response('{}'), ...deps };

  async function send(method: string, path: string, body: BodyInit | undefined, headers: Record<string, string>) {
    const res = await handle(new Request(`http://app.test${path}`, { method, headers, body }), env, full, { waitUntil: (p) => void pending.push(p) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    let parsed: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, text, bytes: buf, body: parsed };
  }

  async function call(method: string, path: string, body?: unknown, cookie?: string, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { 'x-requested-with': 'motionforge', ...extra };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return send(method, path, body === undefined ? undefined : JSON.stringify(body), headers);
  }

  async function raw(method: string, path: string, bytes: Uint8Array, cookie?: string, type = 'application/octet-stream') {
    const headers: Record<string, string> = { 'x-requested-with': 'motionforge', 'content-type': type };
    if (cookie) headers.cookie = cookie;
    return send(method, path, bytes as unknown as BodyInit, headers);
  }

  async function settle() {
    while (pending.length) await pending.shift();
  }

  /** Age parked jobs and run the cron resumer once. */
  async function resume() {
    sqlite.prepare('UPDATE jobs SET updated_at = updated_at - 100').run();
    await resumeJobs(env.DB, env, resolveProviders(env, full));
  }

  let n = 0;
  async function user(email = `user${++n}@example.com`) {
    const r = await call('POST', '/api/auth/signup', { email, password: 'correct horse battery' });
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    return { cookie, email, id: r.body.user.id as string };
  }

  return { call, raw, settle, resume, user, sqlite, env, files };
}
