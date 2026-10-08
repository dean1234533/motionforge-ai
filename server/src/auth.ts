import { hashPassword, randomToken, sha256Hex, verifyPassword } from './crypto';
import { HttpError, getCookie } from './http';
import type { D1Database, UserRow } from './types';

export const COOKIE = 'mf_session';
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const now = () => Math.floor(Date.now() / 1000);

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

export async function getUser(db: D1Database, req: Request): Promise<UserRow | null> {
  const token = getCookie(req, COOKIE);
  if (!token) return null;
  return db
    .prepare(
      `SELECT u.id, u.email, u.plan FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now())
    .first<UserRow>();
}

export async function signup(db: D1Database, email: string, password: string): Promise<UserRow> {
  const exists = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw new HttpError(409, 'An account with that email already exists.');
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO users(id, email, password_hash, plan, created_at) VALUES(?, ?, ?, ?, ?)')
    .bind(id, email, await hashPassword(password), 'free', now())
    .run();
  return { id, email, plan: 'free' };
}

// A real hash to compare against when the email is unknown, so timing does not reveal which emails exist.
let dummy: Promise<string> | null = null;

export async function login(db: D1Database, email: string, password: string): Promise<UserRow> {
  const row = await db
    .prepare('SELECT id, email, plan, password_hash FROM users WHERE email = ?')
    .bind(email)
    .first<UserRow & { password_hash: string }>();
  dummy ??= hashPassword('not-a-real-password');
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummy));
  if (!row || !ok) throw new HttpError(401, 'Incorrect email or password.');
  return { id: row.id, email: row.email, plan: row.plan };
}

export async function logout(db: D1Database, req: Request): Promise<void> {
  const token = getCookie(req, COOKIE);
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}
