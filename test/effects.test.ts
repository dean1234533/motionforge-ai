import { describe, expect, it } from 'vitest';
import '../src/runtime/motionforge-runtime.js';
import { applyEditCommand } from '../src/ai/commands';
import { planFromPrompt } from '../src/ai/localPlanner';
import { emptyScene, newEffect, newObject } from '../src/scene/defaults';
import { EFFECT_TYPES, parseScene } from '../src/scene/schema';
import type { Scene } from '../src/scene/schema';

const MF = (globalThis as unknown as { MotionForge: Window['MotionForge'] }).MotionForge;

const bird = { ...newObject('bird', 'main', 'Bird'), ...planFromPrompt('fly from the bottom-left to the top-right').patch };
const scene = (objects: Scene['objects']): Scene => ({ ...emptyScene(), objects });
const lookupIn = (s: Scene) => (id: string) => s.objects.find((o) => o.id === id) ?? null;

describe('effect schema', () => {
  it('accepts every effect type', () => {
    for (const type of EFFECT_TYPES) expect(parseScene(scene([newEffect(`fx-${type}`, type)])).ok).toBe(true);
  });

  it('rejects broken effects, bad attachments and runaway particle counts', () => {
    const fx = newEffect('smoke-1', 'smoke');
    expect(parseScene(scene([{ ...fx, effect: undefined }])).ok).toBe(false);
    expect(parseScene(scene([{ ...fx, effect: { ...fx.effect!, color: 'red' } }])).ok).toBe(false);
    expect(parseScene(scene([{ ...fx, effect: { ...fx.effect!, count: 5000 } }])).ok).toBe(false);
    expect(parseScene(scene([{ ...fx, attachTo: 'ghost' }])).ok).toBe(false);
    expect(parseScene(scene([{ ...fx, attachTo: 'smoke-1' }])).ok).toBe(false);
    const heavy = [1, 2, 3].map((i) => ({ ...newEffect(`snow-${i}`, 'snow'), effect: { ...newEffect('x', 'snow').effect!, count: 800 } }));
    expect(parseScene(scene(heavy)).ok).toBe(false);
  });
});

describe('attachment and parallax', () => {
  it('an attached object follows its target at a fixed offset', () => {
    const fx = { ...newEffect('smoke-1', 'smoke', 'bird'), offsetX: -5, offsetY: 7 };
    const s = scene([bird, fx]);
    for (const p of [0, 0.3, 0.7, 1]) {
      const b = MF.evaluate(bird, p, lookupIn(s));
      const e = MF.evaluate(fx, p, lookupIn(s));
      expect(e.x).toBeCloseTo(b.x - 5, 6);
      expect(e.y).toBeCloseTo(b.y + 7, 6);
    }
  });

  it('is not attached when there is no lookup, and survives attachment loops', () => {
    const a = { ...newObject('a', 'none', 'A'), attachTo: 'b' };
    const b = { ...newObject('b', 'none', 'B'), attachTo: 'a' };
    expect(Number.isFinite(MF.evaluate(a, 0.5, lookupIn(scene([a, b]))).x)).toBe(true);
    expect(MF.evaluate(a, 0.5).x).toBe(50);
  });

  it('parallax moves a layer against the scroll', () => {
    const still = newObject('c', 'none', 'C');
    const deep = { ...still, parallax: 1 };
    expect(MF.evaluate(deep, 0.5).y).toBeCloseTo(MF.evaluate(still, 0.5).y, 6);
    expect(MF.evaluate(deep, 1).y - MF.evaluate(still, 1).y).toBeCloseTo(20, 6);
    expect(MF.evaluate(deep, 0).y - MF.evaluate(still, 0).y).toBeCloseTo(-20, 6);
  });
});

