import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom supplies localStorage for the indexer-identity / relay-discovery
    // modules; crypto.subtle comes from the Node runtime (see setup).
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
