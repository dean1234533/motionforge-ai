import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // `npx wrangler dev` serves the API on 8787 during development.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
