import { openaiImageProvider } from './openaiImage';
import { PendingError, localRulesProvider } from './providers';
import type { ProviderRegistry, ServerProvider, ToolRegistry } from './providers';
import type { Env } from './types';
import { workersAiImageProvider, workersAiPlannerProvider } from './workersAi';

const API = 'https://api.replicate.com/v1';
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Used when the operator only supplies a token. These are Replicate's own ("official") models. */
export const DEFAULT_MODELS = {
  fast: 'bytedance/seedance-1-lite',
  upscale: 'recraft-ai/recraft-crisp-upscale',
};

/** Either a model name (`owner/name`, the app reads the model to learn its inputs) or an explicit version id. */
export interface ModelTarget {
  model?: string;
  version?: string;
  /** Only used with an explicit version. */
  imageField?: string;
  scaleField?: string;
}

export interface ReplicateConfig {
  target: ModelTarget;
  /** Platform token (Fast/Professional). Bring-your-own-key jobs use the user's key instead. */
  token?: string;
  fetchFn: typeof fetch;
}

function toDataUri(bytes: Uint8Array, type: string): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

function trustedResultHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'replicate.delivery' || u.hostname.endsWith('.replicate.delivery') || u.hostname.endsWith('.replicate.com'));
  } catch {
    return false;
  }
}

// ---- reading a model's own description ------------------------------------------------------

interface Prop {
  type?: string;
  format?: string;
  enum?: unknown[];
  minimum?: number;
  allOf?: { $ref?: string }[];
  $ref?: string;
}
type Schemas = Record<string, Prop & { properties?: Record<string, Prop> }>;

function enumOf(p: Prop, schemas: Schemas): unknown[] | undefined {
  if (p.enum) return p.enum;
  const ref = p.$ref ?? p.allOf?.[0]?.$ref;
  const name = ref?.split('/').pop();
  return name ? schemas[name]?.enum : undefined;
}

export interface ResolvedModel {
  version: string;
  imageField: string;
  promptField: string | null;
  /** Shortest clip the model offers: short clips are cheaper and loop well on scroll. */
  duration?: number;
  cameraFixed: boolean;
  scaleField: string | null;
  scaleChoices?: number[];
}

const IMAGE_FIELDS = ['image', 'input_image', 'start_image', 'first_frame_image', 'init_image', 'image_input', 'input_image_url'];
const SCALE_FIELDS = ['scale', 'upscale_factor', 'scale_factor', 'upscale'];

/**
 * Looks the model up on Replicate and works out which of its inputs takes the picture, so the operator
 * only has to name the model.
 */
