import { strToU8, zipSync } from 'fflate';
import { loadImage, localBackgroundRemover, toCanvas, trim } from '../ai/imagePipeline';

/**
 * Brand kit: everything a client needs from a finished logo, in one ZIP. The original PNG, a
 * transparent PNG, the vector SVG when there is one, a colour sheet (image and text) and a printable
 * brand guide. All of it is built in the browser from the design itself.
 */

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  cmyk: [number, number, number, number];
  /** Share of the logo's visible pixels, 0 to 1. */
  share: number;
}

const toHex = (rgb: readonly number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** Print approximation; a printer's colour profile will differ slightly. */
export function toCmyk([r, g, b]: readonly number[]): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k >= 1) return [0, 0, 0, 100];
  const c = (1 - r / 255 - k) / (1 - k);
  const m = (1 - g / 255 - k) / (1 - k);
  const y = (1 - b / 255 - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 100)) as [number, number, number, number];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The logo's main colours, most used first. Transparent pixels, and pixels close to `background`
 * (the plain backdrop most generated logos sit on), are not counted. With `width`, neither are edge pixels
 * touching them: anti-aliasing blends the logo into its backdrop there, which would add muddy in-between
 * colours. Near-identical shades are merged, and colours covering less than 1% of the logo are left out.
 */
export function extractPalette(data: Uint8ClampedArray | Uint8Array, opts: { background?: readonly number[]; max?: number; width?: number } = {}): Swatch[] {
  const max = opts.max ?? 6;
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  const outside = (i: number) => data[i + 3] < 128 || (opts.background !== undefined && dist([data[i], data[i + 1], data[i + 2]], opts.background) < 40);
  const w = opts.width;
  const h = w ? data.length / 4 / w : 0;
  const onEdge = (i: number) => {
    if (!w) return false;
    const p = i / 4;
    const x = p % w;
    const y = (p - x) / w;
    return (x > 0 && outside(i - 4)) || (x < w - 1 && outside(i + 4)) || (y > 0 && outside(i - w * 4)) || (y < h - 1 && outside(i + w * 4));
  };
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (outside(i) || onEdge(i)) continue;
    const px = [data[i], data[i + 1], data[i + 2]];
    total++;
    // 5 bits per channel: close enough to tell brand colours apart, coarse enough to group anti-aliasing.
    const key = ((px[0] >> 3) << 10) | ((px[1] >> 3) << 5) | (px[2] >> 3);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += px[0];
    bucket.g += px[1];
    bucket.b += px[2];
    bucket.n++;
    buckets.set(key, bucket);
  }
  if (!total) return [];

  // Merge each bucket into the nearest stronger colour, so gradients and edges do not become extra swatches.
  const groups: { rgb: number[]; r: number; g: number; b: number; n: number }[] = [];
  for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
    const near = groups.find((g) => dist(g.rgb, rgb) < 48);
    if (near) {
      near.r += b.r;
      near.g += b.g;
      near.b += b.b;
      near.n += b.n;
    } else {
      groups.push({ rgb, r: b.r, g: b.g, b: b.b, n: b.n });
    }
  }
  return groups
    .filter((g) => g.n / total >= 0.01)
    .sort((x, y) => y.n - x.n)
    .slice(0, max)
    .map((g) => {
      const rgb = [Math.round(g.r / g.n), Math.round(g.g / g.n), Math.round(g.b / g.n)] as [number, number, number];
      return { hex: toHex(rgb), rgb, cmyk: toCmyk(rgb), share: Math.round((g.n / total) * 1000) / 1000 };
    });
}

