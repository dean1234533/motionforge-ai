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

/**
 * Turns a generated video into transparent frames: sample evenly, knock out the plain background
 * of each frame, then crop every frame to the same box so the subject does not jitter.
 */
export async function extractFrames(url: string, count = FRAME_COUNT, maxSide = 512): Promise<string[]> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('The generated video could not be loaded.'));
  });
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The generated video has no length.');

  const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * k));
  const h = Math.max(1, Math.round(video.videoHeight * k));
  const frames: HTMLCanvasElement[] = [];
  for (let i = 0; i < count; i++) {
    await seek(video, Math.min(duration - 0.05, (duration * i) / count));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(video, 0, 0, w, h);
    await localBackgroundRemover.remove(c);
    frames.push(c);
  }

  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (const c of frames) {
    const { data } = c.getContext('2d')!.getImageData(0, 0, w, h);
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
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  return frames.map((c) => {
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d')!.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
    return encodeCanvas(out);
  });
}
