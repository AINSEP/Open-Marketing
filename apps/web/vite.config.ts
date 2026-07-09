import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Lightweight dev server that runs ALONGSIDE Next.js (next dev --turbopack on 5273), sharing
// the same src/ tree. Next is kept for `next build`. Use this
// for day-to-day dev to avoid Next's heavy dev memory footprint.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5274,
    strictPort: true,
    proxy: {
      // src/lib/* fetches `/api/*` (NEXT_PUBLIC_DAEMON_URL is blanked to '' by the
      // process shim in index.html), so proxy those to the daemon — same-origin,
      // no CORS.
      '/api': {
        target: process.env.OD_DAEMON_URL || 'http://127.0.0.1:5288',
        changeOrigin: true,
      },
    },
  },
});
