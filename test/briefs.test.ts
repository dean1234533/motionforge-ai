import { describe, expect, it } from 'vitest';
import { emptyScene, newObject } from '../src/scene/defaults';
import { parseScene } from '../src/scene/schema';
import { DESIGN_TYPES, LOGO_ANIMATIONS, buildDesignPrompt, logoAnimationPlan } from '../src/studio/briefs';

describe('Brand Studio briefs', () => {
  it('writes a logo prompt that spells out the name, tagline and layout rules', () => {
    const r = buildDesignPrompt({ type: 'logo', styleId: 'mascot-3d', name: 'Aqua Vibe Shop', tagline: 'Splash into summer', about: 'a beachwear shop', colors: 'ocean blue, yellow', transparent: true });
    expect(r.aspect).toBe('square');
    expect(r.transparent).toBe(true);
    expect(r.prompt).toContain('"Aqua Vibe Shop" is spelled exactly');
    expect(r.prompt).toContain('tagline "Splash into summer"');
    expect(r.prompt).toContain('3D cartoon mascot');
    expect(r.prompt).toContain('transparent background');
    expect(r.prompt).toContain('Colour palette: ocean blue, yellow.');
  });

  it('puts flyer details in and uses a portrait canvas', () => {
    const r = buildDesignPrompt({ type: 'flyer', styleId: 'night-luxury', name: 'Milestone Birthday', details: 'Sat 14 June, 8pm, Wanshu Bar, NW4 3JH', transparent: true });
    expect(r.aspect).toBe('portrait');
    expect(r.transparent).toBe(false);
    expect(r.prompt).toContain('Main headline: "Milestone Birthday"');
    expect(r.prompt).toContain('"Sat 14 June, 8pm, Wanshu Bar, NW4 3JH"');
  });

  it('keeps quoted text from breaking out of its quotes', () => {
    const r = buildDesignPrompt({ type: 'logo', styleId: 'minimal', name: 'Gabby"s "Fresh"' });
    expect(r.prompt).toContain('"Gabby\'s \'Fresh\'"');
  });

  it('has a working prompt for every type and style, within the server limit', () => {
    for (const t of DESIGN_TYPES) {
      for (const s of t.styles) {
        const r = buildDesignPrompt({ type: t.id, styleId: s.id, name: 'N'.repeat(60), tagline: 'T'.repeat(80), about: 'A'.repeat(200), details: 'D'.repeat(240), colors: 'C'.repeat(120), notes: 'X'.repeat(300) });
        expect(r.prompt).toContain(s.direction);
        expect(r.prompt.length).toBeLessThanOrEqual(1500);
      }
    }
  });

  it('turns every logo animation into a valid scene', () => {
    for (const a of LOGO_ANIMATIONS) {
      const plan = logoAnimationPlan(a.id);
      expect(plan.patch.followPath).toBe(false);
      const scene = { ...emptyScene(), objects: [{ ...newObject('logo-layer', 'logo', 'Logo'), widthPct: 30, ...plan.patch }] };
      expect(parseScene(scene).ok).toBe(true);
    }
    expect(logoAnimationPlan('spin-in').patch.rotation).toEqual([0, 360]);
  });
});
