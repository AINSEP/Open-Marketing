import { defineConfig } from 'vitest/config';

/** Boot-level tests seed every bundled Agent Plugin into a fresh state root and spawn real children; the 5 s default is too tight. */
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 60000 } });
