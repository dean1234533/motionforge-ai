import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const LOGO = readFileSync(new URL('../public/icons/icon-512.png', import.meta.url));
const STUDIO = '11111111-1111-4111-8111-111111111111';
const ANIM = '22222222-2222-4222-8222-222222222222';
const VECTOR_JOB = '44444444-4444-4444-8444-444444444444';

/** A signed-in account with Brand Studio set up, served entirely from mocks. */
async function mockApi(page: Page) {
  const seen = { vectors: [] as Record<string, unknown>[], jobs: [] as Record<string, unknown>[], created: [] as Record<string, unknown>[], uploads: [] as string[] };
  let designs: { id: string; name: string }[] = [];
  let animScene: unknown = null;
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (p === '/api/me') return json(route, { user: { id: 'u1', email: 'a@b.co', plan: 'professional' }, credits: 100 });
    if (p === '/api/modes') return json(route, { modes: [], balance: 100, tools: [{ kind: 'design', label: 'Brand design', cost: 6, provider: 'replicate:ideogram-ai/ideogram-v3-turbo', keyProvider: 'replicate', available: true, platformKey: true }, { kind: 'vectorize', label: 'Vector logo (SVG)', cost: 4, provider: 'replicate:recraft-ai/recraft-vectorize', keyProvider: 'replicate', available: true, platformKey: true }] });
    if (p === '/api/teams') return json(route, { teams: [] });
    if (p === '/api/projects' && m === 'GET') return json(route, { projects: [] });
    if (p === '/api/projects' && m === 'POST') {
      const body = req.postDataJSON();
      seen.created.push(body);
      if (body.name === 'Brand Studio') return json(route, { project: { id: STUDIO } }, 201);
      animScene = body.scene;
      return json(route, { project: { id: ANIM } }, 201);
    }
    if (p === '/api/jobs' && m === 'POST' && req.postDataJSON().kind === 'vectorize') {
      seen.vectors.push(req.postDataJSON());
      return json(route, { job: { id: VECTOR_JOB }, credits: 80 }, 202);
    }
    if (p === `/api/jobs/${VECTOR_JOB}`) return json(route, { job: { status: 'complete', error: null, result: { svgUrl: `/api/jobs/${VECTOR_JOB}/svg` } } });
    if (p === `/api/jobs/${VECTOR_JOB}/svg`) return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'content-disposition': 'attachment; filename="logo.svg"' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    if (p === '/api/jobs' && m === 'POST') {
      const body = req.postDataJSON();
      seen.jobs.push(body);
      const id = `3333333${seen.jobs.length}-3333-4333-8333-333333333333`;
      designs = [...designs, { id: `design-0000000${seen.jobs.length}`, name: `aqua-vibe-0000000${seen.jobs.length}.png` }];
      return json(route, { job: { id }, credits: 100 - 6 * seen.jobs.length }, 202);
    }
    if (p.startsWith('/api/jobs/')) return json(route, { job: { status: 'complete', error: null } });
    if (p === `/api/projects/${STUDIO}/assets`) return json(route, { assets: designs });
    if (p.startsWith(`/api/projects/${STUDIO}/assets/`)) return route.fulfill({ status: 200, contentType: 'image/png', body: LOGO });
    if (p === `/api/projects/${ANIM}/assets/logo` && m === 'PUT') {
      seen.uploads.push(url.searchParams.get('name') ?? '');
      return json(route, { ok: true }, 201);
    }
    if (p === `/api/projects/${ANIM}`) return json(route, { project: { id: ANIM, name: 'Aqua Vibe', scene: animScene, role: 'owner' } });
    if (p === `/api/projects/${ANIM}/assets`) return json(route, { assets: [{ id: 'logo', name: 'aqua-vibe.png', hasFrames: false, hd: false }] });
    if (p === `/api/projects/${ANIM}/assets/logo`) return route.fulfill({ status: 200, contentType: 'image/png', body: LOGO });
    return json(route, {});
  });
  return seen;
}

test('designs a logo, then opens it in the editor already animated', async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto('/#/studio');
  await expect(page.getByRole('heading', { name: 'Brand Studio' })).toBeVisible();

  await page.getByLabel('Brand name').fill('Aqua Vibe');
  await page.getByLabel('What the business does').fill('a beachwear shop');
  await page.getByLabel('Style').selectOption({ label: '3D mascot' });
  await page.getByText('See or edit the full design prompt').click();
  await expect(page.getByLabel('Design prompt')).toHaveValue(/"Aqua Vibe" is spelled exactly/);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Create 2 designs' }).click();
  await expect(page.locator('.brand-gallery li')).toHaveCount(2, { timeout: 15_000 });
  expect(seen.jobs).toHaveLength(2);
  expect(seen.jobs[0]).toMatchObject({ kind: 'design', aspect: 'square', transparent: true, title: 'Aqua Vibe', useOwnKey: false });
  expect(seen.jobs[0].idempotencyKey).not.toBe(seen.jobs[1].idempotencyKey);
  await page.screenshot({ path: 'test-results/studio.png', fullPage: true });
  await page.locator('.brand-gallery li').first().getByRole('button', { name: 'Animate' }).click();
  await page.screenshot({ path: 'test-results/studio-animate.png' });
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.locator('.brand-gallery li').first().getByRole('button', { name: 'Animate' }).click();
  await page.getByText('Spin in', { exact: true }).click();
  await page.getByRole('button', { name: 'Open in editor' }).click();
  await expect(page).toHaveURL(new RegExp(`#/editor/${ANIM}`));
  expect(seen.uploads).toHaveLength(1);
  const scene = seen.created.find((c) => c.name !== 'Brand Studio')!.scene as { objects: { assetId: string; rotation: number[]; opacity: number[] }[] };
  expect(scene.objects[0]).toMatchObject({ assetId: 'logo', rotation: [0, 360], opacity: [0.15, 1] });
});

test('switches to flyer fields and a portrait canvas', async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto('/#/studio');
  await page.getByRole('radio', { name: /Flyer \/ poster/ }).click();
  await page.getByLabel('Headline', { exact: true }).fill('Milestone Birthday');
  await page.getByLabel(/Details to print/).fill('Sat 14 June, 8pm');
  await page.getByLabel('How many variations').selectOption('1');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Create design' }).click();
  await expect(page.locator('.brand-gallery li')).toHaveCount(1, { timeout: 15_000 });
  expect(seen.jobs[0]).toMatchObject({ aspect: 'portrait', transparent: false });
  expect(seen.jobs[0].prompt).toContain('"Sat 14 June, 8pm"');
});

test('downloads a design as a vector SVG', async ({ page }) => {
  const seen = await mockApi(page);
  await page.goto('/#/studio');
  await page.getByLabel('Brand name').fill('Aqua Vibe');
  await page.getByLabel('How many variations').selectOption('1');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Create design' }).click();
  await expect(page.locator('.brand-gallery li')).toHaveCount(1, { timeout: 15_000 });

  page.once('dialog', (d) => void d.accept());
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /as a vector SVG/ }).click();
  expect((await download).suggestedFilename()).toBe('aqua-vibe-00000001.svg');
  expect(seen.vectors[0]).toMatchObject({ kind: 'vectorize', assetId: 'design-00000001', useOwnKey: false });
  await expect(page.getByRole('button', { name: /as a vector SVG/ })).toHaveText('Vector SVG');
});
