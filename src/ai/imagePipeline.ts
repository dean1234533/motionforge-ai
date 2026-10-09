import { KEY_HEX, pickKeyColor } from './chromaKey';
import type { KeyColor } from './chromaKey';
import type { BackgroundRemover, MotionFrameGenerator } from './providers';

export type Stage =
  | 'Analysing prompt'
  | 'Preparing image'
  | 'Removing background'
  | 'Generating motion'
  | 'Generating image'
  | 'Upscaling'
  | 'Processing frames'
  | 'Optimising assets'
  | 'Building preview'
  | 'Complete';

export const MAX_SIDE = 512;
export const FRAME_COUNT = 24;

const yieldUI = () => new Promise<void>((r) => setTimeout(r, 16));

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('That file could not be read.'));
    fr.readAsDataURL(file);
  });
}

function toCanvas(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const w0 = img.naturalWidth || img.width || 1;
  const h0 = img.naturalHeight || img.height || 1;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function hasTransparency(data: ImageData): boolean {
  const { width: w, height: h, data: d } = data;
  const check = (x: number, y: number) => d[(y * w + x) * 4 + 3] < 250;
  for (let x = 0; x < w; x++) if (check(x, 0) || check(x, h - 1)) return true;
  for (let y = 0; y < h; y++) if (check(0, y) || check(w - 1, y)) return true;
  return false;
}

/** Free-tier background removal: flood-fill from the edges using the corner colour. */
export const localBackgroundRemover: BackgroundRemover = {
  id: 'local-floodfill',
  async remove(source) {
    const ctx = source.getContext('2d')!;
    const img = ctx.getImageData(0, 0, source.width, source.height);
    if (hasTransparency(img)) return { canvas: source, changed: false };
    const { width: w, height: h, data: d } = img;
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
    const bg = [0, 1, 2].map((c) => corners.reduce((s, o) => s + d[o + c], 0) / 4);
    const tol = 42;
    const near = (i: number) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) < tol;
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    const push = (x: number, y: number) => {
      const p = y * w + x;
      if (seen[p] || !near(p * 4)) return;
      seen[p] = 1;
      queue[tail++] = p;
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p / w) | 0;
      d[p * 4 + 3] = 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: source, changed: true };
  },
};

function trim(c: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = c.getContext('2d')!;
  const { width: w, height: h, data } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('No visible subject was found in that image.');
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Free-tier motion: bends each pixel column up/down in proportion to its distance from the
 * vertical centre line, which reads as wings beating. One full cycle over `count` frames.
 */
export const localMotionFrames: MotionFrameGenerator = {
  id: 'local-wing-warp',
  async generate(base, count) {
    const w = base.width;
    const h = base.height;
    const pad = Math.ceil(h * 0.35);
    const frames: HTMLCanvasElement[] = [];
    for (let k = 0; k < count; k++) {
      const flap = Math.sin((2 * Math.PI * k) / count);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h + pad * 2;
      const ctx = c.getContext('2d')!;
      for (let x = 0; x < w; x++) {
        const nx = (x + 0.5 - w / 2) / (w / 2);
        const weight = Math.pow(Math.abs(nx), 1.5);
        const dh = h * (1 - 0.12 * weight * Math.abs(flap));
        const top = pad + (h - dh) / 2 - flap * weight * h * 0.3;
        ctx.drawImage(base, x, 0, 1, h, x, top, 1, dh);
      }
      frames.push(c);
    }
    return frames;
  },
};

export interface BuiltAsset {
  frames: string[];
  backgroundRemoved: boolean;
  bytes: number;
}

/** Prepare an intact still. Subject actions need image-to-video, not a generic image warp. */
export async function buildAsset(source: string, onStage: (s: Stage) => void, maxSide = MAX_SIDE, simulateWings = false): Promise<BuiltAsset> {
  onStage('Preparing image');
  const img = await loadImage(source);
  const raw = toCanvas(img, maxSide);
  await yieldUI();

  onStage('Removing background');
  const removed = await localBackgroundRemover.remove(raw);
  const base = trim(removed.canvas);
  await yieldUI();

  const canvases = simulateWings ? await localMotionFrames.generate(base, FRAME_COUNT) : [base];
  await yieldUI();

  onStage('Processing frames');
  const frames = canvases.map(encodeCanvas);
  await yieldUI();

  onStage('Optimising assets');
  const bytes = frames.reduce((s, f) => s + Math.round(f.length * 0.75), 0);
  await yieldUI();

  return { frames, backgroundRemoved: removed.changed, bytes };
}

export function encodeCanvas(c: HTMLCanvasElement): string {
  const webp = c.toDataURL('image/webp', 0.8);
  return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
}

/**
 * The subject on a flat key-colour screen, for image-to-video models that cannot make transparent video.
 * The colour is chosen so the subject does not use it.
 */
export async function chromaScreenBlob(source: string, maxSide = 768): Promise<{ blob: Blob; key: KeyColor }> {
  const img = await loadImage(source);
  const removed = await localBackgroundRemover.remove(toCanvas(img, maxSide));
  const base = trim(removed.canvas);
  const { data } = base.getContext('2d')!.getImageData(0, 0, base.width, base.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 128) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  const key = n ? pickKeyColor(r / n, g / n, b / n) : 'green';
  const pad = Math.round(Math.max(base.width, base.height) * 0.2);
  const c = document.createElement('canvas');
  c.width = base.width + pad * 2;
  c.height = base.height + pad * 2;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = KEY_HEX[key];
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(base, pad, pad);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not prepare the image for video generation.');
  return { blob, key };
}

const MAX_UPLOAD = 4.9 * 1024 * 1024;

/**
 * Every image is compressed before it is saved: WebP where the browser can make it (keeps transparency),
 * otherwise JPEG for opaque images and PNG only when transparency must be kept (Safari cannot encode
 * WebP). Images are at most 1600px on their long side, and are shrunk further if still over the limit.
 */
export async function toUploadBlob(source: string): Promise<Blob> {
  const img = await loadImage(source);
  let side = Math.min(1600, Math.max(img.naturalWidth, img.naturalHeight));
  for (let tries = 0; tries < 6; tries++, side = Math.round(side * 0.8)) {
    const k = side / Math.max(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const toBlob = (type: string, q?: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
    let blob = await toBlob("image/webp", 0.82);
    if (!blob || blob.type !== "image/webp") blob = hasTransparency(c.getContext("2d")!.getImageData(0, 0, c.width, c.height)) ? await toBlob("image/png") : await toBlob("image/jpeg", 0.82);
    if (blob && blob.size <= MAX_UPLOAD) return blob;
  }
  throw new Error("That image is too large to save. Try a smaller one.");
}
