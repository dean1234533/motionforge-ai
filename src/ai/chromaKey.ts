/**
 * Chroma keying for generated video. The subject is shot on a flat green (or blue) screen, and this
 * turns that colour transparent with soft edges and removes the colour spill left on the subject.
 */
export type KeyColor = 'green' | 'blue';

const channel = (key: KeyColor) => (key === 'green' ? 1 : 2);

/** How much more of the key colour a pixel has than the other two channels. */
function dominance(r: number, g: number, b: number, key: KeyColor): number {
  return key === 'green' ? g - Math.max(r, b) : b - Math.max(r, g);
}

/**
 * Edits RGBA bytes in place. Pixels whose key colour dominance is below `low` are kept, above `high`
 * become fully transparent, and the band between fades smoothly.
 */
export function keyImageData(data: Uint8ClampedArray, key: KeyColor = 'green', low = 24, high = 96): void {
  const k = channel(key);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const dom = dominance(r, g, b, key);
    if (dom <= low) continue;
    const a = dom >= high ? 0 : 1 - (dom - low) / (high - low);
    data[i + 3] = Math.round(data[i + 3] * a);
    if (a > 0) {
      // spill suppression: cap the key channel at the strongest other channel
      const other = key === 'green' ? Math.max(r, b) : Math.max(r, g);
      data[i + k] = Math.min(data[i + k], other);
    }
  }
}

/** Looks at the four corners of a frame to see which key colour (if any) the background is. */
export function detectKey(data: Uint8ClampedArray, width: number, height: number): KeyColor | null {
  const px = (x: number, y: number) => {
    const o = (y * width + x) * 4;
    return [data[o], data[o + 1], data[o + 2]] as const;
  };
  const sample = [px(1, 1), px(width - 2, 1), px(1, height - 2), px(width - 2, height - 2)];
  const avg = [0, 1, 2].map((c) => sample.reduce((s, p) => s + p[c], 0) / 4);
  const g = dominance(avg[0], avg[1], avg[2], 'green');
  const b = dominance(avg[0], avg[1], avg[2], 'blue');
  if (g > 40 && g >= b) return 'green';
  if (b > 40) return 'blue';
  return null;
}

/** Chooses the screen colour the subject uses least, from its average colour. */
export function pickKeyColor(avgR: number, avgG: number, avgB: number): KeyColor {
  return avgG - Math.max(avgR, avgB) > 25 ? 'blue' : 'green';
}

export const KEY_HEX: Record<KeyColor, string> = { green: '#00ff00', blue: '#0000ff' };
