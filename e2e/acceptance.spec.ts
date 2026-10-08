import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PROMPT =
  'Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right as the user scrolls.';

async function pose(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const { width: w, height: h } = c;
    const d = c.getContext('2d')!.getImageData(0, 0, w, h).data;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        if (d[(y * w + x) * 4 + 3] > 40) {
          n++;
          sx += x;
          sy += y;
        }
      }
    }
    return { n, x: n ? sx / n / w : -1, y: n ? sy / n / h : -1, cornerAlpha: d[3] };
  });
}

async function scrollTo(page: Page, f: number) {
  await page.evaluate((frac) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo(0, max * frac);
  }, f);
  await page.waitForTimeout(1800);
}

test('upload -> prompt -> edit path -> export -> exported file works without the editor', async ({ page, context }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log('[browser error]', m.text()); });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/editor');

  // 1. upload a transparent PNG bird
  const b64 = await page.evaluate(async () => {
    const img = new Image();
    img.src = 'sample-bird.svg';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 600;
    c.height = 360;
    c.getContext('2d')!.drawImage(img, 0, 0, 600, 360);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bird.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });

  // 2-4. prompt, plan, preview
  await page.locator('#prompt').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Planned a curved path', { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('iframe[title="Scroll animation preview"]')).toBeVisible();

  // 5. edit the path
  const handle = page.getByRole('button', { name: /^Path point 3 of 5/ });
  await handle.focus();
  const xField = page.getByLabel('X %');
  const before = Number(await xField.inputValue());
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => Number(await xField.inputValue())).toBe(before + 5);

  // 7. export
  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.getByRole('button', { name: 'Download standalone HTML' }).click(),
  ]);
  const file = await download.path();

  // 8. open the exported file on its own (file://, no dev server, no editor)
  const exported = await context.newPage();
  const external: string[] = [];
  exported.on('request', (r) => {
    if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) external.push(r.url());
  });
  await exported.goto(`file://${file}`);
  await exported.waitForSelector('canvas', { timeout: 20_000 });
  await exported.waitForTimeout(800);

  const a = await (async () => { await scrollTo(exported, 0.25); return pose(exported); })();
  const b = await (async () => { await scrollTo(exported, 0.5); return pose(exported); })();
  const c = await (async () => { await scrollTo(exported, 0.75); return pose(exported); })();
  expect(a.n).toBeGreaterThan(0);
  expect(b.n).toBeGreaterThan(0);
  expect(c.n).toBeGreaterThan(0);
  // flies bottom-left -> top-right
  expect(b.x).toBeGreaterThan(a.x);
  expect(c.x).toBeGreaterThan(b.x);
  expect(b.y).toBeLessThan(a.y);
  expect(c.y).toBeLessThan(b.y);
  // transparent background
  expect(b.cornerAlpha).toBe(0);

  // scrolling back up reverses the flight
  await scrollTo(exported, 0.25);
  const back = await pose(exported);
  expect(Math.abs(back.x - a.x)).toBeLessThan(0.03);
  expect(Math.abs(back.y - a.y)).toBeLessThan(0.03);

  expect(external).toEqual([]);
});
