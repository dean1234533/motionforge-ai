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

/**
 * What a movement description boils down to. Both the rule-based planner and the AI planner produce this,
 * and one function turns it into scene settings, so an AI can only ever choose numbers within these limits.
 */
export interface Intent {
  start: Pt;
  end: Pt;
  curved: boolean;
  flapsPerScroll: number;
  scrollLength: number;
  cinematic: boolean;
  bob: number;
  /** Start, middle, end scale. */
  scale: [number, number, number];
  /** Total rotation over the scroll, in degrees. 0 means tilt to follow the path instead. */
  spin: number;
  /** Start and end opacity. */
  opacity: [number, number];
}

export function planFromIntent(intent: Intent, summary?: string): ScenePlan {
  const { start, end } = intent;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const path = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const bulge = intent.curved ? Math.sin(Math.PI * p) * 14 : 0;
    return { progress: p, x: round(start.x + dx * p + nx * bulge), y: round(start.y + dy * p + ny * bulge) };
  });

  return {
    patch: {
      path,
      rotation: intent.spin ? [0, intent.spin] : [0],
      scale: intent.scale,
      opacity: intent.opacity[0] === 1 && intent.opacity[1] === 1 ? [1] : intent.opacity,
      followPath: intent.spin === 0,
      bob: intent.bob,
      bobCycles: 4,
      flapsPerScroll: intent.flapsPerScroll,
      easing: intent.cinematic ? 'cinematic' : 'easeInOut',
      pinned: false,
      start: 0,
      end: 1,
    },
    scrollLength: intent.scrollLength,
    summary:
      summary ??
      `Planned a ${intent.curved ? 'curved ' : ''}path across the screen${intent.flapsPerScroll ? ' with wing flapping' : ''}, over ${intent.scrollLength}px of scrolling.`,
  };
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
  const cinematic = /cinematic|dramatic|epic/.test(t);
  const slow = /slow|gentle|calm/.test(t);
  const fast = /fast|quick|snappy/.test(t);
  const scrollLength = cinematic ? 2600 : slow ? 2600 : fast ? 1100 : 1800;

  return planFromIntent(
    {
      start,
      end,
      curved,
      flapsPerScroll: flapping ? 14 : 0,
      scrollLength,
      cinematic,
      bob: flapping ? 1.2 : 0,
      scale: [0.75, 1, 0.85],
      spin: 0,
      opacity: [1, 1],
    },
    `Planned a ${curved ? 'curved ' : ''}path from the ${route}${flapping ? ' with wing flapping' : ''}, over ${scrollLength}px of scrolling.`,
  );
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
