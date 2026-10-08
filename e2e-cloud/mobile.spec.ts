import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function fitsWidth(page: Page, what: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${what} scrolls sideways (${sw}px wide on a ${iw}px screen)`).toBeLessThanOrEqual(iw + 1);
}

test('account pages and the cloud editor fit and work on a phone', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  page.on('dialog', (d) => void d.accept());
  const email = `phone-${Date.now()}@example.com`;

  await page.goto('/#/signup');
  await fitsWidth(page, 'sign-up');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign up' }).tap();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await fitsWidth(page, 'dashboard');

  for (const [path, heading] of [
    ['/#/settings', 'AI providers'],
    ['/#/billing', 'Billing and credits'],
    ['/#/teams', 'Teams'],
    ['/#/new', 'New project'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await page.waitForTimeout(300);
    await fitsWidth(page, path);
  }

  await page.getByLabel('Project name').fill('Phone bird');
  await page.getByRole('button', { name: 'Create project' }).tap();
  await expect(page.getByRole('link', { name: '← Projects' })).toBeVisible();
  await fitsWidth(page, 'new editor');
  await page.getByRole('button', { name: 'Use sample bird' }).tap();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 15_000 });
  await fitsWidth(page, 'cloud editor with an image');

  // the share dialog fits and works by touch
  await page.getByRole('button', { name: 'Share' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Share this animation' });
  await expect(dialog).toBeVisible();
  const box = (await dialog.locator('.modal-card').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog.getByRole('button', { name: 'Create a link' }).tap();
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await fitsWidth(page, 'share dialog');
});
