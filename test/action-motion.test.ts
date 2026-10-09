import { describe, expect, it } from 'vitest';
import { actionPlan, actionVideoPrompt, requiresActionFrames } from '../src/ai/actionMotion';
import { emptyScene, newObject } from '../src/scene/defaults';
import { parseScene } from '../src/scene/schema';
import { pruneAssets } from '../src/export/build';
import '../src/runtime/motionforge-runtime.js';

const MF = (globalThis as unknown as { MotionForge: Window['MotionForge'] }).MotionForge;

describe('subject action generation', () => {
  it('routes articulated and unfamiliar actions to generation, while allowing basic position changes', () => {
    for (const prompt of ['Make this robot dance by doing the moonwalk', 'Make the dog run', 'Make the bird flap its wings', 'Make the character pirouette', 'Make it juggle']) {
      expect(requiresActionFrames(prompt), prompt).toBe(true);
    }
    for (const prompt of ['Move it from left to right', 'Rotate the product', 'Fade the image in', 'Change its position']) {
      expect(requiresActionFrames(prompt), prompt).toBe(false);
    }
  });

  it('does not turn a robot dance into a bird path or body wobble', () => {
    const plan = actionPlan('Make this robot moonwalk');
    expect(plan.patch.path).toBeUndefined();
    expect(plan.patch.motion).toEqual({ playback: 'once', cycles: 1 });
    expect(plan.patch.bob).toBe(0);
    const object = { ...newObject('robot', 'robot', 'Robot'), ...plan.patch };
    const scene = parseScene({ ...emptyScene(), objects: [object] });
    expect(scene.ok).toBe(true);
    expect(MF.evaluate(object, 0.5).phase).toBe(0.5);
    expect(MF.sampleFrameIndex(MF.evaluate(object, 1).phase, 96, 'once')).toBe(95);
  });

  it('plays complete action frames forwards and backwards, ending on the final pose', () => {
    const forward = [0, 0.25, 0.5, 0.75, 1].map((p) => MF.sampleFrameIndex(p, 5, 'once'));
    expect(forward).toEqual([0, 1, 2, 3, 4]);
    expect([1, 0.75, 0.5, 0.25, 0].map((p) => MF.sampleFrameIndex(p, 5, 'once'))).toEqual([...forward].reverse());
    expect(MF.sampleFrameIndex(1, 5, 'loop')).toBe(0);
    expect(actionPlan('Make the robot moonwalk in a seamless loop').patch.motion?.playback).toBe('loop');
  });

  it('preserves the action sequence in exports even when wing flaps are zero', () => {
    const object = { ...newObject('robot', 'robot', 'Robot'), ...actionPlan('moonwalk').patch };
    const result = pruneAssets({ scene: { ...emptyScene(), objects: [object] }, assets: { robot: ['pose-1', 'pose-2', 'pose-3'], unused: ['x'] } });
    expect(result.assets).toEqual({ robot: ['pose-1', 'pose-2', 'pose-3'] });
  });

  it('gives the provider concrete action mechanics and identity/framing requirements', () => {
    const prompt = actionVideoPrompt('Make my robot moonwalk');
    expect(prompt).toContain('alternating toe-supported steps');
    expect(prompt).toContain('Do not simply slide a rigid still image');
    expect(prompt).toContain('Preserve its identity');
    expect(prompt).toContain('all extremities in frame');
  });
});
