import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // src/index.ts imports the workerd-only 'cloudflare:workers' module;
      // outside workerd it resolves to a tiny stub (tests never touch the DO).
      'cloudflare:workers': fileURLToPath(
        new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
});
