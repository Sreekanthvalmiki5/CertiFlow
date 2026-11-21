import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/env.ts'],
    // Integration tests share one Postgres + Redis, so run files one at a time.
    fileParallelism: false,
    // Child processes instead of worker threads: Prisma's native query engine
    // can crash worker threads on teardown ("Worker exited unexpectedly").
    pool: 'forks',
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
