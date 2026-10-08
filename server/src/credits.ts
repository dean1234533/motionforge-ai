import type { D1Database } from './types';

export const MONTHLY_FREE_CREDITS = 20;
const now = () => Math.floor(Date.now() / 1000);

export async function balance(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE user_id = ?').bind(userId).first<{ b: number }>();
  return r?.b ?? 0;
}

/** Idempotent monthly allowance: the unique ref means it can be granted only once per month. */
export async function ensureMonthlyGrant(db: D1Database, userId: string): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await db
    .prepare('INSERT OR IGNORE INTO ledger(user_id, delta, reason, ref, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(userId, MONTHLY_FREE_CREDITS, 'Monthly free allowance', `grant:${userId}:${month}`, now())
    .run();
}

/**
 * Atomically charges `cost` credits if the balance covers it. Returns false when it does not.
 * Re-calling with the same `ref` never charges twice.
 */
export async function charge(db: D1Database, userId: string, cost: number, reason: string, ref: string): Promise<boolean> {
  if (cost === 0) return true;
  await db
    .prepare(
      `INSERT OR IGNORE INTO ledger(user_id, delta, reason, ref, created_at)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT COALESCE(SUM(delta), 0) FROM ledger WHERE user_id = ?) >= ?`,
    )
    .bind(userId, -cost, reason, ref, now(), userId, cost)
    .run();
  const row = await db.prepare('SELECT id FROM ledger WHERE ref = ?').bind(ref).first();
  return row !== null;
}

/** Refund at most once per ref. */
export async function refund(db: D1Database, userId: string, amount: number, reason: string, ref: string): Promise<void> {
  if (amount === 0) return;
  await db
    .prepare('INSERT OR IGNORE INTO ledger(user_id, delta, reason, ref, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(userId, amount, reason, ref, now())
    .run();
}
