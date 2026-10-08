import { z } from 'zod';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cinematic'] as const;
export type Easing = (typeof EASINGS)[number];

export const KeyframeSchema = z.object({
  progress: num(0, 1),
  x: num(-100, 200),
  y: num(-100, 200),
});

export const SceneObjectSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(60),
    assetId: id,
    widthPct: num(2, 100).default(22),
    flapsPerScroll: num(0, 80).default(0),
    path: z.array(KeyframeSchema).min(2).max(24),
    rotation: z.array(num(-360, 360)).min(1).max(16).default([0]),
    scale: z.array(num(0.05, 5)).min(1).max(16).default([1]),
    opacity: z.array(num(0, 1)).min(1).max(16).default([1]),
    blur: z.array(num(0, 40)).min(1).max(16).default([0]),
    followPath: z.boolean().default(false),
    bob: num(0, 20).default(0),
    bobCycles: num(0, 30).default(3),
    easing: z.enum(EASINGS).default('easeInOut'),
    pinned: z.boolean().default(false),
    start: num(0, 1).default(0),
    end: num(0, 1).default(1),
    mobileScale: num(0.2, 2).default(0.7),
  })
  .refine((o) => o.end > o.start, { message: 'end must be after start', path: ['end'] });

export const SceneSchema = z
  .object({
    scene: z
      .object({
        width: z.number().int().min(200).max(8000).default(1440),
        height: z.number().int().min(200).max(8000).default(900),
        background: z.literal('transparent').default('transparent'),
      })
      .default({}),
    objects: z.array(SceneObjectSchema).max(20),
    scroll: z
      .object({
        length: num(300, 20000).default(1800),
        scrub: z.literal(true).default(true),
        reverse: z.boolean().default(true),
        smoothing: num(0, 1).default(0.15),
      })
      .default({}),
  })
  .refine((s) => new Set(s.objects.map((o) => o.id)).size === s.objects.length, {
    message: 'object ids must be unique',
    path: ['objects'],
  });

export type Scene = z.infer<typeof SceneSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string };

/** Validate untrusted data (user JSON or AI output) before it is rendered. */
export function parseScene(input: unknown): ParseResult {
  const r = SceneSchema.safeParse(input);
  if (r.success) return { ok: true, scene: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: `${issue.path.join('.') || 'scene'}: ${issue.message}` };
}
