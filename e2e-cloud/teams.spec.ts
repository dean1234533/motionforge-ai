import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function signup(page: Page, email: string) {
  await page.goto('/#/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
}

test('teams: owner invites a viewer, the viewer gets a read-only team project', async ({ browser }) => {
  const stamp = Date.now();
  const ownerEmail = `owner-${stamp}@example.com`;
  const viewerEmail = `viewer-${stamp}@example.com`;

  const owner = await (await browser.newContext()).newPage();
  owner.on('pageerror', (e) => console.log('[owner page error]', e.message));
  await signup(owner, ownerEmail);

  await owner.goto('/#/teams');
  await owner.getByLabel('Team name').fill('Studio');
  await owner.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.getByRole('button', { name: 'Hide' })).toBeVisible();

  // invite a viewer by link
  await owner.getByLabel('Email address').fill(viewerEmail);
  await owner.getByLabel('Role', { exact: true }).selectOption('viewer');
  await owner.getByRole('button', { name: 'Create invitation link' }).click();
  const invite = owner.locator('.list .asset span.grow').first();
  await expect(invite).toContainText(viewerEmail);
  const link = await invite.getAttribute('title');
  expect(link).toContain('#/invite/');

  // the viewer signs up with that email and accepts
  const viewer = await (await browser.newContext()).newPage();
  viewer.on('pageerror', (e) => console.log('[viewer page error]', e.message));
  await signup(viewer, viewerEmail);
  await viewer.goto(link!);
  await expect(viewer.getByText('Studio')).toBeVisible();
  await viewer.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(viewer).toHaveURL(/#\/teams/);
  await expect(viewer.getByText('you are an viewer', { exact: false }).or(viewer.getByText('viewer', { exact: false })).first()).toBeVisible();

  // the owner makes a team project with an image in it
  await owner.goto('/#/new');
  await owner.getByLabel('Project name').fill('Team bird');
  await owner.getByLabel('Who can open it').selectOption({ label: 'Team: Studio' });
  await owner.getByRole('button', { name: 'Create project' }).click();
  await expect(owner.getByRole('link', { name: '← Projects' })).toBeVisible();
  await owner.getByRole('button', { name: 'Use sample bird' }).click();
  await expect(owner.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(owner.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible({ timeout: 15_000 });

  // the viewer sees it on their dashboard and can open it, but only to look
  await viewer.goto('/#/dashboard');
  await expect(viewer.getByText('Team bird')).toBeVisible();
  await expect(viewer.getByText('Team: Studio')).toBeVisible();
  await viewer.getByRole('link', { name: 'Open' }).click();
  await expect(viewer.getByText('view-only access', { exact: false })).toBeVisible({ timeout: 30_000 });
  // view-only people can still switch tabs and look, but not edit
  await expect(viewer.getByRole('tab', { name: 'Layers', exact: true })).toBeEnabled({ timeout: 60_000 });
  await viewer.getByRole('tab', { name: 'Layers', exact: true }).click();
  await expect(viewer.getByRole('button', { name: /^sample-bird/ })).toBeVisible({ timeout: 60_000 });
  await viewer.getByRole('tab', { name: 'Media', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Upload image' })).toBeDisabled();
  await expect(viewer.locator('#prompt')).toBeDisabled();

  // the server has Cloudflare AI bound, so the owner can create images from a description
  await expect(owner.getByText('Describe an image')).toBeVisible();
});
