import type { EffectSettings, EffectType, Scene, SceneObject, ShapeSettings } from './schema';

export function emptyScene(): Scene {
  return {
    scene: { width: 1440, height: 900, background: 'transparent' },
    objects: [],
    scroll: { length: 1800, scrub: true, reverse: true, smoothing: 0.15 },
  };
}

export function newObject(id: string, assetId: string, name: string): SceneObject {
  return {
    id,
    name,
    kind: 'image',
    assetId,
    widthPct: 22,
    flapsPerScroll: 0,
    path: [
      { progress: 0, x: 50, y: 50 },
      { progress: 1, x: 50, y: 50 },
    ],
    rotation: [0],
    scale: [1],
    opacity: [1],
    blur: [0],
    followPath: false,
    bob: 0,
    bobCycles: 3,
    easing: 'easeInOut',
    pinned: false,
    start: 0,
    end: 1,
    mobileScale: 0.7,
    parallax: 0,
    attachTo: null,
    offsetX: 0,
    offsetY: 0,
  };
}

export const EFFECT_LABELS: Record<EffectType, string> = {
  smoke: 'Smoke',
  fire: 'Fire',
  water: 'Water',
  sparkle: 'Sparkles',
  snow: 'Snow',
};

const PRESETS: Record<EffectType, Omit<EffectSettings, 'type' | 'seed' | 'layer'>> = {
  smoke: { count: 90, size: 46, color: '#cfd6df', spread: 6, rise: 35, loops: 5 },
  fire: { count: 160, size: 26, color: '#ffb02e', spread: 3, rise: 16, loops: 12 },
  water: { count: 140, size: 9, color: '#6ab7ff', spread: 14, rise: 26, loops: 8 },
  sparkle: { count: 80, size: 9, color: '#fff3b0', spread: 22, rise: 18, loops: 6 },
  snow: { count: 160, size: 9, color: '#ffffff', spread: 100, rise: 100, loops: 3 },
};

/**
 * A particle effect layer. If `attachTo` is set it follows that object, offset by (offsetX, offsetY) % of the stage.
 */
export function newEffect(id: string, type: EffectType, attachTo: string | null = null): SceneObject {
  const base = newObject(id, 'none', EFFECT_LABELS[type]);
  return {
    ...base,
    kind: 'effect',
    effect: { type, seed: Math.floor(Math.random() * 100000), layer: 'front', ...PRESETS[type] },
    attachTo,
    offsetX: 0,
    offsetY: attachTo ? 4 : 0,
    path: [
      { progress: 0, x: 50, y: type === 'snow' ? 0 : 70 },
      { progress: 1, x: 50, y: type === 'snow' ? 0 : 70 },
    ],
  };
}
