import { sanitizeText } from '../lib/sanitize';
import { planFromPrompt } from './localPlanner';
import type { ScenePlan } from './providers';

/** Actions need new poses, unlike moving or styling an already prepared layer. */
export function isSubjectAction(prompt: string): boolean {
  return /\b(moon[\s-]*walk\w*|danc\w*|walk\w*|run(?:ning)?|jump\w*|hop\w*|fly|flying|flap\w*|swim\w*|crawl\w*|climb\w*|kick\w*|punch\w*|wave\w*|nod\w*|blink\w*|talk\w*|sing\w*|eat\w*|drink\w*|bend\w*|bow\w*|sit\w*|stand\w*|transform\w*|perform\w*|pirouette\w*)\b/i.test(prompt);
}

export function requiresActionFrames(prompt: string): boolean {
  const text = sanitizeText(prompt).toLowerCase();
  if (isSubjectAction(text)) return true;
  // Unknown actions must not silently become the default bird flight path.
  return !/\b(move|slide|float|drift|rotate|spin|scale|grow|fade|opacity|blur|parallax|path|position|scroll|size)\b|\bfrom\b.+\bto\b/.test(text);
}

export function actionPlan(prompt: string): ScenePlan {
  const text = sanitizeText(prompt);
  const route = /\bfrom\b.+\bto\b/i.test(text) ? planFromPrompt(text) : null;
  return {
    patch: {
      ...(route ? { path: route.patch.path } : {}),
      flapsPerScroll: 0,
      motion: { playback: /\b(loop\w*|repeat\w*|seamless)\b/i.test(text) ? 'loop' : 'once', cycles: 1 },
      bob: 0,
      easing: 'linear',
    },
    scrollLength: route?.scrollLength,
    summary: 'Generated an action sequence for the selected subject. Scrub the timeline to inspect the movement.',
  };
}

export function actionVideoPrompt(prompt: string): string {
  const text = sanitizeText(prompt);
  const moonwalk = /moon[\s-]*walk/i.test(text)
    ? ' Moonwalk mechanics: alternating toe-supported steps with the other planted foot sliding backward, believable weight transfer, coordinated hips, knees and ankles. Do not simply slide a rigid still image.' : '';
  return `${text}.${moonwalk} Animate the same subject from the reference image performing the requested action. Preserve its identity, proportions, clothing, materials and number of limbs. Use coherent joint articulation, realistic weight, balance and contact. Keep the entire subject and all extremities in frame with generous empty margins throughout. Locked camera, consistent scale and lighting. No mirrored fragments, extra limbs, morphing, clipped body parts or camera movement.`;
}
