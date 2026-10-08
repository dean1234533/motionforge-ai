import { z } from 'zod';
import { planFromIntent, planFromPrompt } from '../../src/ai/localPlanner';
import type { Intent } from '../../src/ai/localPlanner';
import { sanitizeText } from '../../src/lib/sanitize';
import type { ScenePlan } from '../../src/ai/providers';
import type { ServerProvider } from './providers';
import type { AiBinding } from './types';

export const TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (min: number, max: number) => z.number().finite().transform((v) => clamp(v, min, max));

/** What the language model is asked for. Every number is clamped, so it can never produce an invalid scene. */
const LlmIntent = z.object({
  startX: num(-40, 140),
  startY: num(-40, 140),
  endX: num(-40, 140),
  endY: num(-40, 140),
  curved: z.boolean(),
  flapsPerScroll: num(0, 40),
  scrollLength: num(600, 6000),
  cinematic: z.boolean(),
  bob: num(0, 5),
  scaleStart: num(0.3, 2),
  scaleMiddle: num(0.3, 2),
  scaleEnd: num(0.3, 2),
  spin: num(-360, 360),
  opacityStart: num(0, 1),
  opacityEnd: num(0, 1),
});

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(LlmIntent.shape).map((k) => [k, { type: ['curved', 'cinematic'].includes(k) ? 'boolean' : 'number' }]),
  ),
  required: Object.keys(LlmIntent.shape),
};

const SYSTEM = `You turn a short description of how ONE object should move as a website visitor scrolls into numbers.
Screen coordinates are percentages: x from 0 (left edge) to 100 (right edge), y from 0 (top edge) to 100 (bottom edge).
Use values like -15 or 115 to start or end just outside the screen.
Fields:
startX,startY: where the object starts. endX,endY: where it ends.
curved: true if the path should bend instead of being a straight line.
flapsPerScroll: how many times wings flap over the whole scroll (0 for things without wings, around 14 for a bird).
scrollLength: pixels of scrolling the movement takes (1800 is normal, 2600 slower, 1100 faster).
cinematic: true for a slow, dramatic, smooth feel.
bob: gentle up and down wobble in percent (0 to 2).
scaleStart,scaleMiddle,scaleEnd: size multipliers over the scroll (1 is normal).
spin: total degrees the object rotates over the scroll (0 for none, 360 for one full turn).
opacityStart,opacityEnd: 0 invisible to 1 fully visible.
Examples:
"fly from the bottom-left to the top-right" -> startX -15, startY 110, endX 115, endY -10, curved true, flapsPerScroll 14, scrollLength 1800.
"rotate once and grow while staying in the middle" -> startX 50, startY 50, endX 50, endY 50, curved false, flapsPerScroll 0, spin 360, scaleStart 0.6, scaleMiddle 1, scaleEnd 1.4.
"fade in while drifting down from the top" -> startX 50, startY -10, endX 50, endY 55, opacityStart 0, opacityEnd 1.
Answer with the JSON object only.`;

function toIntent(i: z.infer<typeof LlmIntent>): Intent {
  return {
    start: { x: i.startX, y: i.startY },
    end: { x: i.endX, y: i.endY },
    curved: i.curved,
    flapsPerScroll: Math.round(i.flapsPerScroll),
    scrollLength: Math.round(i.scrollLength / 50) * 50,
    cinematic: i.cinematic,
    bob: Math.round(i.bob * 10) / 10,
    scale: [i.scaleStart, i.scaleMiddle, i.scaleEnd],
    spin: Math.round(i.spin),
    opacity: [i.opacityStart, i.opacityEnd],
  };
}

/**
 * Asks the language model for the movement, and falls back to the rule-based planner if it errors or
 * answers with something that is not valid. The model only chooses numbers; it never writes scene code.
 */
export async function planWithAi(ai: AiBinding, rawPrompt: string): Promise<ScenePlan & { usedAi: boolean }> {
  const prompt = sanitizeText(rawPrompt);
  try {
    const out = (await ai.run(TEXT_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_schema', json_schema: SCHEMA },
      max_tokens: 400,
      temperature: 0.2,
    })) as { response?: unknown };
    const raw = typeof out.response === 'string' ? JSON.parse(out.response) : out.response;
    const parsed = LlmIntent.safeParse(raw);
    if (!parsed.success) throw new Error('invalid plan');
    return { ...planFromIntent(toIntent(parsed.data)), usedAi: true };
  } catch {
    return { ...planFromPrompt(prompt), usedAi: false };
  }
}

export function workersAiPlannerProvider(ai: AiBinding): ServerProvider {
  return {
    id: 'workers-ai:llama-3.1-8b',
    platformKey: true,
    async step(stage, ctx) {
      if (stage !== 'Analysing prompt') return;
      const { usedAi, ...plan } = await planWithAi(ai, ctx.input.prompt);
      return { plan, usedAi };
    },
  };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text-to-image with FLUX on Cloudflare's own AI. JPEG has no transparency, so the subject is requested on white. */
export function workersAiImageProvider(ai: AiBinding): ServerProvider {
  return {
    id: 'workers-ai:flux-1-schnell',
    platformKey: true,
    async step(stage, ctx) {
      if (stage !== 'Generating image') return;
      let image: unknown;
      try {
        const out = (await ai.run(IMAGE_MODEL, {
          prompt: `${ctx.input.prompt}. A single isolated subject on a plain solid white background.`.slice(0, 2000),
          steps: 4,
        })) as { image?: unknown };
        image = out.image;
      } catch {
        throw new Error('The AI service could not create that image. Try different wording.');
      }
      if (typeof image !== 'string' || !image) throw new Error('The AI service returned no image.');
      const id = `gen-${crypto.randomUUID().slice(0, 8)}`;
      await ctx.assets.saveAsset(id, `${id}.jpg`, fromBase64(image), false);
      return { assetId: id };
    },
  };
}
