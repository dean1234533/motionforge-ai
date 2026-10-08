import { expect, test } from '@playwright/test';

// Runs on a desktop browser and on an emulated phone.
test('the editing controls are split into tabs, one group per tab', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto('/#/editor');
  await page.evaluate(() => localStorage.removeItem('motionforge.tabs'));
  await page.reload();
  await page.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });

  const left = page.getByRole('tablist', { name: 'Editing tools' });
  const right = page.getByRole('tablist', { name: 'Property sections' });
  await expect(left.getByRole('tab')).toHaveText(['Media', 'Add', 'Layers']);
  await expect(right.getByRole('tab')).toHaveText(['Layer', 'Look', 'Timing', 'Path', 'Scroll']);

  // Left: each group lives in its own tab and the others are not shown
  const leftTab = (name: string) => left.getByRole('tab', { name, exact: true });
  await expect(leftTab('Media')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Upload image' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add effect' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Layers' })).toHaveCount(0);

  await leftTab('Add').click();
  await expect(leftTab('Add')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Add effect' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add shape' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload image' })).toHaveCount(0);

  await leftTab('Layers').click();
  await expect(page.getByRole('heading', { name: 'Layers' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Duplicate sample-bird/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add effect' })).toHaveCount(0);

  // Right: Layer / Look / Timing / Path / Scroll each show only their own controls
  const rightTab = (name: string) => right.getByRole('tab', { name, exact: true });
  const shows = async (tab: string, visible: string[], hidden: string[]) => {
    await rightTab(tab).click();
    await expect(rightTab(tab)).toHaveAttribute('aria-selected', 'true');
    for (const t of visible) await expect(page.getByText(t, { exact: false }).first(), `${tab} should show ${t}`).toBeVisible();
    for (const t of hidden) await expect(page.getByText(t, { exact: true }), `${tab} should not show ${t}`).toHaveCount(0);
  };
  await shows('Layer', ['Name', 'Size (% of width)', 'Wing flaps per scroll'], ['Easing', 'Add point', 'Scroll length (px)']);
  await shows('Look', ['Rotation (°)', 'Scale', 'Opacity', 'Blur (px)'], ['Name', 'Easing', 'Add point']);
  await shows('Timing', ['Starts at (% of scroll)', 'Easing', 'Follow another layer', 'Pin to the viewport'], ['Name', 'Rotation (°)', 'Add point']);
  await shows('Path', ['Motion path', 'Add point'], ['Name', 'Easing', 'Scroll length (px)']);
  await shows('Scroll', ['Scroll length (px)', 'Smoothing', 'Reverse when scrolling up'], ['Name', 'Easing', 'Add point']);

  // the controls inside a tab still work
  await rightTab('Timing').click();
  await page.getByLabel('Follow another layer').selectOption('');
  await rightTab('Scroll').click();
  const mono = page.locator('.timeline .mono');
  await expect(mono).toBeVisible();
});

test('tabs work from the keyboard, remember the choice, and a path handle opens the Path tab', async ({ page }) => {
  await page.goto('/#/editor');
  await page.evaluate(() => localStorage.removeItem('motionforge.tabs'));
  await page.reload();
  await page.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });

  const right = page.getByRole('tablist', { name: 'Property sections' });
  const layerTab = right.getByRole('tab', { name: 'Layer', exact: true });
  await layerTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(right.getByRole('tab', { name: 'Look', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(right.getByRole('tab', { name: 'Look', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(right.getByRole('tab', { name: 'Scroll', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight'); // wraps round to the first tab
  await expect(layerTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  // only the selected tab is in the tab order
  await expect(right.getByRole('tab', { name: 'Layer', exact: true })).toHaveAttribute('tabindex', '-1');

  // touching a path handle on the preview jumps to the Path tab
  await right.getByRole('tab', { name: 'Look', exact: true }).click();
  await page.getByRole('button', { name: /^Path point 1 of/ }).click({ force: true });
  await expect(right.getByRole('tab', { name: 'Path', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Motion path')).toBeVisible();

  // the choice is remembered on reload
  await page.reload();
  await expect(page.getByRole('tablist', { name: 'Property sections' }).getByRole('tab', { name: 'Path', exact: true })).toHaveAttribute('aria-selected', 'true');
});
