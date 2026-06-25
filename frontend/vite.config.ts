import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api/** is proxied to wrangler dev (the local Cloudflare Worker)
// at :8787. To exercise live data locally: `npm run dev:worker` in another
// terminal — `wrangler dev` serves the same handlers + cron triggers that
// run in production. Otherwise the proxy errors are caught and the board
// falls back to demo data, which is fine for pure UI work.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
