import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PROMPT = 'Move this image along a curved path from the bottom-left to the top-right as the user scrolls.';

async function fitsWidth(page: Page, what: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${what} scrolls sideways (${sw}px wide on a ${iw}px screen)`).toBeLessThanOrEqual(iw + 1);
}

/** Visible controls that are too small to tap comfortably. */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, select, a.btn, input[type=text], input[type=number], input[type=password]'))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none' || el.closest('[hidden]')) continue;
      if (el.classList.contains('sr-only') || el.closest('.sr-only')) continue;
      if (r.height < 36 || r.width < 32) bad.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad;
  });
}

test('public pages fit a phone screen', async ({ page }) => {
  for (const path of ['/', '/#/docs', '/#/login', '/#/signup', '/#/editor']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    await fitsWidth(page, path);
  }
});

test('landing page: headline, create button and FAQ are usable on a phone', async ({ page }) => {
  await page.goto('/');
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  const box = (await h1.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByRole('link', { name: 'Create an animation', exact: true })).toBeVisible();
  const faq = page.locator('summary').filter({ hasText: 'Do I need to write code?' });
  await faq.scrollIntoViewIfNeeded();
  await faq.tap();
  await expect(page.getByText('No. Upload an image, describe the motion', { exact: false })).toBeVisible();
  await fitsWidth(page, 'expanded FAQ');
  expect(await smallTargets(page)).toEqual([]);
});

test('editor on a phone: preview first, prompt always reachable, whole flow works, export fits', async ({ page, context }, testInfo) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/editor');
  const viewport = page.viewportSize()!;

  // empty state
  const sample = page.getByRole('button', { name: 'Try the sample bird' });
  await expect(sample).toBeVisible();
  await fitsWidth(page, 'empty editor');

  await page.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await fitsWidth(page, 'editor with an image');

  // the preview is the first thing on screen, and big enough to use
  const frame = (await page.locator('.frame iframe').boundingBox())!;
  expect(frame.width).toBeLessThanOrEqual(viewport.width);
  expect(frame.height).toBeGreaterThan(280);
  expect(frame.y).toBeLessThan(viewport.height * 0.6);

  // the prompt bar stays on screen even after scrolling down to the panels
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const prompt = (await page.locator('#prompt').boundingBox())!;
  expect(prompt.y + prompt.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(prompt.y).toBeGreaterThan(0);

  // describe the movement by tapping and typing
  await page.locator('#prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).tap();
  await expect(page.getByText('Planned a curved path', { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, 0));

  // path handles are big enough to grab with a finger
  const handle = (await page.getByRole('button', { name: /^Path point 1 of/ }).boundingBox())!;
  expect(handle.width).toBeGreaterThanOrEqual(36);

  // timeline works by touch
  await page.getByLabel('Scroll position').fill('500');
  await expect.poll(async () => (await page.locator('.timeline .mono').textContent()) ?? '').toMatch(/[1-9]\d?%/);

  // the properties panel is reachable below and fits
  await page.getByRole('heading', { name: 'Properties' }).scrollIntoViewIfNeeded();
  await fitsWidth(page, 'properties panel');
  const small = await smallTargets(page);
  expect(small, `controls too small to tap:\n${small.join('\n')}`).toEqual([]);

  // export fits and downloads
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Export' }).tap();
  await expect(page.getByRole('button', { name: 'Download standalone HTML' })).toBeVisible();
  await fitsWidth(page, 'export screen');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByRole('button', { name: 'Download standalone HTML' }).tap()]);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);

  // the exported file works on the phone too, and draws the bird smaller than on a desktop
  const exported = await context.newPage();
  await exported.goto(`file://${file}`);
  await exported.waitForSelector('canvas', { timeout: 20_000 });
  await fitsWidth(exported, 'exported page');
  await exported.evaluate(() => {
    const track = document.querySelector('.mf-track') as HTMLElement;
    const stage = track.firstElementChild as HTMLElement;
    window.scrollTo(0, (track.offsetHeight - stage.offsetHeight) * 0.5);
  });
  await exported.waitForTimeout(1800);
  const bird = await exported.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let minX = c.width;
    let maxX = -1;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (d[(y * c.width + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    return { width: maxX - minX, canvasWidth: c.width };
  });
  expect(bird.width).toBeGreaterThan(10);
  expect(bird.width / bird.canvasWidth).toBeLessThan(0.18); // 22% on desktop, scaled down to 70% on a phone
});
