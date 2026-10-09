import { test, expect } from '@playwright/test';

test('project deletion requires confirmation, preserves failures and removes only the chosen project', async ({ page }) => {
  let deletes = 0;
  await page.route('**/api/me', route => route.fulfill({ json: { user: { id: 'owner', email: 'owner@example.com', plan: 'free' }, credits: 20 } }));
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: [
    { id: 'first', name: 'Bird flight', objects: 1, updatedAt: 1, teamId: null, teamName: null },
    { id: 'second', name: 'Robot dance', objects: 2, updatedAt: 1, teamId: null, teamName: null },
  ] } }));
  await page.route('**/api/projects/first', async route => {
    expect(route.request().method()).toBe('DELETE');
    deletes++;
    await route.fulfill(deletes === 1 ? { status: 500, json: { error: 'Please try again.' } } : { status: 204, body: '' });
  });
  await page.goto('/#/dashboard');
  await page.getByRole('button', { name: 'Delete Bird flight', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Bird flight');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(deletes).toBe(0);
  await page.getByRole('button', { name: 'Delete Bird flight', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Please try again.');
  await expect(page.getByRole('button', { name: 'Delete Bird flight', exact: true })).toBeAttached();
  await dialog.getByRole('button', { name: 'Delete project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Bird flight', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete Robot dance', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Deleted "Bird flight".');
});