export async function resolveModel(cfg: ReplicateConfig, token: string): Promise<ResolvedModel> {
  const t = cfg.target;
  if (t.version) {
    return { version: t.version, imageField: t.imageField ?? 'image', promptField: 'prompt', cameraFixed: false, scaleField: t.scaleField ?? 'scale' };
  }
  const res = await cfg.fetchFn(`${API}/models/${t.model}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
  if (res.status === 404) throw new Error(`Replicate could not find the model "${t.model}", or this key cannot use it.`);
  if (!res.ok) throw new Error(`Replicate could not describe the model (${res.status}).`);
  const model = (await res.json()) as { latest_version?: { id?: string; openapi_schema?: { components?: { schemas?: Schemas } } } };
  const version = model.latest_version?.id;
  if (!version) throw new Error(`The model "${t.model}" has no published version to run.`);
  const schemas = model.latest_version?.openapi_schema?.components?.schemas ?? {};
  const props = schemas.Input?.properties ?? {};

  const isUri = (p: Prop) => p.type === 'string' && p.format === 'uri';
  const imageField = IMAGE_FIELDS.find((n) => props[n] && isUri(props[n])) ?? Object.keys(props).find((n) => /image/i.test(n) && isUri(props[n]));
  if (!imageField) throw new Error(`The model "${t.model}" does not accept an image, so it cannot animate one. Choose an image-to-video model.`);

  let duration: number | undefined;
  if (props.duration) {
    const choices = (enumOf(props.duration, schemas) ?? []).map(Number).filter(Number.isFinite);
    duration = choices.length ? Math.min(...choices) : typeof props.duration.minimum === 'number' ? props.duration.minimum : undefined;
  }

  const scaleField = SCALE_FIELDS.find((n) => props[n]) ?? null;
  const scaleChoices = scaleField ? (enumOf(props[scaleField], schemas) ?? []).map(Number).filter(Number.isFinite) : undefined;

  return {
    version,
    imageField,
    promptField: props.prompt ? 'prompt' : null,
    duration,
    cameraFixed: props.camera_fixed?.type === 'boolean',
    scaleField,
    scaleChoices: scaleChoices?.length ? scaleChoices : undefined,
  };
}

const label = (t: ModelTarget) => t.model ?? `version ${t.version!.slice(0, 8)}`;

async function startPrediction(cfg: ReplicateConfig, headers: Record<string, string>, version: string, input: Record<string, unknown>): Promise<string> {
  const res = await cfg.fetchFn(`${API}/predictions`, { method: 'POST', headers, body: JSON.stringify({ version, input }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'The provider rejected the API key.' : `The provider could not start the job (${res.status}).`);
  const created = (await res.json()) as { id?: string };
  if (!created.id) throw new Error('The provider did not return a job id.');
  return created.id;
}

async function pollPrediction(cfg: ReplicateConfig, headers: Record<string, string>, id: string): Promise<{ status?: string; output?: unknown }> {
  const res = await cfg.fetchFn(`${API}/predictions/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The provider could not report progress (${res.status}).`);
  return (await res.json()) as { status?: string; output?: unknown };
}

/**
 * Image-to-video through Replicate. Generation takes longer than one request, so the first call
 * starts a prediction and throws PendingError; later calls (the cron resumer) poll it.
 */
export function replicateProvider(cfg: ReplicateConfig): ServerProvider {
  return {
    id: `replicate:${label(cfg.target)}`,
    keyProviders: ['replicate'],
    needsImage: true,
    platformKey: Boolean(cfg.token),
    async step(stage, ctx) {
      if (stage === 'Analysing prompt') return localRulesProvider.step(stage, ctx);

      if (stage === 'Generating motion') {
        const token = ctx.apiKey ?? cfg.token;
        if (!token) throw new Error('No API key is available for this provider.');
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

        if (typeof ctx.state.predictionId !== 'string') {
          if (!ctx.input.assetId) throw new Error('Choose an image to animate.');
          const asset = await ctx.assets.read(ctx.input.assetId);
          if (!asset) throw new Error('The source image could not be found.');
          const model = await resolveModel(cfg, token);
          const input: Record<string, unknown> = { [model.imageField]: toDataUri(asset.bytes, asset.type) };
          if (model.promptField) input[model.promptField] = ctx.input.prompt;
          if (model.duration !== undefined) input.duration = model.duration;
          if (model.cameraFixed) input.camera_fixed = true;
          throw new PendingError({ predictionId: await startPrediction(cfg, headers, model.version, input) });
        }

        const p = await pollPrediction(cfg, headers, ctx.state.predictionId);
        if (p.status === 'succeeded') {
          const out = Array.isArray(p.output) ? p.output[0] : p.output;
          if (typeof out !== 'string' || !trustedResultHost(out)) throw new Error('The provider returned an unexpected result.');
          return { videoUrl: out };
        }
        if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Generation ${p.status}.`);
        throw new PendingError();
      }

      if (stage === 'Processing frames') {
        const url = ctx.state.videoUrl;
        if (typeof url !== 'string' || !trustedResultHost(url)) throw new Error('No video to process.');
        const res = await cfg.fetchFn(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error('The generated video could not be downloaded.');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_VIDEO_BYTES) throw new Error('The generated video was an unexpected size.');
        await ctx.assets.putJobFile('video.mp4', bytes, res.headers.get('content-type') ?? 'video/mp4');
        return { video: true };
      }
    },
  };
}

