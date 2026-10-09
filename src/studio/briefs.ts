import { planFromIntent } from '../ai/localPlanner';
import type { Intent } from '../ai/localPlanner';
import type { ScenePlan } from '../ai/providers';
import { sanitizeText } from '../lib/sanitize';

/**
 * Brand Studio: a short brief (name, what the business does, style, colours) becomes a detailed,
 * designer-style prompt. The prompt spells out the exact text to render and the layout rules that make
 * the result usable as a real logo, flyer or ad, which is what people sell to clients.
 */

export type DesignType = 'logo' | 'flyer' | 'product' | 'social' | 'mockup';
export type Aspect = 'square' | 'portrait' | 'landscape';

export interface DesignStyle {
  id: string;
  label: string;
  /** Art direction appended to the prompt. */
  direction: string;
}

export interface DesignTypeInfo {
  id: DesignType;
  label: string;
  blurb: string;
  aspect: Aspect;
  /** Field labels, so each type asks for what it actually needs. */
  fields: { name: string; tagline: string; about: string; details?: string };
  styles: DesignStyle[];
}

export const DESIGN_TYPES: DesignTypeInfo[] = [
  {
    id: 'logo',
    label: 'Logo',
    blurb: 'Brand marks, mascots and badges, ready to sell to a client.',
    aspect: 'square',
    fields: { name: 'Brand name', tagline: 'Tagline (optional)', about: 'What the business does' },
    styles: [
      { id: 'mascot-3d', label: '3D mascot', direction: 'playful glossy 3D cartoon mascot character integrated with bold 3D lettering, vibrant saturated colours, soft studio lighting, sticker-style outline' },
      { id: 'bold-3d', label: 'Bold 3D lettering', direction: 'bold chunky 3D extruded lettering with glossy highlights and a subtle drop shadow, energetic and eye-catching' },
      { id: 'emblem', label: 'Emblem / badge', direction: 'circular emblem badge logo with an illustrated icon inside, clean ring border, text set around or under the icon' },
      { id: 'luxury', label: 'Luxury / elegant', direction: 'elegant luxury logo, refined serif typography, thin gold and metallic accents, graceful symbolic icon, premium and minimal' },
      { id: 'minimal', label: 'Minimal modern', direction: 'minimal modern flat vector logo, simple geometric icon, clean sans-serif wordmark, generous spacing, works in one colour' },
      { id: 'script', label: 'Hand-lettered script', direction: 'hand-lettered brush script wordmark with a small supporting icon, friendly and stylish' },
      { id: 'illustrated', label: 'Illustrated scene', direction: 'detailed illustrated logo with a small scene (for example a building, landscape or sunset) framed above bold lettering, rich colours' },
    ],
  },
  {
    id: 'flyer',
    label: 'Flyer / poster',
    blurb: 'Events, parties, launches and promotions with all the details.',
    aspect: 'portrait',
    fields: { name: 'Headline', tagline: 'Sub-headline (optional)', about: 'What it is for (event, sale, launch…)', details: 'Details to print (date, time, venue, price, contact)' },
    styles: [
      { id: 'night-luxury', label: 'Luxury night event', direction: 'luxurious night event poster, dark background with gold bokeh and sparkles, elegant model or champagne imagery, glamorous serif headline' },
      { id: 'street', label: 'Bold street / urban', direction: 'bold urban streetwear poster, gritty textures, graffiti accents, oversized condensed headline, high contrast' },
      { id: 'tropical', label: 'Tropical / Caribbean', direction: 'bright tropical Caribbean poster, beach, palm trees and sunshine, warm saturated colours, festive and inviting' },
      { id: 'corporate', label: 'Clean corporate', direction: 'clean professional corporate flyer, modern grid layout, confident sans-serif typography, polished photography' },
      { id: 'food', label: 'Food & drink promo', direction: 'mouth-watering food and drink promotional poster, close-up hero dish, steam and fresh ingredients, appetising lighting' },
    ],
  },
  {
    id: 'product',
    label: 'Product ad',
    blurb: 'Hero shots and adverts for drinks, sauces, cosmetics and more.',
    aspect: 'square',
    fields: { name: 'Product or brand name', tagline: 'Slogan (optional)', about: 'The product (what it is, flavour, size…)', details: 'Text to show (price, offer, website)' },
    styles: [
      { id: 'splash', label: 'Splash shot', direction: 'dynamic commercial product shot with liquid splash and flying fresh ingredients, crisp studio lighting, glossy reflections' },
      { id: 'studio-luxury', label: 'Studio luxury', direction: 'premium studio product photograph, dramatic rim lighting, sparkles and soft glow, rich dark backdrop' },
      { id: 'lifestyle', label: 'Lifestyle scene', direction: 'lifestyle advertising photo of the product in a natural real-world setting, warm daylight, aspirational mood' },
      { id: 'mascot-pack', label: 'Mascot packaging', direction: 'fun advert with a cartoon mascot character standing beside the product packaging, bright colours, playful and family friendly' },
    ],
  },
  {
    id: 'social',
    label: 'Social media post',
    blurb: 'Scroll-stopping posts for Instagram, Facebook and WhatsApp.',
    aspect: 'square',
    fields: { name: 'Headline', tagline: 'Call to action (optional)', about: 'What the post promotes', details: 'Extra text (price, date, handle)' },
    styles: [
      { id: 'cinematic', label: 'Cinematic photo', direction: 'cinematic photographic social media advert, real people, shallow depth of field, moody colour grade' },
      { id: 'bold-graphic', label: 'Bold graphic', direction: 'bold graphic social post, large type, bright colour blocks, clean shapes, strong contrast' },
      { id: 'cover-art', label: 'Music cover art', direction: 'music single cover art, artistic portrait, colourful urban backdrop, stylish title typography' },
    ],
  },
  {
    id: 'mockup',
    label: 'Merch & packaging mockup',
    blurb: 'Show a brand on hoodies, bottles, bags and labels.',
    aspect: 'square',
    fields: { name: 'Brand name', tagline: 'Tagline (optional)', about: 'Which items (hoodies, juice bottles, tote bags…)' },
    styles: [
      { id: 'apparel', label: 'Apparel on location', direction: 'photorealistic apparel mockup, neatly folded and hanging clothing printed with the brand logo, styled on location with natural light' },
      { id: 'bottles', label: 'Bottles & labels', direction: 'photorealistic packaging mockup, a row of bottles with colourful printed labels, fresh fruit around them, clean studio light' },
      { id: 'stationery', label: 'Stationery set', direction: 'photorealistic branding stationery mockup, business cards, letterhead and envelope on a clean desk, soft shadows' },
    ],
  },
];

