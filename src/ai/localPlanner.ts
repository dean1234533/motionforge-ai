import { sanitizeText } from '../lib/sanitize';
import type { ScenePlan } from './providers';

type V = 'top' | 'bottom';
type H = 'left' | 'right';

const X: Record<H, number> = { left: -15, right: 115 };
const Y: Record<V, number> = { top: -10, bottom: 110 };

interface Pt {
  x: number;
  y: number;
}

/** Rule-based planner: turns plain English into motion settings for one object. */
export function planFromPrompt(prompt: string): ScenePlan {
  const t = sanitizeText(prompt).toLowerCase();

  let start: Pt = { x: X.left, y: Y.bottom };
  let end: Pt = { x: X.right, y: Y.top };
  let route = 'bottom-left to top-right';

  const corners = t.match(
    /from (?:the )?(top|bottom)[ -](left|right)(?: corner)? to (?:the )?(top|bottom)[ -](left|right)/,
  );
  const sides = t.match(/from (?:the )?(left|right)(?: side)? to (?:the )?(left|right)/);
  const vertical = t.match(/from (?:the )?(top|bottom) to (?:the )?(top|bottom)/);
  if (corners) {
    start = { x: X[corners[2] as H], y: Y[corners[1] as V] };
    end = { x: X[corners[4] as H], y: Y[corners[3] as V] };
    route = `${corners[1]}-${corners[2]} to ${corners[3]}-${corners[4]}`;
  } else if (sides) {
    start = { x: X[sides[1] as H], y: 60 };
    end = { x: X[sides[2] as H], y: 40 };
    route = `${sides[1]} to ${sides[2]}`;
  } else if (vertical) {
    start = { x: 50, y: Y[vertical[1] as V] };
    end = { x: 50, y: Y[vertical[2] as V] };
    route = `${vertical[1]} to ${vertical[2]}`;
  }

  const flapping = /bird|fly|flap|wing|butterfly|bat\b|bee\b/.test(t);
  const curved = /curv|arc|swoop|wave|loop/.test(t) || flapping;

  // Perpendicular bulge so the path curves instead of running in a straight line.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const path = steps.map((p) => {
    const bulge = curved ? Math.sin(Math.PI * p) * 14 : 0;
    return {
      progress: p,
      x: round(start.x + dx * p + nx * bulge),
      y: round(start.y + dy * p + ny * bulge),
    };
  });

  const cinematic = /cinematic|dramatic|epic/.test(t);
  const slow = /slow|gentle|calm/.test(t);
  const fast = /fast|quick|snappy/.test(t);
  const scrollLength = cinematic ? 2600 : slow ? 2600 : fast ? 1100 : 1800;

  return {
    patch: {
      path,
      rotation: [0],
      scale: [0.75, 1, 0.85],
      opacity: [1],
      followPath: true,
      bob: flapping ? 1.2 : 0,
      bobCycles: 4,
      flapsPerScroll: flapping ? 14 : 0,
      easing: cinematic ? 'cinematic' : 'easeInOut',
      pinned: false,
      start: 0,
      end: 1,
    },
    scrollLength,
    summary: `Planned a ${curved ? 'curved ' : ''}path from the ${route}${
      flapping ? ' with wing flapping' : ''
    }, over ${scrollLength}px of scrolling.`,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
