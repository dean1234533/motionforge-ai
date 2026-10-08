/** Minimal D1 surface the server uses, so it also runs against SQLite in tests. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}

export interface Env {
  DB: D1Database;
  /** base64 of 32 random bytes; set with `wrangler secret put`. */
  KEY_ENCRYPTION_SECRET: string;
  ALLOWED_ORIGIN?: string;
}

export interface UserRow {
  id: string;
  email: string;
  plan: string;
}
