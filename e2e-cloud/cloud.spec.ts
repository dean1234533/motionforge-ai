import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function birdPng(page: Page): Promise<Buffer> {
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
  return Buffer.from(b64, 'base64');
}

async function visiblePixels(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 64) if (d[i] > 40) n++;
    return n;
  });
}

test('account -> project -> upload -> autosave -> reload -> share -> settings -> billing', async ({ page, browser }) => {
  page.on('pageerror', (e) => console.log('[page error]', e.message, e.stack));
  // The server has Cloudflare AI bound, so describing a movement is a (confirmed) paid job. When the AI cannot be
  // reached, as it cannot from a test machine, the server falls back to the rule-based planner.
  page.on('dialog', (d) => void d.accept());
  const email = `e2e-${Date.now()}@example.com`;

  // sign up
  await page.goto('/#/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(page.getByText('20 credits')).toBeVisible();

  // new project
  await page.getByRole('link', { name: 'Create your first animation' }).click();
  await page.getByLabel('Project name').fill('E2E bird');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('link', { name: '← Projects' })).toBeVisible();

  // upload + describe
  const png = await birdPng(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'bird.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('Motion frames created', { exact: false })).toBeVisible({ timeout: 60_000 });
  await page.locator('#prompt').fill('Make this bird flap its wings and fly along a curved path from the bottom-left to the top-right as the user scrolls.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Planned a curved path', { exact: false })).toBeVisible({ timeout: 30_000 });
  // wait for the server to confirm the save of the planned path (not just for the "Saved" label)
  await page.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/projects\/[0-9a-f-]{36}$/.test(r.url()) && r.request().postData()?.includes('"progress":0.25') === true, { timeout: 15_000 });

  // every mode can be chosen; ones this server has not set up explain why instead of being greyed out
  const mode = page.locator('select[aria-label="Generation mode"]');
  await mode.selectOption('fast');
  await expect(page.getByText('Fast is not set up on this server yet.')).toBeVisible();
  await page.locator('#prompt').fill('make it fly');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Fast is not set up on this server yet.').first()).toBeVisible();
  await mode.selectOption('byok'); // bring-your-own-key needs no server setup
  await expect(page.getByText('not available on this server')).toHaveCount(0);
  await mode.selectOption('free');
  await page.locator('#prompt').fill('');

  // reload: everything comes back from the server
  await page.reload();
  await expect(page.getByRole('button', { name: /^bird/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Path point 3 of 5/ })).toBeVisible();

  // share, then view anonymously in a fresh browser context
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: 'Create a link' }).click();
  const link = await page.locator('.modal-card span.grow').first().getAttribute('title');
  expect(link).toContain('#/share/');
  const anon = await browser.newContext();
  const viewer = await anon.newPage();
  await viewer.goto(link!);
  await viewer.waitForSelector('canvas', { timeout: 60_000 });
  await viewer.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.5));
  await viewer.waitForTimeout(1800);
  expect(await visiblePixels(viewer)).toBeGreaterThan(0);
  // the anonymous viewer cannot reach account data
  const status = await viewer.evaluate(async () => (await fetch('/api/projects')).status);
  expect(status).toBe(401);

  // revoke
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Link turned off.')).toBeVisible();
  await viewer.reload();
  await expect(viewer.getByText('This link is no longer available.')).toBeVisible();
  await anon.close();
  await page.getByRole('button', { name: 'Close' }).click();

  // settings: save a key, it is never shown back
  await page.goto('/#/settings');
  await page.getByLabel('API key').first().fill('r8_fake_key_for_testing_5678');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Saved key ending in 5678')).toBeVisible();
  expect(await page.content()).not.toContain('r8_fake_key_for_testing');
  await page.getByRole('button', { name: 'Remove' }).first().click().catch(() => undefined);
  page.once('dialog', (d) => void d.accept());

  // billing is honest when Stripe is not configured
  await page.goto('/#/billing');
  await expect(page.getByText('Paid plans are not enabled on this server yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose Creator' })).toBeDisabled();

  // dashboard lists the project; log out blocks access
  await page.goto('/#/dashboard');
  await expect(page.getByText('E2E bird')).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.goto('/#/dashboard');
  await expect(page).toHaveURL(/#\/login/);
});
