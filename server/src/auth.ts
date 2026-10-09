import { hashPassword, randomToken, sha256Hex, verifyPassword } from './crypto';
import { HttpError, getCookie } from './http';
import type { D1Database, UserRow } from './types';

export const COOKIE = 'mf_session';
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const now = () => Math.floor(Date.now() / 1000);

/**
 * MotionForge is a private, single-owner app: only this account can sign up or log in. The address is
 * stored as a SHA-256 hash so it is not published with the source. Set OWNER_EMAIL on the Worker to use
 * a different address (several can be separated by commas).
 */
const OWNER_EMAIL_SHA256 = '9847a37e8041c2717a8d2f346f4c15efb1b61b5e7a52f1a5877f025a4b775edd';

export async function isOwner(email: string, ownerSetting?: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (ownerSetting?.trim()) {
    const allowed = ownerSetting.split(',').map((x) => x.trim().toLowerCase());
    return allowed.includes('*') || allowed.includes(e);
  }
  return (await sha256Hex(e)) === OWNER_EMAIL_SHA256;
}

/** The owner has everything: no plan limits apply. */
const OWNER_PLAN = 'professional';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || !EMAIL.test(email.trim()) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters.');
  if (password.length > 200) throw new HttpError(400, 'That password is too long.');
  return { email: email.trim().toLowerCase(), password };
}

/** Fixed-window limiter backed by the database. Throws 429 when exceeded. */
export async function rateLimit(db: D1Database, key: string, max: number, windowSeconds: number): Promise<void> {
  const t = now();
  const cutoff = t - windowSeconds;
  await db
    .prepare(
      `INSERT INTO rate_limits(key, window_start, count) VALUES(?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`,
    )
    .bind(key, t, cutoff, cutoff, t)
    .run();
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first<{ count: number }>();
  if (row && row.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  await db
    .prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now() + SESSION_SECONDS, now())
    .run();
  return token;
}

export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export async function getUser(db: D1Database, req: Request, ownerSetting?: string): Promise<UserRow | null> {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.plan FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now())
    .first<UserRow>();
  // Sessions of any other account (from before the app was private) no longer work.
  if (!row || !(await isOwner(row.email, ownerSetting))) return null;
  return { ...row, plan: OWNER_PLAN };
}

export async function signup(db: D1Database, email: string, password: string, ownerSetting?: string): Promise<UserRow> {
  if (!(await isOwner(email, ownerSetting))) throw new HttpError(403, 'Sign-ups are closed. This is a private app.');
  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw new HttpError(409, 'An account with that email already exists.');
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO users(id, email, password_hash, plan, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(id, email, await hashPassword(password), OWNER_PLAN, now())
    .run();
  return { id, email, plan: OWNER_PLAN };
}

// A real hash to compare against when the email is unknown, so timing does not reveal which emails exist.
let dummy: Promise<string> | null = null;

export async function login(db: D1Database, email: string, password: string, ownerSetting?: string): Promise<UserRow> {
  const row = await db
    .prepare('SELECT id, email, plan, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow & { password_hash: string }>();
  dummy ??= hashPassword('not-a-real-password');
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummy));
  if (!row || !ok || !(await isOwner(email, ownerSetting))) throw new HttpError(401, 'Incorrect email or password.');
  return { id: row.id, email: row.email, plan: OWNER_PLAN };
}

export async function logout(db: D1Database, req: Request): Promise<void> {
  const token = getCookie(req, COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}
