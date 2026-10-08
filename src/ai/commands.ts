import { sanitizeText } from '../lib/sanitize';
import { newEffect, newLine, newShape } from '../scene/defaults';
import { parseScene } from '../scene/schema';
import type { EffectSettings, EffectType, Scene, SceneObject } from '../scene/schema';

export interface EditResult {
  scene: Scene;
  message: string;
  /** Work the editor must do on the server (it needs an image provider), then place the result. */
  action?: { type: 'generate-image'; prompt: string; behind: boolean };
}

const EFFECT_WORDS: { re: RegExp; type: EffectType; settings?: Partial<EffectSettings>; global?: boolean }[] = [
  { re: /\b(smoke|steam|exhaust)\b/, type: 'smoke' },
  { re: /\b(fire|flames?|flaming|blaze)\b/, type: 'fire' },
  { re: /\b(water|splash|fountain)\b/, type: 'water' },
  { re: /\b(sparkles?|sparks|glitter)\b/, type: 'sparkle' },
  { re: /\b(rain|raindrops?)\b/, type: 'snow', global: true, settings: { color: '#9ec9ff', size: 5, loops: 10, count: 220 } },
  { re: /\b(snow|snowfall|snowflakes?)\b/, type: 'snow', global: true },
];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r1 = (n: number) => Math.round(n * 10) / 10;

function reversePath(o: SceneObject): SceneObject {
  return {
    ...o,
    path: [...o.path].map((k) => ({ ...k, progress: 1 - k.progress })).sort((a, b) => a.progress - b.progress),
    rotation: [...o.rotation].reverse(),
    scale: [...o.scale].reverse(),
    opacity: [...o.opacity].reverse(),
    blur: [...o.blur].reverse(),
  };
}

/**
 * Follow-up edits in plain English. Returns null when the text is not a recognised edit,
 * so the caller can treat it as a fresh motion description instead.
 */
