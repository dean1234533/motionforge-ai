import { sanitizeText } from '../lib/sanitize';
import { parseScene } from '../scene/schema';
import type { Scene, SceneObject } from '../scene/schema';

export interface EditResult {
  scene: Scene;
  message: string;
}

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

  if (/\b(add|insert|put)\b.*\b(clouds?|trees?|sun|moon|birds?|stars?|background)\b/.test(t)) {
    return {
      scene,
      message:
        'Adding new generated objects needs an AI image provider, which runs on the server and is not part of this version. Upload the image you want as a new layer instead.',
    };
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
