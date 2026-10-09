import type { ServerProvider } from './providers';

export interface OpenAIImageConfig {
  model: string;
  /** Platform key. Omit when only "bring your own key" is offered. */
  token?: string;
  transparent: boolean;
  fetchFn: typeof fetch;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text-to-image through the OpenAI images API. The result is saved as a new image in the project. */
export function openaiImageProvider(cfg: OpenAIImageConfig): ServerProvider {
  return {
    id: `openai:${cfg.model}`,
    keyProviders: ['openai'],
    platformKey: Boolean(cfg.token),
    async step(stage, ctx) {
      if (stage !== 'Generating image') return;
      const key = ctx.apiKey ?? cfg.token;
      if (!key) throw new Error('No API key is available for this provider.');
      const prompt = cfg.transparent ? ctx.input.prompt : `${ctx.input.prompt}. A single isolated subject on a plain solid white background.`;
      const res = await cfg.fetchFn('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt, size: '1024x1024', n: 1, ...(cfg.transparent ? { background: 'transparent', output_format: 'png' } : {}) }),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
      if (res.status === 429) throw new Error('The provider is rate limiting requests. Try again shortly.');
      if (!res.ok) throw new Error(`The provider could not create the image (${res.status}).`);
      const body = (await res.json()) as { data?: { b64_json?: string }[] };
      const b64 = body.data?.[0]?.b64_json;
      if (!b64) throw new Error('The provider returned an unexpected result.');
      const id = `gen-${crypto.randomUUID().slice(0, 8)}`;
      await ctx.assets.saveAsset(id, `${id}.png`, fromBase64(b64), false);
      return { assetId: id };
    },
  };
}

const OPENAI_SIZES = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' } as const;

/**
 * Brand Studio designs (logos, flyers, product ads) through the OpenAI images API. Unlike plain image
 * generation the prompt is used as written, because it already describes the whole composition.
 */
export function openaiDesignProvider(cfg: OpenAIImageConfig): ServerProvider {
  return {
    id: `openai:${cfg.model}`,
    keyProviders: ['openai'],
    platformKey: Boolean(cfg.token),
    async step(stage, ctx) {
      if (stage !== 'Designing') return;
      const key = ctx.apiKey ?? cfg.token;
      if (!key) throw new Error('No API key is available for this provider.');
      const transparent = cfg.transparent && ctx.input.transparent === true;
      const res = await cfg.fetchFn('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          prompt: ctx.input.prompt,
          size: OPENAI_SIZES[ctx.input.aspect ?? 'square'],
          n: 1,
          ...(transparent ? { background: 'transparent', output_format: 'png' } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error('The provider rejected the API key.');
      if (res.status === 429) throw new Error('The provider is rate limiting requests. Try again shortly.');
      if (res.status === 400) throw new Error('The provider declined that brief. Try different wording.');
      if (!res.ok) throw new Error(`The provider could not create the design (${res.status}).`);
      const body = (await res.json()) as { data?: { b64_json?: string }[] };
      const b64 = body.data?.[0]?.b64_json;
      if (!b64) throw new Error('The provider returned an unexpected result.');
      const id = designAssetId();
      await ctx.assets.saveAsset(id, designFileName(ctx.input.title, id, 'png'), fromBase64(b64), false);
      return { assetId: id };
    },
  };
}

export const designAssetId = () => `design-${crypto.randomUUID().slice(0, 8)}`;
/** "Aqua Vibe" + design-1a2b3c4d -> "aqua-vibe-1a2b3c4d.png", so downloads are easy to tell apart. */
export const designFileName = (title: string | undefined, id: string, ext: string) => {
  const base = (title ?? 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'design';
  return `${base}-${id.replace(/^design-/, '')}.${ext}`;
};
