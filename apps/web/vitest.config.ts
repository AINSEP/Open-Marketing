import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'motion/react',
        replacement: resolve(__dirname, 'tests/helpers/motion-mock.tsx'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup/jsdom-lexical.ts'],
    server: {
      deps: {
        // Inline workspace + CopilotKit packages so Vite transforms them (and
        // their `.css` / CSS-module imports) instead of Node's loader, which
        // throws "Cannot find module ./x.css" on an externalized `.css`.
        // `@open-design/web` consumes `@open-design/components` from source, so
        // inlining here matches the dev/transpile boundary.
        inline: [/@open-design\//, /@copilotkit\//],
      },
    },
  },
});
