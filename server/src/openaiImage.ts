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
