import type { Scene, SceneObject } from './schema';

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
  };
}
