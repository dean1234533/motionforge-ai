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

export interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  /** base64 of 32 random bytes; set with `wrangler secret put`. */
  KEY_ENCRYPTION_SECRET: string;
  ALLOWED_ORIGIN?: string;
  /** Public base URL of the app, used for Stripe return links. */
  APP_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_CREATOR?: string;
  STRIPE_PRICE_PROFESSIONAL?: string;
  /** Platform Replicate token for Fast/Professional modes. */
  REPLICATE_API_TOKEN?: string;
  /** Replicate model version ids for each mode. */
  REPLICATE_FAST_VERSION?: string;
  REPLICATE_PRO_VERSION?: string;
  /** Invitation emails (Resend). Both are needed; without them owners share invite links by hand. */
  RESEND_API_KEY?: string;
  /** For example: "MotionForge <team@yourdomain.com>" (the domain must be verified with Resend). */
  MAIL_FROM?: string;
  /** Name of the model's image input field (varies by model). */
  REPLICATE_IMAGE_FIELD?: string;
  /** Replicate upscaling model version, and its input field names. */
  REPLICATE_UPSCALE_VERSION?: string;
  REPLICATE_UPSCALE_IMAGE_FIELD?: string;
  REPLICATE_UPSCALE_SCALE_FIELD?: string;
  /** Image generation: the platform key (optional if every user brings their own) and the model name. */
  OPENAI_API_KEY?: string;
  OPENAI_IMAGE_MODEL?: string;
  /** Set to "1" if the model supports background:"transparent". */
  OPENAI_IMAGE_TRANSPARENT?: string;
}

export interface UserRow {
  id: string;
  email: string;
  plan: string;
}
