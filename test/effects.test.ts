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
      expect(data.length).toBe(fx.effect!.count * 7);
      for (let i = 0; i < data.length; i++) expect(Number.isFinite(data[i])).toBe(true);
      for (let i = 6; i < data.length; i += 7) expect(data[i]).toBeGreaterThanOrEqual(0);
      for (let i = 6; i < data.length; i += 7) expect(data[i]).toBeLessThanOrEqual(1);
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
    for (let i = 1; i < data.length; i += 7) if (data[i] <= emitterY + 1) above++;
    expect(above).toBe(smoke.effect!.count);
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
    expect(rain.effect).toMatchObject({ type: 'snow', color: '#9ec9ff' });
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
