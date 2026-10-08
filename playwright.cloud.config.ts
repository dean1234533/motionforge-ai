import { defineConfig } from '@playwright/test';

// Runs the real Worker (API + D1 + R2 + static front-end) locally through wrangler.
const SECRET = Buffer.alloc(32, 7).toString('base64');

export default defineConfig({
  testDir: 'e2e-cloud',
  timeout: 180_000,
  retries: 0,
  use: { baseURL: 'http://localhost:8787', viewport: { width: 1280, height: 800 }, actionTimeout: 20_000, navigationTimeout: 30_000 },
  webServer: {
    command: `npx wrangler d1 migrations apply motionforge --local --config server/wrangler.jsonc && npx wrangler dev --local --port 8787 --config server/wrangler.jsonc --var KEY_ENCRYPTION_SECRET:${SECRET} --var ALLOWED_ORIGIN:http://localhost:8787 --var APP_URL:http://localhost:8787`,
    url: 'http://localhost:8787/api/health',
    timeout: 180_000,
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