export interface Brief {
  type: DesignType;
  styleId: string;
  name: string;
  tagline?: string;
  about?: string;
  details?: string;
  colors?: string;
  notes?: string;
  /** Logos only: ask for a transparent background where the model supports it. */
  transparent?: boolean;
}

export const typeInfo = (t: DesignType): DesignTypeInfo => DESIGN_TYPES.find((d) => d.id === t) ?? DESIGN_TYPES[0];

/** Text that will be rendered inside quotes: no quotes of its own, so the model reads it exactly. */
const quoted = (s: string | undefined, max: number) => sanitizeText((s ?? '').replace(/["“”]/g, "'"), max);

/** The prompt sent to the image model, plus the canvas it should use. */
export function buildDesignPrompt(brief: Brief): { prompt: string; aspect: Aspect; transparent: boolean } {
  const info = typeInfo(brief.type);
  const style = info.styles.find((s) => s.id === brief.styleId) ?? info.styles[0];
  const name = quoted(brief.name, 60);
  const tagline = quoted(brief.tagline, 80);
  const details = quoted(brief.details, 240);
  const about = sanitizeText(brief.about ?? '', 200);
  const colors = sanitizeText(brief.colors ?? '', 120);
  const notes = sanitizeText(brief.notes ?? '', 300);
  const transparent = brief.type === 'logo' && brief.transparent === true;

  const parts: string[] = [];
  switch (brief.type) {
    case 'logo':
      parts.push(`Professional logo design for the brand "${name}"${about ? `, ${about}` : ''}.`);
      if (tagline) parts.push(`Include the tagline "${tagline}" in smaller type beneath the name.`);
      parts.push(`Style: ${style.direction}.`);
      parts.push(
        `The brand name "${name}" is spelled exactly, letter for letter, and clearly legible.`,
        `One centred logo only, isolated on a ${transparent ? 'transparent' : 'plain solid white'} background, with even margins.`,
        'No mockup, no photo, no extra words, no watermark, no signature. Crisp clean edges, high resolution, works at small sizes on business cards and large on signage.',
      );
      break;
    case 'flyer':
      parts.push(`Professional print-ready flyer poster${about ? ` for ${about}` : ''}.`);
      parts.push(`Main headline: "${name}".`);
      if (tagline) parts.push(`Sub-headline: "${tagline}".`);
      if (details) parts.push(`Information block in clear smaller type: "${details}".`);
      parts.push(`Style: ${style.direction}.`);
      parts.push('Strong typographic hierarchy, every word spelled exactly as given and fully legible, balanced layout with safe margins, no other text, no watermark.');
      break;
    case 'product':
      parts.push(`High-end commercial advertisement for "${name}"${about ? `, ${about}` : ''}.`);
      if (tagline) parts.push(`Slogan text: "${tagline}".`);
      if (details) parts.push(`Small supporting text: "${details}".`);
      parts.push(`Style: ${style.direction}.`);
      parts.push(`The product and its packaging are the hero, with the name "${name}" printed clearly and spelled exactly on the label. Photorealistic, sharp focus, magazine quality, no watermark.`);
      break;
    case 'social':
      parts.push(`Eye-catching square social media post${about ? ` promoting ${about}` : ''}.`);
      parts.push(`Headline text: "${name}".`);
      if (tagline) parts.push(`Call to action text: "${tagline}".`);
      if (details) parts.push(`Small text: "${details}".`);
      parts.push(`Style: ${style.direction}.`);
      parts.push('All text spelled exactly as given and easy to read on a phone, clean composition, no watermark.');
      break;
    case 'mockup':
      parts.push(`Brand presentation mockup for "${name}"${about ? `: ${about}` : ''}.`);
      if (tagline) parts.push(`Tagline "${tagline}" appears on the items.`);
      parts.push(`Style: ${style.direction}.`);
      parts.push(`The brand name "${name}" is printed consistently on every item, spelled exactly. Photorealistic, professional product photography, no watermark.`);
      break;
  }
  if (colors) parts.push(`Colour palette: ${colors}.`);
  if (notes) parts.push(`Also: ${notes}.`);
  return { prompt: parts.join(' ').replace(/\.\./g, '.'), aspect: info.aspect, transparent };
}

// ---- making a logo move ---------------------------------------------------------------------

export interface LogoAnimation {
  id: string;
  label: string;
  intent: Intent;
  summary: string;
}

const still = { x: 50, y: 50 };

/** Ready-made scroll animations that suit a logo, applied without any paid generation. */
export const LOGO_ANIMATIONS: LogoAnimation[] = [
  {
    id: 'spin-in',
    label: 'Spin in',
    summary: 'The logo fades in and spins once as it grows to full size.',
    intent: { start: still, end: still, curved: false, flapsPerScroll: 0, scrollLength: 1600, cinematic: false, bob: 0, scale: [0.3, 1, 1.05], spin: 360, opacity: [0.15, 1] },
  },
  {
    id: 'zoom-reveal',
    label: 'Zoom reveal',
    summary: 'The logo rises from small and faint to large and bold.',
    intent: { start: { x: 50, y: 60 }, end: still, curved: false, flapsPerScroll: 0, scrollLength: 1800, cinematic: true, bob: 0, scale: [0.4, 1.1, 1.4], spin: 0, opacity: [0.15, 1] },
  },
  {
    id: 'drop-in',
    label: 'Drop in',
    summary: 'The logo drops in from the top and settles in the middle.',
    intent: { start: { x: 50, y: -15 }, end: still, curved: false, flapsPerScroll: 0, scrollLength: 1400, cinematic: false, bob: 0, scale: [0.8, 1, 1], spin: 0, opacity: [1, 1] },
  },
  {
    id: 'fly-across',
    label: 'Fly across',
    summary: 'The logo swoops across the screen from left to right.',
    intent: { start: { x: -15, y: 60 }, end: { x: 115, y: 40 }, curved: true, flapsPerScroll: 0, scrollLength: 1800, cinematic: false, bob: 0, scale: [0.8, 1.1, 0.8], spin: 0, opacity: [1, 1] },
  },
  {
    id: 'float',
    label: 'Gentle float',
    summary: 'The logo stays centred and floats gently up and down.',
    intent: { start: { x: 50, y: 52 }, end: { x: 50, y: 48 }, curved: false, flapsPerScroll: 0, scrollLength: 2400, cinematic: true, bob: 2, scale: [0.95, 1, 1.05], spin: 0, opacity: [1, 1] },
  },
];

export function logoAnimationPlan(id: string): ScenePlan {
  const a = LOGO_ANIMATIONS.find((x) => x.id === id) ?? LOGO_ANIMATIONS[0];
  const plan = planFromIntent(a.intent, a.summary);
  // A spinning or floating logo should stay upright rather than tilt along its path.
  return { ...plan, patch: { ...plan.patch, followPath: false } };
}
