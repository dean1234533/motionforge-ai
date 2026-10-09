import { detectKey, keyImageData } from './chromaKey';
import type { KeyColor } from './chromaKey';
import { FRAME_COUNT, encodeCanvas, localBackgroundRemover } from './imagePipeline';

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.onerror = () => reject(new Error('The generated video could not be read.'));
    video.currentTime = t;
  });
}

/** Browser-recorded videos report an infinite length until you seek far past the end. */
async function lengthOf(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener('durationchange', done);
      resolve();
    };
    video.addEventListener('durationchange', done);
    video.currentTime = 1e101;
    setTimeout(done, 3000);
  });
  const d = video.duration;
  video.currentTime = 0;
  return d;
}

/**
 * Turns a generated video into transparent frames: sample evenly, key out the screen colour
 * (or fall back to edge flood-fill for a plain background), then crop every frame to the same
 * box so the subject does not jitter.
 *
 * `key` is the screen colour the subject was shot against; 'auto' works it out from the first frame.
 */
export async function extractFrames(url: string, count = FRAME_COUNT, maxSide = 512, key: KeyColor | 'auto' = 'auto'): Promise<string[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('The generated video could not be loaded.'));
  });
  const duration = await lengthOf(video);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The generated video has no length.');

  const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * k));
  const h = Math.max(1, Math.round(video.videoHeight * k));
  const frames: HTMLCanvasElement[] = [];
  let mode: KeyColor | 'flood' | null = key === 'auto' ? null : key;
  for (let i = 0; i < count; i++) {
    await seek(video, Math.min(duration - 0.05, (duration * i) / count));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    if (mode === null) {
      mode = detectKey(ctx.getImageData(0, 0, w, h).data, w, h) ?? 'flood';
    }
    if (mode === 'flood') {
      await localBackgroundRemover.remove(c);
    } else {
      const img = ctx.getImageData(0, 0, w, h);
      keyImageData(img.data, mode);
      ctx.putImageData(img, 0, 0);
    }
    frames.push(c);
  }

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (const c of frames) {
    const { data } = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
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
  }
  if (x1 < 0) throw new Error('No subject was found in the generated video.');
  if (x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2) {
    throw new Error('The generated subject reaches the edge of the video and may be clipped. Generate again with more room around its full movement.');
  }
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const encoded = frames.map((c) => {
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d')!.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    return encodeCanvas(out);
  });
  if (count > 1 && new Set(encoded).size === 1) throw new Error('The provider returned a still image instead of an action. Generate the motion again.');
  return encoded;
}
