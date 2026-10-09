import { defineConfig, devices } from '@playwright/test';

// Runs the real Worker (API + D1 + R2 + static front-end) locally through wrangler, using the same
// wrangler.jsonc that gets deployed. The Worker creates its own tables on the first request.
// The real app admits only its owner; these tests sign up several accounts, so OWNER_EMAIL lets anyone in.
const SECRET = Buffer.alloc(32, 7).toString('base64');

export default defineConfig({
  testDir: 'e2e-cloud',
  timeout: 180_000,
  retries: 0,
  use: { baseURL: 'http://localhost:8787', viewport: { width: 1280, height: 800 }, actionTimeout: 20_000, navigationTimeout: 30_000 },
  webServer: {
    command: `npx wrangler dev --local --port 8787 --var KEY_ENCRYPTION_SECRET:${SECRET} --var ALLOWED_ORIGIN:http://localhost:8787 --var 'OWNER_EMAIL:*'`,
    url: 'http://localhost:8787/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 5'] }, testMatch: /mobile\.spec/ },
  ],
});
