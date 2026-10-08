import { PendingError, localRulesProvider } from './providers';
import type { ProviderRegistry, ServerProvider } from './providers';
import type { Env } from './types';

export interface ReplicateConfig {
  /** Replicate model version id. */
  version: string;
  /** Platform token (Fast/Professional). Bring-your-own-key jobs use the user's key instead. */
  token?: string;
  /** Name of the model's image input (varies by model). */
  imageField: string;
  fetchFn: typeof fetch;
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const API = 'https://api.replicate.com/v1';

function toDataUri(bytes: Uint8Array, type: string): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

function trustedVideoHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'replicate.delivery' || u.hostname.endsWith('.replicate.delivery') || u.hostname.endsWith('.replicate.com'));
  } catch {
    return false;
  }
}

/**
 * Image-to-video through Replicate. Generation takes longer than one request, so the first call
 * starts a prediction and throws PendingError; later calls (the cron resumer) poll it.
 */
export function replicateProvider(cfg: ReplicateConfig): ServerProvider {
  return {
    id: `replicate:${cfg.version.slice(0, 8)}`,
    keyProviders: ['replicate'],
    needsImage: true,
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
          const res = await cfg.fetchFn(`${API}/predictions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ version: cfg.version, input: { [cfg.imageField]: toDataUri(asset.bytes, asset.type), prompt: ctx.input.prompt } }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'The provider rejected the API key.' : `The provider could not start the job (${res.status}).`);
          const created = (await res.json()) as { id?: string };
          if (!created.id) throw new Error('The provider did not return a job id.');
          throw new PendingError({ predictionId: created.id });
        }

        const res = await cfg.fetchFn(`${API}/predictions/${encodeURIComponent(ctx.state.predictionId)}`, { headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`The provider could not report progress (${res.status}).`);
        const p = (await res.json()) as { status?: string; output?: unknown; error?: string };
        if (p.status === 'succeeded') {
          const out = Array.isArray(p.output) ? p.output[0] : p.output;
          if (typeof out !== 'string' || !trustedVideoHost(out)) throw new Error('The provider returned an unexpected result.');
          return { videoUrl: out };
        }
        if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Generation ${p.status}.`);
        throw new PendingError();
      }

      if (stage === 'Processing frames') {
        const url = ctx.state.videoUrl;
        if (typeof url !== 'string' || !trustedVideoHost(url)) throw new Error('No video to process.');
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

/** Which paid modes exist depends on what the operator has configured. */
export function providersFromEnv(env: Env, fetchFn: typeof fetch, base: ProviderRegistry): ProviderRegistry {
  const imageField = env.REPLICATE_IMAGE_FIELD ?? 'image';
  const reg: ProviderRegistry = { ...base };
  if (env.REPLICATE_API_TOKEN && env.REPLICATE_FAST_VERSION) {
    reg.fast = replicateProvider({ version: env.REPLICATE_FAST_VERSION, token: env.REPLICATE_API_TOKEN, imageField, fetchFn });
  }
  if (env.REPLICATE_API_TOKEN && env.REPLICATE_PRO_VERSION) {
    reg.professional = replicateProvider({ version: env.REPLICATE_PRO_VERSION, token: env.REPLICATE_API_TOKEN, imageField, fetchFn });
  }
  const byokVersion = env.REPLICATE_FAST_VERSION ?? env.REPLICATE_PRO_VERSION;
  if (byokVersion) reg.byok = replicateProvider({ version: byokVersion, imageField, fetchFn });
  return reg;
}
