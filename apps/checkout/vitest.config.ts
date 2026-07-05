import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tests de componente en jsdom (sin navegador) — corren en CI. El E2E de
// navegador (Playwright) es `test:e2e`, local (el CI no tiene navegador).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
