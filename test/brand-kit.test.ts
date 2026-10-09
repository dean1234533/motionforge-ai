import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { brandGuideHtml, buildBrandKitZip, colourText, extractPalette, kitSlug, toCmyk } from '../src/studio/brandKit';

/** RGBA pixels: `n` of each colour, in order. */
function pixels(...runs: [number[], number][]): Uint8ClampedArray {
  const out: number[] = [];
  for (const [rgba, n] of runs) for (let i = 0; i < n; i++) out.push(...(rgba.length === 3 ? [...rgba, 255] : rgba));
  return new Uint8ClampedArray(out);
}

describe('brand kit colours', () => {
  it('finds the main colours, most used first, ignoring the backdrop and transparency', () => {
    const data = pixels([[255, 255, 255], 500], [[0, 0, 0, 0], 300], [[20, 90, 200], 300], [[250, 200, 30], 150], [[22, 92, 198], 50]);
    const palette = extractPalette(data, { background: [255, 255, 255] });
    expect(palette.map((s) => s.hex)).toEqual(['#145AC8', '#FAC81E']);
    expect(palette[0].share).toBeCloseTo(350 / 500, 2);
    expect(palette[0].rgb).toEqual([20, 90, 200]);
  });

  it('merges near-identical shades and drops specks under 1%', () => {
    const data = pixels([[200, 30, 40], 500], [[210, 35, 45], 400], [[0, 200, 0], 5], [[10, 10, 10], 95]);
    const palette = extractPalette(data);
    expect(palette).toHaveLength(2);
    expect(palette[0].hex).toBe('#CC202A'); // weighted average of both shades
    expect(palette.find((s) => s.hex === '#00C800')).toBeUndefined();
  });

  it('caps the number of swatches and copes with an empty image', () => {
    const many = pixels(...Array.from({ length: 10 }, (_, i) => [[i * 25, 255 - i * 25, (i * 70) % 255], 10] as [number[], number]));
    expect(extractPalette(many, { max: 4 })).toHaveLength(4);
    expect(extractPalette(pixels([[0, 0, 0, 0], 20]))).toEqual([]);
  });

  it('ignores the blended edge between the logo and its backdrop', () => {
    // A 6x6 image: white backdrop, a 4x4 red square whose outer ring is a pink anti-aliased edge.
    const W = [255, 255, 255];
    const rows: number[][][] = [
      [W, W, W, W, W, W],
      [W, [240, 150, 150], [240, 150, 150], [240, 150, 150], [240, 150, 150], W],
      [W, [240, 150, 150], [220, 20, 30], [220, 20, 30], [240, 150, 150], W],
      [W, [240, 150, 150], [220, 20, 30], [220, 20, 30], [240, 150, 150], W],
      [W, [240, 150, 150], [240, 150, 150], [240, 150, 150], [240, 150, 150], W],
      [W, W, W, W, W, W],
    ];
    const data = pixels(...rows.flat().map((c) => [c, 1] as [number[], number]));
    expect(extractPalette(data, { background: W }).map((s) => s.hex)).toEqual(['#F09696', '#DC141E']);
    expect(extractPalette(data, { background: W, width: 6 }).map((s) => s.hex)).toEqual(['#DC141E']);
  });

  it('converts to CMYK for print', () => {
    expect(toCmyk([0, 0, 0])).toEqual([0, 0, 0, 100]);
    expect(toCmyk([255, 255, 255])).toEqual([0, 0, 0, 0]);
    expect(toCmyk([255, 0, 0])).toEqual([0, 100, 100, 0]);
  });
});

describe('brand kit files', () => {
  const palette = extractPalette(pixels([[20, 90, 200], 10]));

  it('escapes the brand name in the guide', () => {
    const html = brandGuideHtml('<b>Gabby\'s</b> & Co', palette, { png: 'a.png', transparent: 't.png' });
    expect(html).toContain('&#60;b&#62;Gabby&#39;s&#60;/b&#62; &#38; Co');
    expect(html).not.toContain('<b>Gabby');
    expect(html).toContain('#145AC8');
    expect(html).not.toContain('.svg');
  });

  it('lists the colours as text', () => {
    expect(colourText('Aqua Vibe', palette)).toContain('1. #145AC8   RGB 20, 90, 200   CMYK 90, 55, 0, 22');
  });

  it('puts every file in one folder named after the brand', () => {
    const zip = buildBrandKitZip({
      brand: 'Aqua Vibe!',
      png: new Uint8Array([1]),
      pngExt: 'jpg',
      transparentPng: new Uint8Array([2]),
      colourSheetPng: new Uint8Array([3]),
      palette,
      svg: new TextEncoder().encode('<svg/>'),
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      'aqua-vibe-brand-kit/aqua-vibe-logo-transparent.png',
      'aqua-vibe-brand-kit/aqua-vibe-logo.jpg',
      'aqua-vibe-brand-kit/aqua-vibe-logo.svg',
      'aqua-vibe-brand-kit/brand-guide.html',
      'aqua-vibe-brand-kit/colour-sheet.png',
      'aqua-vibe-brand-kit/colours.txt',
    ]);
    expect(strFromU8(files['aqua-vibe-brand-kit/brand-guide.html'])).toContain('src="aqua-vibe-logo.jpg"');
    expect(strFromU8(files['aqua-vibe-brand-kit/aqua-vibe-logo.svg'])).toBe('<svg/>');
    expect(kitSlug('!!!')).toBe('brand');
  });
});
