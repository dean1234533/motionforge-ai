import { describe, expect, it } from 'vitest';
import { newObject, emptyScene } from '../src/scene/defaults';
import { parseScene } from '../src/scene/schema';

describe('scene schema', () => {
  it('accepts a valid scene and fills defaults', () => {
    const scene = { ...emptyScene(), objects: [newObject('bird', 'main', 'Bird')] };
    const r = parseScene(scene);
    expect(r.ok).toBe(true);
  });

  it('rejects out-of-range and malformed data', () => {
    const bad = { ...emptyScene(), objects: [{ ...newObject('bird', 'main', 'Bird'), opacity: [4] }] };
    expect(parseScene(bad).ok).toBe(false);
    expect(parseScene({ objects: 'nope' }).ok).toBe(false);
    expect(parseScene(null).ok).toBe(false);
  });

  it('rejects ids that could be used for injection', () => {
    const bad = { ...emptyScene(), objects: [{ ...newObject('bird', 'main', 'Bird'), id: '"><script>' }] };
    expect(parseScene(bad).ok).toBe(false);
  });

  it('rejects duplicate ids and inverted ranges', () => {
    const o = newObject('a', 'main', 'A');
    expect(parseScene({ ...emptyScene(), objects: [o, o] }).ok).toBe(false);
    expect(parseScene({ ...emptyScene(), objects: [{ ...o, start: 0.8, end: 0.2 }] }).ok).toBe(false);
  });
});
