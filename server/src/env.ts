import { d1Files } from './d1files';
import type { Env, R2Bucket } from './types';

/** The bindings Cloudflare actually gives us: image storage (R2) is optional. */
export type RawEnv = Omit<Env, 'FILES'> & { FILES?: R2Bucket };

/**
 * Fills in what the host left out: files go in the database unless an R2 bucket is bound, and links
 * default to the address the app is being served from.
 */
export function withDefaults(raw: RawEnv, origin?: string): Env {
  return { ...raw, APP_URL: raw.APP_URL ?? origin, FILES: raw.FILES ?? d1Files(raw.DB) };
}