export function colourText(brand: string, palette: Swatch[]): string {
  const lines = [`${brand} brand colours`, '', ...palette.map((s, i) => `${i + 1}. ${s.hex}   RGB ${s.rgb.join(', ')}   CMYK ${s.cmyk.join(', ')}   (${Math.round(s.share * 100)}% of the logo)`)];
  lines.push('', 'CMYK values are a print approximation. Ask the printer to match the HEX value for exact results.');
  return `${lines.join('\n')}\n`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A printable one-page guide that sits next to the files in the kit and refers to them by name. */
export function brandGuideHtml(brand: string, palette: Swatch[], files: { png: string; transparent: string; svg?: string }): string {
  const name = esc(brand);
  const swatches = palette
    .map((s) => `<li><span style="background:${s.hex}"></span><b>${s.hex}</b><small>RGB ${s.rgb.join(', ')}<br>CMYK ${s.cmyk.join(', ')}</small></li>`)
    .join('');
  const fileRows = [
    `<li><b>${esc(files.png)}</b>: the logo as designed, for presentations and the web.</li>`,
    `<li><b>${esc(files.transparent)}</b>: transparent background, for placing on photos and coloured backgrounds.</li>`,
    files.svg ? `<li><b>${esc(files.svg)}</b>: vector file. Scales to any size: signage, vehicle wraps, embroidery, print.</li>` : '',
    '<li><b>colour-sheet.png</b> and <b>colours.txt</b>: the brand colours with HEX, RGB and CMYK values.</li>',
  ].join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} brand guide</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;color:#1d2230;max-width:820px;margin:0 auto;padding:32px 20px}
h1{margin:0 0 4px}h2{margin-top:36px;border-bottom:1px solid #e3e6ee;padding-bottom:6px}
.logos{display:grid;grid-template-columns:1fr 1fr;gap:16px}.logos figure{margin:0;padding:24px;border:1px solid #e3e6ee;border-radius:12px;text-align:center}
.logos img{max-width:100%;max-height:220px}.dark{background:#1d2230;color:#fff}
ul.swatches{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
.swatches li{border:1px solid #e3e6ee;border-radius:12px;overflow:hidden}.swatches span{display:block;height:90px}
.swatches b,.swatches small{display:block;padding:0 12px}.swatches b{padding-top:8px}.swatches small{padding-bottom:10px;color:#5b6275}
@media print{body{padding:0}}
</style></head><body>
<h1>${name}</h1><p>Brand guide</p>
<h2>Logo</h2>
<div class="logos"><figure><img src="${esc(files.png)}" alt="${name} logo"><figcaption>Primary</figcaption></figure>
<figure class="dark"><img src="${esc(files.transparent)}" alt="${name} logo on a dark background"><figcaption>On dark backgrounds</figcaption></figure></div>
<h2>Colours</h2><ul class="swatches">${swatches}</ul>
<h2>Using the logo</h2>
<ul><li>Leave clear space around the logo of at least the height of its first letter.</li>
<li>Do not stretch, recolour, rotate or add effects to the logo.</li>
<li>Use the transparent version on photos and colours; check it stays easy to read.</li></ul>
<h2>Files in this kit</h2><ul>${fileRows}</ul>
</body></html>
`;
}

export interface KitFiles {
  brand: string;
  png: Uint8Array;
  pngExt: string;
  transparentPng: Uint8Array;
  colourSheetPng: Uint8Array;
  palette: Swatch[];
  svg?: Uint8Array;
}

export const kitSlug = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brand';

/** Everything in one folder inside the ZIP, so unzipping never scatters files. */
export function buildBrandKitZip(kit: KitFiles): Uint8Array {
  const slug = kitSlug(kit.brand);
  const dir = `${slug}-brand-kit`;
  const names = { png: `${slug}-logo.${kit.pngExt}`, transparent: `${slug}-logo-transparent.png`, svg: kit.svg ? `${slug}-logo.svg` : undefined };
  const files: Record<string, Uint8Array> = {
    [`${dir}/${names.png}`]: kit.png,
    [`${dir}/${names.transparent}`]: kit.transparentPng,
    [`${dir}/colour-sheet.png`]: kit.colourSheetPng,
    [`${dir}/colours.txt`]: strToU8(colourText(kit.brand, kit.palette)),
    [`${dir}/brand-guide.html`]: strToU8(brandGuideHtml(kit.brand, kit.palette, names)),
  };
  if (kit.svg && names.svg) files[`${dir}/${names.svg}`] = kit.svg;
  return zipSync(files);
}

// ---- browser-only pieces ---------------------------------------------------------------------

const canvasBytes = (c: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('The image could not be saved.'))), 'image/png'),
  );

/** The background colour a logo sits on: the average of its four corners, unless they are transparent. */
function cornerBackground(c: HTMLCanvasElement): number[] | undefined {
  const { width: w, height: h } = c;
  const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  if (corners.some((o) => d[o + 3] < 250)) return undefined;
  return [0, 1, 2].map((ch) => corners.reduce((s, o) => s + d[o + ch], 0) / 4);
}

/** Draws a printable swatch sheet: the logo, then each colour with its values. */
function drawColourSheet(brand: string, logo: HTMLCanvasElement, palette: Swatch[]): HTMLCanvasElement {
  const W = 1600;
  const cols = Math.max(1, Math.min(palette.length, 3));
  const rows = Math.ceil(palette.length / cols) || 1;
  const sw = (W - 120 - (cols - 1) * 40) / cols;
  const H = 520 + rows * 380;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d2230';
  ctx.font = '600 56px system-ui, sans-serif';
  ctx.fillText(brand, 60, 110);
  ctx.font = '32px system-ui, sans-serif';
  ctx.fillStyle = '#5b6275';
  ctx.fillText('Brand colours', 60, 160);
  const k = Math.min(1, 300 / logo.height, (W - 120) / logo.width);
  ctx.drawImage(logo, (W - logo.width * k) / 2, 190, logo.width * k, logo.height * k);
  palette.forEach((s, i) => {
    const x = 60 + (i % cols) * (sw + 40);
    const y = 540 + Math.floor(i / cols) * 380;
    ctx.fillStyle = s.hex;
    ctx.fillRect(x, y, sw, 200);
    ctx.strokeStyle = '#e3e6ee';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, sw, 200);
    ctx.fillStyle = '#1d2230';
    ctx.font = '600 38px system-ui, sans-serif';
    ctx.fillText(s.hex, x, y + 255);
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillStyle = '#5b6275';
    ctx.fillText(`RGB ${s.rgb.join(', ')}`, x, y + 300);
    ctx.fillText(`CMYK ${s.cmyk.join(', ')}`, x, y + 340);
  });
  return c;
}

/** Builds the kit from a design's image bytes (and its SVG, if one was made). */
export async function makeBrandKit(brand: string, image: Blob, svg?: Uint8Array): Promise<{ zip: Uint8Array; palette: Swatch[] }> {
  const url = URL.createObjectURL(image);
  try {
    const img = await loadImage(url);
    const full = toCanvas(img, 2048);
    const background = cornerBackground(full);

    const small = toCanvas(img, 256);
    const palette = extractPalette(small.getContext('2d')!.getImageData(0, 0, small.width, small.height).data, { background, width: small.width });

    const cutout = toCanvas(img, 2048);
    await localBackgroundRemover.remove(cutout);
    const transparent = trim(cutout);

    const zip = buildBrandKitZip({
      brand,
      png: new Uint8Array(await image.arrayBuffer()),
      pngExt: image.type === 'image/jpeg' ? 'jpg' : image.type === 'image/webp' ? 'webp' : 'png',
      transparentPng: await canvasBytes(transparent),
      colourSheetPng: await canvasBytes(drawColourSheet(brand, transparent, palette)),
      palette,
      svg,
    });
    return { zip, palette };
  } finally {
    URL.revokeObjectURL(url);
  }
}