/** Enlarges one of the project's images. The result is saved as a new, high-resolution image. */
export function replicateUpscaleProvider(cfg: ReplicateConfig): ServerProvider {
  return {
    id: `replicate:${label(cfg.target)}`,
    keyProviders: ['replicate'],
    needsImage: true,
    platformKey: Boolean(cfg.token),
    async step(stage, ctx) {
      if (stage !== 'Upscaling') return;
      const token = ctx.apiKey ?? cfg.token;
      if (!token) throw new Error('No API key is available for this provider.');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

      if (typeof ctx.state.predictionId !== 'string') {
        if (!ctx.input.assetId) throw new Error('Choose an image to upscale.');
        const asset = await ctx.assets.read(ctx.input.assetId);
        if (!asset) throw new Error('The source image could not be found.');
        const model = await resolveModel(cfg, token);
        const input: Record<string, unknown> = { [model.imageField]: toDataUri(asset.bytes, asset.type) };
        if (model.scaleField) {
          const want = ctx.input.scale ?? 2;
          // Some models only offer fixed scales; use the closest one they have.
          input[model.scaleField] = model.scaleChoices ? model.scaleChoices.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a)) : want;
        }
        throw new PendingError({ predictionId: await startPrediction(cfg, headers, model.version, input) });
      }

      const p = await pollPrediction(cfg, headers, ctx.state.predictionId);
      if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Upscaling ${p.status}.`);
      if (p.status !== 'succeeded') throw new PendingError();
      const out = Array.isArray(p.output) ? p.output[0] : p.output;
      if (typeof out !== 'string' || !trustedResultHost(out)) throw new Error('The provider returned an unexpected result.');
      const img = await cfg.fetchFn(out, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) throw new Error('The enlarged image could not be downloaded.');
      const bytes = new Uint8Array(await img.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('The enlarged image is larger than the 5 MB limit. Try 2x instead of 4x.');
      const id = `up-${crypto.randomUUID().slice(0, 8)}`;
      const base = (ctx.input.sourceName ?? 'image').replace(/\.[^.]+$/, '');
      await ctx.assets.saveAsset(id, `${base}-hd.png`, bytes, true);
      return { assetId: id };
    },
  };
}

function target(version: string | undefined, model: string | undefined, fallbackModel: string | undefined, imageField?: string, scaleField?: string): ModelTarget | null {
  if (version) return { version, imageField, scaleField };
  if (model) return { model };
  return fallbackModel ? { model: fallbackModel } : null;
}

export function toolsFromEnv(env: Env, fetchFn: typeof fetch): ToolRegistry {
  const tools: ToolRegistry = {};
  if (env.OPENAI_IMAGE_MODEL) {
    // An operator who configures OpenAI image generation gets that; otherwise Cloudflare's built-in AI is used.
    tools['image-gen'] = openaiImageProvider({ model: env.OPENAI_IMAGE_MODEL, token: env.OPENAI_API_KEY, transparent: env.OPENAI_IMAGE_TRANSPARENT === '1', fetchFn });
  } else if (env.AI) {
    tools['image-gen'] = workersAiImageProvider(env.AI);
  }
  // Upscaling is always offered: with a platform token it costs credits, otherwise people use their own Replicate key.
  const up = target(env.REPLICATE_UPSCALE_VERSION, env.REPLICATE_UPSCALE_MODEL, DEFAULT_MODELS.upscale, env.REPLICATE_UPSCALE_IMAGE_FIELD, env.REPLICATE_UPSCALE_SCALE_FIELD);
  if (up) tools.upscale = replicateUpscaleProvider({ target: up, token: env.REPLICATE_API_TOKEN, fetchFn });
  return tools;
}

/** Which video modes exist depends on what the operator has configured. */
export function providersFromEnv(env: Env, fetchFn: typeof fetch, base: ProviderRegistry): ProviderRegistry {
  const reg: ProviderRegistry = { ...base };
  // With the built-in AI, understanding the prompt in "free" mode uses a language model (with a rules fallback).
  if (env.AI) reg.free = workersAiPlannerProvider(env.AI);
  const token = env.REPLICATE_API_TOKEN;
  const imageField = env.REPLICATE_IMAGE_FIELD;
  // Fast works with just a token (it uses a default model); Professional needs a model chosen on purpose.
  const fast = target(env.REPLICATE_FAST_VERSION, env.REPLICATE_FAST_MODEL, token ? DEFAULT_MODELS.fast : undefined, imageField);
  const pro = target(env.REPLICATE_PRO_VERSION, env.REPLICATE_PRO_MODEL, undefined, imageField);
  if (token && fast) reg.fast = replicateProvider({ target: fast, token, fetchFn });
  if (token && pro) reg.professional = replicateProvider({ target: pro, token, fetchFn });
  // Bring-your-own-key needs no platform token: people use their own Replicate key.
  reg.byok = replicateProvider({ target: fast ?? pro ?? { model: DEFAULT_MODELS.fast }, fetchFn });
  return reg;
}
