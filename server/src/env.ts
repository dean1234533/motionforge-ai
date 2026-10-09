import { d1Files } from './d1files';
import type { Env, R2Bucket } from './types';

/** The bindings Cloudflare actually gives us: image storage (R2) is optional. */
export type RawEnv = Omit<Env, 'FILES'> & { FILES?: R2Bucket };

/** Names people often use instead of the one the app reads. */
const ALIASES: Record<string, string> = {
  REPLICATE_API_KEY: 'REPLICATE_API_TOKEN',
  REPLICATE_TOKEN: 'REPLICATE_API_TOKEN',
  REPLICATE_KEY: 'REPLICATE_API_TOKEN',
  REPLICATE: 'REPLICATE_API_TOKEN',
};

/** "replicate api token " -> "REPLICATE_API_TOKEN". */
function canonicalName(name: string): string {
  const n = name.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ALIASES[n] ?? n;
}

/** Pasted values often carry a stray space, newline or surrounding quotes. */
function cleanValue(v: string): string {
  return v.trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
}

/**
 * Text settings as the app expects them: names matched regardless of case, spaces or common aliases,
 * and values without stray whitespace or quotes. Bindings (database, AI, buckets) pass through untouched.
 */
function normalizeSettings(raw: RawEnv): RawEnv {
  const out: Record<string, unknown> = { ...raw };
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue;
    const clean = cleanValue(value);
    const canon = canonicalName(name);
    if (canon === name) out[name] = clean;
    else if (clean && !(typeof out[canon] === 'string' && out[canon])) out[canon] = clean;
  }
  return out as RawEnv;
}

/** Names (never values) of the text settings the running Worker can see, to help find misplaced ones. */
export function settingNames(raw: RawEnv): string[] {
  return Object.entries(raw)
    .filter(([, v]) => typeof v === 'string')
    .map(([k]) => k)
    .sort();
}

/**
 * Fills in what the host left out: files go in the database unless an R2 bucket is bound, and links
 * default to the address the app is being served from.
 */
export function withDefaults(rawIn: RawEnv, origin?: string): Env {
  const raw = normalizeSettings(rawIn);
  return { ...raw, APP_URL: raw.APP_URL ?? origin, FILES: raw.FILES ?? d1Files(raw.DB) };
}
