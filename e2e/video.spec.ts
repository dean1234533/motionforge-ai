import { expect, test } from '@playwright/test';

/**
 * Records a short real video in the browser (a red ball moving across a green screen), then runs it through
 * the same frame-extraction code that handles generated video, and checks the result is transparent video.
 */
test('a video shot on a green screen becomes transparent frames', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/docs');

  const out = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start(100);

    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const draw = (now: number) => {
        const t = Math.min(1, (now - t0) / 1500);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#d02020';
        ctx.beginPath();
        ctx.arc(60 + t * 200, 120, 36, 0, Math.PI * 2);
        ctx.fill();
        if (t < 1) requestAnimationFrame(draw);
        else resolve();
      };
      requestAnimationFrame(draw);
    });
    rec.stop();
    await stopped;

    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    const frames = await window.__mfTools!.extractFrames(url, 6, 320, 'green');
    const autoFrames = await window.__mfTools!.extractFrames(url, 3, 320, 'auto');

    const analyse = async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext('2d')!;
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let red = 0;
      let greenLeft = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 128) {
          opaque++;
          if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++;
          if (d[i + 1] > d[i] + 60 && d[i + 1] > d[i + 2] + 60) greenLeft++;
        }
      }
      return { w: c.width, h: c.height, opaque, red, greenLeft, cornerAlpha: d[3] };
    };
    return { frames: await Promise.all(frames.map(analyse)), auto: await Promise.all(autoFrames.map(analyse)) };
  });

  for (const set of [out.frames, out.auto]) {
    expect(set.length).toBeGreaterThan(0);
    for (const f of set) {
      expect(f.cornerAlpha).toBe(0); // the green screen is gone
      expect(f.red).toBeGreaterThan(500); // the ball is kept
      expect(f.greenLeft).toBeLessThan(f.opaque * 0.01); // no green fringe left on the subject
      expect(f.w).toBe(set[0].w); // every frame is cropped to the same box
      expect(f.h).toBe(set[0].h);
    }
  }
  // the ball moves, so the shared crop box is wider than the ball itself
  expect(out.frames[0].w).toBeGreaterThan(100);
});
