import { expect, test } from '@playwright/test';
import { findObscured } from './helpers/obscured';

// Runs on a desktop browser and on an emulated phone (see the two projects in playwright.config.ts).
test('every button, link and tab on the public pages can be clicked', async ({ page }) => {
  for (const path of ['/', '/#/docs', '/#/login', '/#/signup', '/#/editor']) {
    await page.goto(path);
    await page.waitForTimeout(700);
    expect(await findObscured(page), `covered controls on ${path}`).toEqual([]);
  }
});

test('in the editor, the device tabs, mode menu and toolbar respond to clicks', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/editor');
  await page.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  expect(await findObscured(page), 'covered controls in the editor').toEqual([]);

  // the Desktop / Tablet / Mobile tabs really change the preview
  const frame = page.locator('.frame');
  for (const [name, expected] of [['Tablet', 768], ['Mobile', 390]] as const) {
    const tab = page.getByRole('button', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-pressed', 'true');
    const w = (await frame.boundingBox())!.width;
    expect(w, `${name} preview width`).toBeLessThanOrEqual(expected + 1);
  }
  await page.getByRole('button', { name: 'Desktop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Desktop', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // other toolbar actions respond
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('button', { name: 'Download standalone HTML' })).toBeVisible();
  expect(await findObscured(page), 'covered controls on the export screen').toEqual([]);
  await page.getByRole('button', { name: '← Back to editor' }).click();
  await expect(page.getByRole('button', { name: 'Use sample bird' })).toBeVisible();
});