describe('particles', () => {
  const pose = (obj: ReturnType<typeof newEffect>, p: number) => MF.evaluate(obj, p);

  it('produces finite, in-range data for every effect type', () => {
    for (const type of EFFECT_TYPES) {
      const fx = newEffect(`fx-${type}`, type);
      const data = MF.computeParticles(fx.effect, pose(fx, 0.37), 1440, 900, 1);
      expect(data.length).toBe(fx.effect!.count * MF.PARTICLE_STRIDE);
      for (let i = 0; i < data.length; i++) expect(Number.isFinite(data[i])).toBe(true);
      for (let i = 0; i < data.length; i += MF.PARTICLE_STRIDE) {
        expect(data[i + 2]).toBeGreaterThan(0);
        for (let c = 3; c <= 6; c++) expect(data[i + c]).toBeGreaterThanOrEqual(0);
        for (let c = 3; c <= 6; c++) expect(data[i + c]).toBeLessThanOrEqual(1);
        expect(data[i + 8]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('is a pure function of progress, so scrolling back reverses exactly', () => {
    const fx = newEffect('fire-1', 'fire');
    const at = (p: number) => Array.from(MF.computeParticles(fx.effect, pose(fx, p), 1200, 800, 1));
    const forward = [0.1, 0.4, 0.8].map(at);
    const back = [0.8, 0.4, 0.1].map(at).reverse();
    expect(back).toEqual(forward);
    expect(at(0.1)).not.toEqual(at(0.4));
  });

  it('smoke rises and fire is additive', () => {
    const smoke = newEffect('smoke-1', 'smoke');
    const emitterY = (smoke.path[0].y / 100) * 900;
    const data = MF.computeParticles(smoke.effect, pose(smoke, 0.5), 1440, 900, 1);
    let above = 0;
    for (let i = 1; i < data.length; i += MF.PARTICLE_STRIDE) if (data[i] <= emitterY + 1) above++;
    expect(above).toBe(smoke.effect!.count);
  });

  it('smoke spreads into a wider plume as it rises', () => {
    const smoke = { ...newEffect('smoke-1', 'smoke'), effect: { ...newEffect('s', 'smoke').effect!, count: 800 } };
    const cx = (smoke.path[0].x / 100) * 1440;
    const ey = (smoke.path[0].y / 100) * 900;
    const rise = (smoke.effect.rise / 100) * 900;
    const data = MF.computeParticles(smoke.effect, pose(smoke, 0.5), 1440, 900, 1);
    const low: number[] = [], high: number[] = [];
    for (let i = 0; i < data.length; i += MF.PARTICLE_STRIDE) {
      const up = (ey - data[i + 1]) / rise;
      if (up < 0.25) low.push(Math.abs(data[i] - cx));
      else if (up > 0.6) high.push(Math.abs(data[i] - cx));
    }
    const mean = (a: number[]) => a.reduce((t, v) => t + v, 0) / a.length;
    expect(mean(high)).toBeGreaterThan(mean(low) * 1.5);
  });

  it('fire is hottest (brightest) low in the flame and cools to red at the tips', () => {
    const fire = { ...newEffect('fire-1', 'fire'), effect: { ...newEffect('f', 'fire').effect!, count: 800 } };
    const ey = (fire.path[0].y / 100) * 900;
    const rise = (fire.effect.rise / 100) * 900;
    const data = MF.computeParticles(fire.effect, pose(fire, 0.5), 1440, 900, 1);
    const green = { low: [] as number[], high: [] as number[] };
    for (let i = 0; i < data.length; i += MF.PARTICLE_STRIDE) {
      if (data[i + 2] < fire.effect.size * 0.2) continue; // embers
      const up = (ey - data[i + 1]) / rise;
      if (up < 0.15) green.low.push(data[i + 4]);
      else if (up > 0.6) green.high.push(data[i + 4]);
    }
    const mean = (a: number[]) => a.reduce((t, v) => t + v, 0) / a.length;
    expect(mean(green.low)).toBeGreaterThan(mean(green.high) + 0.2);
  });

  it('rain falls as long slanted streaks; snow flakes are round', () => {
    const rain = newEffect('rain-1', 'rain');
    const snow = newEffect('snow-1', 'snow');
    const r = MF.computeParticles(rain.effect, pose(rain, 0.3), 1440, 900, 1);
    const s = MF.computeParticles(snow.effect, pose(snow, 0.3), 1440, 900, 1);
    for (let i = 0; i < r.length; i += MF.PARTICLE_STRIDE) expect(r[i + 8]).toBeGreaterThan(5);
    for (let i = 0; i < s.length; i += MF.PARTICLE_STRIDE) expect(s[i + 8]).toBe(1);
  });

  it('nearer snowflakes are bigger and more opaque than distant ones', () => {
    const snow = { ...newEffect('snow-1', 'snow'), effect: { ...newEffect('s', 'snow').effect!, count: 400 } };
    const data = MF.computeParticles(snow.effect, pose(snow, 0.3), 1440, 900, 1);
    const pts: { size: number; a: number }[] = [];
    for (let i = 0; i < data.length; i += MF.PARTICLE_STRIDE) pts.push({ size: data[i + 2], a: data[i + 6] });
    pts.sort((p, q) => p.size - q.size);
    const q = Math.floor(pts.length / 4);
    const avgA = (a: typeof pts) => a.reduce((t, p) => t + p.a, 0) / a.length;
    expect(avgA(pts.slice(-q))).toBeGreaterThan(avgA(pts.slice(0, q)) + 0.2);
  });

  it('different seeds give different particles', () => {
    const a = newEffect('a', 'sparkle');
    const b = { ...a, effect: { ...a.effect!, seed: a.effect!.seed + 1 } };
    expect(Array.from(MF.computeParticles(a.effect, pose(a, 0.4), 1000, 700, 1))).not.toEqual(Array.from(MF.computeParticles(b.effect, pose(b, 0.4), 1000, 700, 1)));
  });

  it('picks WebGL only for heavy scenes in browsers that have it', () => {
    const light = scene([{ ...newEffect('s', 'snow'), effect: { ...newEffect('s', 'snow').effect!, count: 249 } }]);
    const heavy = scene([{ ...newEffect('s', 'snow'), effect: { ...newEffect('s', 'snow').effect!, count: 250 } }]);
    expect(MF.chooseRenderer(light, true)).toBe('canvas2d');
    expect(MF.chooseRenderer(heavy, true)).toBe('webgl');
    expect(MF.chooseRenderer(heavy, false)).toBe('canvas2d');
    expect(MF.chooseRenderer(scene([bird]), true)).toBe('canvas2d');
  });
});

describe('effect and depth commands', () => {
  const base = scene([bird]);

  it('adds smoke that follows the selected layer', () => {
    const r = applyEditCommand('Add smoke behind it.', base, 'bird')!;
    const fx = r.scene.objects[1];
    expect(fx).toMatchObject({ kind: 'effect', attachTo: 'bird' });
    expect(fx.effect).toMatchObject({ type: 'smoke', layer: 'back' });
  });

  it('adds fire, sparkles and water the same way', () => {
    for (const [word, type] of [['fire', 'fire'], ['sparkles', 'sparkle'], ['a fountain', 'water']] as const) {
      const r = applyEditCommand(`Add ${word}`, base, 'bird')!;
      expect(r.scene.objects[1].effect!.type).toBe(type);
    }
  });

  it('rain and snow fall across the whole stage instead of following a layer', () => {
    const rain = applyEditCommand('Add rain', base, 'bird')!.scene.objects[1];
    expect(rain.attachTo).toBeNull();
    expect(rain.effect!.type).toBe('rain');
    expect(applyEditCommand('Put some snow in the scene', base, 'bird')!.scene.objects[1].effect!.type).toBe('snow');
  });

  it('hands scenery requests to the image generator', () => {
    const r = applyEditCommand('Add clouds behind it.', base, 'bird')!;
    expect(r.scene).toBe(base);
    expect(r.action).toEqual({ type: 'generate-image', prompt: 'soft clouds', behind: true });
  });

  it('refuses to exceed the layer limit', () => {
    const full = scene(Array.from({ length: 20 }, (_, i) => newObject(`o-${i}`, 'main', `O${i}`)));
    expect(applyEditCommand('Add smoke', full, 'o-0')!.scene).toBe(full);
  });

  it('adds parallax depth', () => {
    expect(applyEditCommand('Give it more depth', base, 'bird')!.scene.objects[0].parallax).toBe(0.6);
  });
});
