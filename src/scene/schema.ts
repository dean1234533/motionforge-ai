import { z } from 'zod';

const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cinematic'] as const;
export type Easing = (typeof EASINGS)[number];

export const EFFECT_TYPES = ['smoke', 'fire', 'water', 'sparkle', 'snow'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export const KeyframeSchema = z.object({
  progress: num(0, 1),
  x: num(-100, 200),
  y: num(-100, 200),
});

/** Particle effect settings. Particles are a pure function of scroll, so they scrub and reverse exactly. */
export const EffectSchema = z.object({
  type: z.enum(EFFECT_TYPES),
  count: z.number().int().min(10).max(800).default(120),
  /** Particle size in px on a 1440 px wide stage. */
  size: num(2, 200).default(28),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  /** Width of the emitter, as % of the stage. */
  spread: num(0, 100).default(14),
  /** How far particles travel, as % of the stage height. */
  rise: num(0, 150).default(30),
  /** Full particle cycles over the whole scroll. */
  loops: num(0.1, 40).default(6),
  seed: z.number().int().min(0).max(1_000_000).default(1),
  /** Which side of the images the effect is drawn on (when drawn with WebGL). */
  layer: z.enum(['back', 'front']).default('front'),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const layer = z.enum(['back', 'front']);

/** A simple coloured shape. Drawn as an HTML/CSS element. */
export const ShapeSchema = z.object({
  type: z.enum(['circle', 'rect']).default('circle'),
  color: hex.default('#8ab4ff'),
  /** Size as % of the stage width and height. */
  widthPct: num(1, 100).default(10),
  heightPct: num(1, 100).default(10),
  /** Corner rounding for rectangles, as % of the shorter side. */
  radius: num(0, 50).default(12),
  layer: layer.default('front'),
});

/** A vector line along a path. Drawn as SVG, and it draws itself in as you scroll. */
export const LineSchema = z.object({
  color: hex.default('#ffffff'),
  /** Stroke width in px. */
  width: num(1, 40).default(4),
  cap: z.enum(['round', 'butt']).default('round'),
  /** 'draw' reveals the line with the scroll; 'static' shows all of it. */
  reveal: z.enum(['draw', 'static']).default('draw'),
  /** Dash length in px for a dashed static line (0 = solid). */
  dash: num(0, 50).default(0),
  layer: layer.default('front'),
});

export const SceneObjectSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['image', 'effect', 'shape', 'line']).default('image'),
    assetId: id.default('none'),
    effect: EffectSchema.optional(),
    shape: ShapeSchema.optional(),
    line: LineSchema.optional(),
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
    /** Extra drift against the scroll, for depth between layers. */
    parallax: num(-2, 2).default(0),
    /** Follow another object, offset by (offsetX, offsetY) % of the stage. */
    attachTo: id.nullable().default(null),
    offsetX: num(-100, 100).default(0),
    offsetY: num(-100, 100).default(0),
  })
  .refine((o) => o.end > o.start, { message: 'end must be after start', path: ['end'] })
  .refine((o) => o.kind !== 'effect' || o.effect !== undefined, { message: 'an effect needs its settings', path: ['effect'] })
  .refine((o) => o.kind !== 'shape' || o.shape !== undefined, { message: 'a shape needs its settings', path: ['shape'] })
  .refine((o) => o.kind !== 'line' || o.line !== undefined, { message: 'a line needs its settings', path: ['line'] });

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
  })
  .refine(
    (s) => {
      const ids = new Set(s.objects.map((o) => o.id));
      return s.objects.every((o) => o.attachTo === null || (o.attachTo !== o.id && ids.has(o.attachTo)));
    },
    { message: 'an object can only attach to a different object in the scene', path: ['objects'] },
  )
  .refine((s) => s.objects.reduce((n, o) => n + (o.effect?.count ?? 0), 0) <= 2000, {
    message: 'too many particles in one scene (limit 2000)',
    path: ['objects'],
  });

export type Scene = z.infer<typeof SceneSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type EffectSettings = z.infer<typeof EffectSchema>;
export type ShapeSettings = z.infer<typeof ShapeSchema>;
export type LineSettings = z.infer<typeof LineSchema>;

export type ParseResult = { ok: true; scene: Scene } | { ok: false; error: string };

/** Validate untrusted data (user JSON or AI output) before it is rendered. */
export function parseScene(input: unknown): ParseResult {
  const r = SceneSchema.safeParse(input);
  if (r.success) return { ok: true, scene: r.data };
  const issue = r.error.issues[0];
  return { ok: false, error: `${issue.path.join('.') || 'scene'}: ${issue.message}` };
}