export function applyEditCommand(prompt: string, scene: Scene, targetId: string | null): EditResult | null {
  const t = sanitizeText(prompt).toLowerCase();
  const ids = new Set(targetId ? [targetId] : scene.objects.map((o) => o.id));
  const notes: string[] = [];
  let length = scene.scroll.length;
  let smoothing = scene.scroll.smoothing;
  let objects = scene.objects;

  const edit = (fn: (o: SceneObject) => SceneObject) => {
    objects = objects.map((o) => (ids.has(o.id) ? fn(o) : o));
  };

  if (/\b(add|insert|put|give|include)\b/.test(t)) {
    const fx = EFFECT_WORDS.find((f) => f.re.test(t));
    if (fx) {
      if (scene.objects.length >= 20) return { scene, message: 'This scene already has the maximum number of layers.' };
      const effect = newEffect(`${fx.type}-${Math.random().toString(36).slice(2, 6)}`, fx.type, fx.global ? null : targetId);
      if (fx.settings) effect.effect = { ...effect.effect!, ...fx.settings };
      if (/\bbehind\b/.test(t)) effect.effect = { ...effect.effect!, layer: 'back' };
      const next = parseScene({ ...scene, objects: [...scene.objects, effect] });
      if (!next.ok) return { scene, message: `That change would make the scene invalid (${next.error}).` };
      const follows = effect.attachTo ? ' It follows the selected layer.' : '';
      return { scene: next.scene, message: `Added ${fx.type === 'snow' && fx.settings ? 'rain' : fx.type}.${follows} Adjust it in the properties panel.` };
    }
    const shapeWord = /\b(circle|ball|dot|disc|rectangle|square|box)\b/.exec(t);
    if (shapeWord) {
      if (scene.objects.length >= 20) return { scene, message: 'This scene already has the maximum number of layers.' };
      const kind = /rect|square|box/.test(shapeWord[1]) ? 'rect' : 'circle';
      const shape = newShape(`shape-${Math.random().toString(36).slice(2, 6)}`, kind);
      const next = parseScene({ ...scene, objects: [...scene.objects, shape] });
      if (!next.ok) return { scene, message: `That change would make the scene invalid (${next.error}).` };
      return { scene: next.scene, message: `Added a ${kind === 'rect' ? 'rectangle' : 'circle'}. Drag its handles to move it, and change its colour in the properties panel.` };
    }
    if (/\b(line|trail|route|trace)\b/.test(t) || /\b(draw|show)\b.*\bpath\b/.test(t)) {
      if (scene.objects.length >= 20) return { scene, message: 'This scene already has the maximum number of layers.' };
      const line = newLine(`line-${Math.random().toString(36).slice(2, 6)}`, targetId);
      const next = parseScene({ ...scene, objects: [...scene.objects, line] });
      if (!next.ok) return { scene, message: `That change would make the scene invalid (${next.error}).` };
      return { scene: next.scene, message: targetId ? 'Added a line that draws the selected layer\'s path as you scroll.' : 'Added a line. Drag its handles to shape it.' };
    }
    const thing = /\b(clouds?|trees?|sun|moon|birds?|stars?|mountains?|hills?|buildings?|city|background|grass|flowers?)\b/.exec(t);
    if (thing) {
      const phrase = /\badd\s+(?:some\s+|a\s+|an\s+|the\s+)?(.+?)(?:\s+(?:behind|in front|to|around|near|beside)\b.*)?$/.exec(t)?.[1] ?? thing[1];
      return {
        scene,
        message: `Creating new artwork needs an image provider. If this server has one (or you connected your own key), I will generate “${phrase}” for you.`,
        action: { type: 'generate-image', prompt: `soft ${phrase}`.slice(0, 200), behind: /\bbehind\b/.test(t) || !/\bin front\b/.test(t) },
      };
    }
  }
  if (/\b(parallax|more depth|add depth)\b/.test(t)) {
    edit((o) => ({ ...o, parallax: 0.6 }));
    notes.push('Added parallax, so this layer drifts against the scroll.');
  }

  const wings = /\b(wings?|flap\w*)\b/.test(t);

  if (/\b(slower|slowly|slow down|more gentle)\b/.test(t)) {
    if (wings) {
      edit((o) => ({ ...o, flapsPerScroll: r1(clamp(o.flapsPerScroll * 0.7, 0, 80)) }));
      notes.push('Slowed the wing flapping.');
    } else {
      length = clamp(length * 1.35, 300, 20000);
      notes.push('Made the movement slower (longer scroll).');
    }
  }
  if (/\b(faster|quicker|speed up|more quickly)\b/.test(t)) {
    if (wings) {
      edit((o) => ({ ...o, flapsPerScroll: r1(clamp(Math.max(o.flapsPerScroll, 4) * 1.4, 0, 80)) }));
      notes.push('Sped up the wing flapping.');
    } else {
      length = clamp(length / 1.35, 300, 20000);
      notes.push('Made the movement faster (shorter scroll).');
    }
  }

  const which = /\b(end|ending|finish|finishing)\b/.test(t) ? 'end' : /\b(start|starting|beginning)\b/.test(t) ? 'start' : null;
  if (which) {
    const dir = /\b(higher|up|top)\b/.test(t) ? 'up' : /\b(lower|down|bottom)\b/.test(t) ? 'down' : /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null;
    if (dir) {
      edit((o) => {
        const path = o.path.map((k) => ({ ...k }));
        const sorted = [...path].sort((a, b) => a.progress - b.progress);
        const k = which === 'end' ? sorted[sorted.length - 1] : sorted[0];
        if (dir === 'up') k.y = r1(k.y - 10);
        if (dir === 'down') k.y = r1(k.y + 10);
        if (dir === 'left') k.x = r1(k.x - 10);
        if (dir === 'right') k.x = r1(k.x + 10);
        return { ...o, path };
      });
      notes.push(`Moved the ${which} position ${dir}.`);
    }
  }

  const mobile = /\b(mobile|phone)\b/.test(t);
  if (/\b(smaller|shrink|reduce the size)\b/.test(t)) {
    edit((o) => (mobile ? { ...o, mobileScale: r1(clamp(o.mobileScale * 0.8, 0.2, 2)) } : { ...o, widthPct: r1(clamp(o.widthPct * 0.8, 2, 100)) }));
    notes.push(mobile ? 'Made it smaller on mobile.' : 'Made it smaller.');
  }
  if (/\b(bigger|larger|enlarge|increase the size)\b/.test(t)) {
    edit((o) => (mobile ? { ...o, mobileScale: r1(clamp(o.mobileScale * 1.25, 0.2, 2)) } : { ...o, widthPct: r1(clamp(o.widthPct * 1.25, 2, 100)) }));
    notes.push(mobile ? 'Made it larger on mobile.' : 'Made it larger.');
  }

  if (/\b(reverse|flip)\b.*\b(direction|path|flight)\b/.test(t) || /\breverse (it|the animation)\b/.test(t)) {
    edit(reversePath);
    notes.push('Reversed the direction.');
  }

  if (/\bcinematic\b/.test(t)) {
    edit((o) => ({ ...o, easing: 'cinematic', bob: r1(Math.min(o.bob, 1)) }));
    length = clamp(length * 1.4, 300, 20000);
    smoothing = 0.3;
    notes.push('Gave it a slower, smoother cinematic feel.');
  }

  if (/\bunpin\b/.test(t)) {
    edit((o) => ({ ...o, pinned: false }));
    notes.push('Unpinned from the viewport.');
  } else if (/\bpin\b/.test(t)) {
    edit((o) => ({ ...o, pinned: true }));
    notes.push('Pinned to the viewport.');
  }

  if (!notes.length) return null;

  const next = parseScene({ ...scene, objects, scroll: { ...scene.scroll, length, smoothing } });
  if (!next.ok) return { scene, message: `That change would make the scene invalid (${next.error}).` };
  return { scene: next.scene, message: notes.join(' ') };
}
