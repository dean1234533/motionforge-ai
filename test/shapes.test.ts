import { describe, expect, it } from 'vitest';
import '../src/runtime/motionforge-runtime.js';
import { applyEditCommand } from '../src/ai/commands';
import { emptyScene, newLine, newObject, newShape } from '../src/scene/defaults';
import { parseScene } from '../src/scene/schema';
import type { Scene } from '../src/scene/schema';

const MF = (globalThis as unknown as { MotionForge: Window['MotionForge'] }).MotionForge;
const scene = (objects: Scene['objects']): Scene => ({ ...emptyScene(), objects });

describe('shapes and lines in the scene', () => {
  it('accepts shapes and lines and rejects broken ones', () => {
    expect(parseScene(scene([newShape('s1', 'circle'), newShape('s2', 'rect'), newLine('l1')])).ok).toBe(true);
    const shape = newShape('s1');
    expect(parseScene(scene([{ ...shape, shape: undefined }])).ok).toBe(false);
    expect(parseScene(scene([{ ...shape, shape: { ...shape.shape!, color: 'blue' } }])).ok).toBe(false);
    const line = newLine('l1');
    expect(parseScene(scene([{ ...line, line: undefined }])).ok).toBe(false);
    expect(parseScene(scene([{ ...line, line: { ...line.line!, width: 500 } }])).ok).toBe(false);
  });

  it('exposes eased progress for the line reveal', () => {
    const line = { ...newLine('l1'), easing: 'linear' as const };
    expect(MF.evaluate(line, 0).t).toBe(0);
    expect(MF.evaluate(line, 0.25).t).toBeCloseTo(0.25, 6);
    expect(MF.evaluate(line, 1).t).toBe(1);
    const windowed = { ...line, start: 0.5, end: 1 };
    expect(MF.evaluate(windowed, 0.25).t).toBe(0);
    expect(MF.evaluate(windowed, 0.75).t).toBeCloseTo(0.5, 6);
  });

  it('a traced line points at its target', () => {
    const bird = newObject('bird', 'main', 'Bird');
    const line = newLine('l1', 'bird');
    expect(line.attachTo).toBe('bird');
    expect(parseScene(scene([bird, line])).ok).toBe(true);
    expect(parseScene(scene([line])).ok).toBe(false); // target must exist
  });
});

describe('shape and line commands', () => {
  const bird = newObject('bird', 'main', 'Bird');

  it('adds a circle or a rectangle', () => {
    const c = applyEditCommand('Add a circle', scene([bird]), 'bird')!;
    expect(c.scene.objects[1]).toMatchObject({ kind: 'shape', shape: { type: 'circle' } });
    const r = applyEditCommand('Put a rectangle in the scene', scene([bird]), 'bird')!;
    expect(r.scene.objects[1].shape!.type).toBe('rect');
  });

  it('adds a line that traces the selected layer', () => {
    const r = applyEditCommand('Add a line showing its path', scene([bird]), 'bird')!;
    expect(r.scene.objects[1]).toMatchObject({ kind: 'line', attachTo: 'bird' });
    expect(applyEditCommand('Add a smoke trail', scene([bird]), 'bird')!.scene.objects[1].kind).toBe('effect');
  });
});
