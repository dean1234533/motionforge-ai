import { describe, expect, it } from 'vitest';
import '../src/runtime/motionforge-runtime.js';
import { planFromPrompt } from '../src/ai/localPlanner';
import { newObject } from '../src/scene/defaults';

const MF = (globalThis as unknown as { MotionForge: Window['MotionForge'] }).MotionForge;

const obj = { ...newObject('bird', 'main', 'Bird'), ...planFromPrompt('fly from the bottom-left to the top-right').patch };

describe('runtime maths', () => {
  it('starts at the first keyframe and ends at the last', () => {
    expect(MF.samplePath(obj.path, 0)).toEqual({ x: obj.path[0].x, y: obj.path[0].y });
    expect(MF.samplePath(obj.path, 1)).toEqual({ x: obj.path.at(-1)!.x, y: obj.path.at(-1)!.y });
  });

  it('is a pure function of progress, so scrolling back reverses exactly', () => {
    const forward = [0, 0.2, 0.4, 0.6, 0.8, 1].map((p) => MF.evaluate(obj, p));
    const backward = [1, 0.8, 0.6, 0.4, 0.2, 0].map((p) => MF.evaluate(obj, p)).reverse();
    expect(backward).toEqual(forward);
  });

  it('moves up and to the right as progress increases', () => {
    const a = MF.evaluate(obj, 0.1);
    const b = MF.evaluate(obj, 0.9);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeLessThan(a.y);
  });

  it('advances the wing phase with progress', () => {
    expect(MF.evaluate(obj, 0.5).phase).toBeGreaterThan(MF.evaluate(obj, 0.1).phase);
  });

  it('interpolates evenly spaced series', () => {
    expect(MF.sampleArray([0, 10], 0.5)).toBe(5);
    expect(MF.sampleArray([3], 0.9)).toBe(3);
  });
});
