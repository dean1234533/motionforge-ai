import type { D1Database, R2Bucket, R2ObjectBody } from './types';

/** Characters of base64 per row. D1 rows must stay well under 2 MB. */
const CHUNK = 600_000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * File storage in the database, with the same interface as an R2 bucket. This is what the app uses
 * unless an R2 bucket is bound as `FILES`, so a deploy needs no storage setup. Files are stored in
 * chunks because a single D1 row cannot hold a large image.
 */
export function d1Files(db: D1Database): R2Bucket {
  return {
    async put(key, value, options) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
      const text = toBase64(bytes);
      await db.prepare('DELETE FROM file_chunks WHERE key = ?').bind(key).run();
      const type = options?.httpMetadata?.contentType ?? null;
      for (let i = 0, idx = 0; i < text.length || idx === 0; i += CHUNK, idx++) {
        await db
          .prepare('INSERT INTO file_chunks(key, idx, type, data) VALUES(?, ?, ?, ?)')
          .bind(key, idx, idx === 0 ? type : null, text.slice(i, i + CHUNK))
          .run();
      }
    },

    async get(key): Promise<R2ObjectBody | null> {
      const { results } = await db.prepare('SELECT type, data FROM file_chunks WHERE key = ? ORDER BY idx').bind(key).all<{ type: string | null; data: string }>();
      if (!results.length) return null;
      const bytes = fromBase64(results.map((r) => r.data).join(''));
      return {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        httpMetadata: { contentType: results[0].type ?? undefined },
      };
    },

    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        await db.prepare('DELETE FROM file_chunks WHERE key = ?').bind(key).run();
      }
    },
  };
}
