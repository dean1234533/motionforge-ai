import { b64, decryptSecret, encryptSecret, unb64 } from './crypto';
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

function isValidSecret(secret: string | undefined): secret is string {
  try {
    return !!secret && unb64(secret).length === 32;
  } catch {
    return false;
  }
}

/**
 * Encryption secrets to try, preferred first: KEY_ENCRYPTION_SECRET when the host set a valid one,
 * then a secret the server generates and keeps in its own database. The stored one means saving keys works
 * with no setup at all; a host secret is still better, as it keeps the database alone from unlocking keys.
 */
async function secrets(db: D1Database, hostSecret: string | undefined): Promise<string[]> {
  const out = isValidSecret(hostSecret) ? [hostSecret] : [];
  let row = await db.prepare("SELECT value FROM server_secrets WHERE name = 'key_encryption'").first<{ value: string }>();
  if (!row) {
    const fresh = b64(crypto.getRandomValues(new Uint8Array(32)));
    // Two first requests may race; whichever insert lands first wins and both read it back.
    await db.prepare("INSERT OR IGNORE INTO server_secrets(name, value, created_at) VALUES('key_encryption', ?, ?)").bind(fresh, now()).run();
    row = await db.prepare("SELECT value FROM server_secrets WHERE name = 'key_encryption'").first<{ value: string }>();
  }
  if (row) out.push(row.value);
  return out;
}

export async function saveKey(db: D1Database, hostSecret: string | undefined, userId: string, provider: string, pasted: unknown): Promise<void> {
  assertProvider(provider);
  // Copied keys often carry a stray space, line break or quotes.
  const apiKey = typeof pasted === 'string' ? pasted.trim().replace(/^(['"])(.*)\1$/s, '$2').trim() : pasted;
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey)) {
    throw new HttpError(400, 'That does not look like an API key.');
  }
  const { ciphertext, iv } = await encryptSecret((await secrets(db, hostSecret))[0], apiKey, `${userId}:${provider}`);
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
export async function readKey(db: D1Database, hostSecret: string | undefined, userId: string, provider: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT ciphertext, iv FROM provider_keys WHERE user_id = ? AND provider = ?')
    .bind(userId, provider)
    .first<{ ciphertext: string; iv: string }>();
  if (!row) return null;
  for (const secret of await secrets(db, hostSecret)) {
    try {
      return await decryptSecret(secret, row.ciphertext, row.iv, `${userId}:${provider}`);
    } catch {
      // try the next secret
    }
  }
  // Saved under a KEY_ENCRYPTION_SECRET that has since changed (or the row was tampered with).
  throw new HttpError(409, `Your saved ${provider} key was saved before the server's encryption secret changed, so it can no longer be read. Remove it in Settings and add it again.`);
}

export async function testKey(db: D1Database, secret: string | undefined, userId: string, provider: string, fetchFn: typeof fetch) {
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
