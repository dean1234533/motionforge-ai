import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PROMPT = 'Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right as the user scrolls.';

/** Count visible pixels across every canvas under `selector` (WebGL canvases are read back through a 2D canvas). */
async function paint(page: Page, selector: string) {
  return page.evaluate((sel) => {
    let total = 0;
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`${sel} canvas`));
    for (const c of canvases) {
      if (!c.width || !c.height) continue;
      const t = document.createElement('canvas');
      t.width = c.width;
      t.height = c.height;
      const x = t.getContext('2d')!;
      x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 30) total++;
    }
    return { total, canvases: canvases.length };
  }, selector);
}

async function scrollFraction(page: Page, selector: string, f: number) {
  await page.evaluate(
    ([sel, frac]) => {
      const host = document.querySelector(sel as string)!;
      const track = host.firstElementChild as HTMLElement;
      const stage = track.firstElementChild as HTMLElement;
      const top = track.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + (track.offsetHeight - stage.offsetHeight) * (frac as number));
    },
    [selector, f] as const,
  );
  await page.waitForTimeout(1800);
}

test('renderers: WebGL for heavy particle scenes, canvas fallback, both draw and both reverse exactly', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/docs');

  const result = await page.evaluate(() => {
    const MF = window.MotionForge;
    const obj = (extra: Record<string, unknown>) => ({
      id: 'x', name: 'X', kind: 'image', assetId: 'none', widthPct: 22, flapsPerScroll: 0,
      path: [{ progress: 0, x: 20, y: 60 }, { progress: 1, x: 80, y: 40 }],
      rotation: [0], scale: [1], opacity: [1], blur: [0], followPath: false, bob: 0, bobCycles: 3, easing: 'linear',
      pinned: false, start: 0, end: 1, mobileScale: 0.7, parallax: 0, attachTo: null, offsetX: 0, offsetY: 0, ...extra,
    });
    const fire = obj({ id: 'fire', kind: 'effect', effect: { type: 'fire', count: 400, size: 40, color: '#ffb02e', spread: 8, rise: 25, loops: 6, seed: 7, layer: 'front' } });
    const scene = { scene: { width: 1440, height: 900, background: 'transparent' }, objects: [fire], scroll: { length: 1200, scrub: true, reverse: true, smoothing: 0.05 } };
    const make = (id: string, renderer: 'auto' | 'canvas2d') => {
      const host = document.createElement('div');
      host.id = id;
      document.body.appendChild(host);
      const ctl = MF.mount(host, { scene, assets: {} }, { stageHeight: '600px', renderer });
      return ctl.info().effects;
    };
    return { auto: make('host-auto', 'auto'), forced: make('host-2d', 'canvas2d') };
  });

  expect(result.forced).toBe('canvas2d');
  console.log('renderer chosen for 400 particles:', result.auto);

  for (const host of ['#host-auto', '#host-2d']) {
    await scrollFraction(page, host, 0.5);
    const mid = await paint(page, host);
    expect(mid.total, `${host} should draw particles`).toBeGreaterThan(40);
    await scrollFraction(page, host, 0.9);
    const late = await paint(page, host);
    expect(late.total).toBeGreaterThan(40);
    await scrollFraction(page, host, 0.5);
    const back = await paint(page, host);
    // scrolling back to the same spot draws the same picture
    expect(Math.abs(back.total - mid.total) / mid.total).toBeLessThan(0.02);
  }
});

test('add fire to the bird, export it, and the exported page draws and reverses the particles', async ({ page, context }, testInfo) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/editor');
  await page.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await page.locator('#prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Planned a curved path', { exact: false })).toBeVisible({ timeout: 30_000 });

  // the chat command adds fire that follows the bird
  await page.locator('#prompt').fill('Add fire behind it.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Added fire.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Fire', exact: true }).click();
  await expect(page.getByLabel('Follow another layer')).not.toHaveValue('');
  await page.getByLabel('Particles').fill('300');

  // add parallax scenery through the properties panel as well
  await page.getByLabel('Parallax (depth drift)').fill('1');

  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByRole('button', { name: 'Download standalone HTML' }).click()]);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);

  const exported = await context.newPage();
  const external: string[] = [];
  exported.on('request', (r) => {
    if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) external.push(r.url());
  });
  exported.on('pageerror', (e) => console.log('[exported page error]', e.message));
  await exported.goto(`file://${file}`);
  await exported.waitForSelector('canvas', { timeout: 20_000 });
  await exported.waitForTimeout(800);

  const stage = '#motionforge-1';
  await scrollFraction(exported, stage, 0.5);
  const mid = await paint(exported, stage);
  console.log('exported page canvases:', mid.canvases, '(3 = WebGL particle layers active)');
  expect(mid.total).toBeGreaterThan(100);
  await scrollFraction(exported, stage, 0.85);
  await scrollFraction(exported, stage, 0.5);
  const back = await paint(exported, stage);
  expect(Math.abs(back.total - mid.total) / mid.total).toBeLessThan(0.03);
  expect(external).toEqual([]);
});
