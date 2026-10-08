import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  // Shown in the app so you can tell which version of the code a deployed site is running.
  define: { __BUILD_ID__: JSON.stringify((process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || 'dev').slice(0, 7)) },
  build: { minify: process.env.MF_NO_MINIFY ? false : 'esbuild' },
  plugins: [react()],
  // `npx wrangler dev` serves the API on 8787 during development.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
