import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    environment: 'node',
    // Discovery and SSE tests bind real sockets on loopback; keep them serial
    // so port reuse and multicast group membership stay predictable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
