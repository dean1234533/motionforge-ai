import { MIGRATIONS } from './migrations';
import type { D1Database } from './types';

const ready = new WeakMap<D1Database, Promise<void>>();

async function apply(db: D1Database): Promise<void> {
  await db.prepare('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const { results } = await db.prepare('SELECT id FROM _migrations').all<{ id: string }>();
  const done = new Set(results.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    try {
      for (const sql of m.statements) await db.prepare(sql).run();
      await db.prepare('INSERT INTO _migrations(id, applied_at) VALUES(?, ?)').bind(m.id, Math.floor(Date.now() / 1000)).run();
    } catch (e) {
      // Another instance may have applied it a moment ago (first request after a deploy). If so, carry on.
      const now = await db.prepare('SELECT id FROM _migrations WHERE id = ?').bind(m.id).first();
      if (!now) throw e;
    }
  }
}

/**
 * Makes sure the database has every table the app needs. It runs once per Worker instance and costs
 * nothing afterwards, so deploying needs no separate "apply migrations" step.
 */
export function ensureSchema(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = apply(db).catch((e) => {
      ready.delete(db); // try again on the next request
      throw e;
    });
    ready.set(db, p);
  }
  return p;
}
