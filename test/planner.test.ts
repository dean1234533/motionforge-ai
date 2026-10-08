import { describe, expect, it } from 'vitest';
import { applyEditCommand } from '../src/ai/commands';
import { planFromPrompt } from '../src/ai/localPlanner';
import { emptyScene, newObject } from '../src/scene/defaults';
import { parseScene } from '../src/scene/schema';

const PROMPT =
  'Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right as the user scrolls.';

function planned() {
  const plan = planFromPrompt(PROMPT);
  const scene = {
    ...emptyScene(),
    objects: [{ ...newObject('bird', 'main', 'Bird'), ...plan.patch }],
    scroll: { ...emptyScene().scroll, length: plan.scrollLength ?? 1800 },
  };
  const r = parseScene(scene);
  if (!r.ok) throw new Error(r.error);
  return r.scene;
}

describe('planner', () => {
  it('plans a curved bottom-left to top-right flight with flapping', () => {
    const plan = planFromPrompt(PROMPT);
    const path = plan.patch.path!;
    expect(path[0].x).toBeLessThan(0);
    expect(path[0].y).toBeGreaterThan(100);
    expect(path[path.length - 1].x).toBeGreaterThan(100);
    expect(path[path.length - 1].y).toBeLessThan(0);
    expect(plan.patch.flapsPerScroll).toBeGreaterThan(0);
    // curved: the midpoint is off the straight line between the ends
    const mid = path[2];
    const straightX = (path[0].x + path[4].x) / 2;
    const straightY = (path[0].y + path[4].y) / 2;
    expect(Math.hypot(mid.x - straightX, mid.y - straightY)).toBeGreaterThan(5);
  });

  it('produces a schema-valid scene', () => {
    expect(planned().objects).toHaveLength(1);
  });
});

describe('follow-up commands', () => {
  it('makes the flight slower with a longer scroll', () => {
    const s = planned();
    const r = applyEditCommand('Make the bird fly more slowly.', s, 'bird')!;
    expect(r.scene.scroll.length).toBeGreaterThan(s.scroll.length);
  });

  it('makes wings flap faster', () => {
    const s = planned();
    const r = applyEditCommand('Make the wings flap faster.', s, 'bird')!;
    expect(r.scene.objects[0].flapsPerScroll).toBeGreaterThan(s.objects[0].flapsPerScroll);
  });

  it('moves the ending position higher', () => {
    const s = planned();
    const r = applyEditCommand('Move the ending position higher.', s, 'bird')!;
    const before = s.objects[0].path.at(-1)!.y;
    expect(r.scene.objects[0].path.at(-1)!.y).toBeLessThan(before);
  });

  it('reverses the direction', () => {
    const s = planned();
    const r = applyEditCommand('Reverse the direction.', s, 'bird')!;
    expect(r.scene.objects[0].path[0].x).toBeGreaterThan(100);
  });

  it('makes the object smaller on mobile only', () => {
    const s = planned();
    const r = applyEditCommand('Make the object smaller on mobile.', s, 'bird')!;
    expect(r.scene.objects[0].mobileScale).toBeLessThan(s.objects[0].mobileScale);
    expect(r.scene.objects[0].widthPct).toBe(s.objects[0].widthPct);
  });

  it('is honest about unsupported requests and ignores non-edits', () => {
    const s = planned();
    expect(applyEditCommand('Add clouds behind it.', s, 'bird')!.scene).toBe(s);
    expect(applyEditCommand(PROMPT, s, 'bird')).toBeNull();
  });
});
