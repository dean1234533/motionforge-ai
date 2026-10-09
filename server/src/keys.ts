import { decryptSecret, encryptSecret, unb64 } from './crypto';
import { HttpError } from './http';
import type { D1Database } from './types';

const now = () => Math.floor(Date.now() / 1000);

/** Providers whose keys can be stored and live-tested. Add an adapter here to support another. */
export const KEY_PROVIDERS: Record<string, { testUrl: string; header: (key: string) => Record<string, string> }> = {
  openai: { testUrl: 'https://api.openai.com/v1/models', header: (k) => ({ authorization: `Bearer ${k}` }) },
  replicate: { testUrl: 'https://api.replicate.com/v1/account', header: (k) => ({ authorization: `Bearer ${k}` }) },
};

export function assertProvider(p: string): void {
  if (!Object.hasOwn(KEY_PROVIDERS, p)) throw new HttpError(400, `Unsupported provider. Choose one of: ${Object.keys(KEY_PROVIDERS).join(', ')}.`);
}

function requireSecret(secret: string | undefined): asserts secret is string {
  if (!secret) throw new HttpError(501, 'Saving API keys is not set up on this server yet. The host needs to set KEY_ENCRYPTION_SECRET.');
  let bytes = 0;
  try {
    bytes = unb64(secret).length;
  } catch {
    // not base64; reported below
  }
  if (bytes !== 32) {
    throw new HttpError(
      500,
      `KEY_ENCRYPTION_SECRET is the wrong length (${secret.length} characters). It must be the full output of "openssl rand -base64 32": 44 characters ending in "=".`,
    );
  }
}

export async function saveKey(db: D1Database, secret: string, userId: string, provider: string, pasted: unknown): Promise<void> {
  requireSecret(secret);
  assertProvider(provider);
  // Copied keys often carry a stray space, line break or quotes.
  const apiKey = typeof pasted === 'string' ? pasted.trim().replace(/^(['"])(.*)\1$/s, '$2').trim() : pasted;
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey)) {
    throw new HttpError(400, 'That does not look like an API key.');
  }
  const { ciphertext, iv } = await encryptSecret(secret, apiKey, `${userId}:${provider}`);
  await db
    .prepare(
      `INSERT INTO provider_keys(user_id, provider, ciphertext, iv, last4, updated_at) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last4 = excluded.last4, updated_at = excluded.updated_at`,
    )
    .bind(userId, provider, ciphertext, iv, apiKey.slice(-4), now())
    .run();
}

/** Never returns key material, only whether a key exists and its last four characters. */
export async function listKeys(db: D1Database, userId: string) {
  const { results } = await db
    .prepare('SELECT provider, last4, updated_at FROM provider_keys WHERE user_id = ? ORDER BY provider')
    .bind(userId)
    .all<{ provider: string; last4: string; updated_at: number }>();
  return results.map((r) => ({ provider: r.provider, last4: r.last4, updatedAt: r.updated_at }));
}

export async function removeKey(db: D1Database, userId: string, provider: string): Promise<void> {
  assertProvider(provider);
  const r = await db.prepare('DELETE FROM provider_keys WHERE user_id = ? AND provider = ?').bind(userId, provider).run();
  if (!r.meta.changes) throw new HttpError(404, 'No key is saved for that provider.');
}

/** Server-internal only. The result must never be returned to a client or logged. */
export async function readKey(db: D1Database, secret: string, userId: string, provider: string): Promise<string | null> {
  requireSecret(secret);
  const row = await db
    .prepare('SELECT ciphertext, iv FROM provider_keys WHERE user_id = ? AND provider = ?')
    .bind(userId, provider)
    .first<{ ciphertext: string; iv: string }>();
  if (!row) return null;
  try {
    return await decryptSecret(secret, row.ciphertext, row.iv, `${userId}:${provider}`);
  } catch {
    // Saved under a different KEY_ENCRYPTION_SECRET (or the row was tampered with).
    throw new HttpError(409, `Your saved ${provider} key was saved before the server's encryption secret changed, so it can no longer be read. Remove it in Settings and add it again.`);
  }
}

export async function testKey(db: D1Database, secret: string, userId: string, provider: string, fetchFn: typeof fetch) {
  assertProvider(provider);
  const key = await readKey(db, secret, userId, provider);
  if (!key) throw new HttpError(404, 'No key is saved for that provider.');
  const cfg = KEY_PROVIDERS[provider];
  try {
    const res = await fetchFn(cfg.testUrl, { headers: cfg.header(key), signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, message: 'The key works.' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The provider rejected this key.' };
    return { ok: false, message: `The provider returned an error (${res.status}). Try again later.` };
  } catch {
    return { ok: false, message: 'Could not reach the provider. Try again later.' };
  }
}
