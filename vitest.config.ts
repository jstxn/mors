import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 10_000,
    globalSetup: ['test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts', 'dist/**'],
      // Thresholds are intentionally not enforced yet; raise these as coverage
      // gaps (relay/server.ts, remote-watch.ts, contract/*) are closed.
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['test/**/*.test.ts'],
          exclude: ['test/install.test.ts', 'test/install-matrix.test.ts'],
        },
      },
      {
        // Install tests run build/prepare commands that rewrite dist/.
        // They must run with fileParallelism disabled so they don't
        // race with other CLI-integration tests that spawn node dist/index.js.
        extends: true,
        test: {
          name: 'install',
          include: ['test/install.test.ts', 'test/install-matrix.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
