import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 10_000,
    globalSetup: ['test/global-setup.ts'],
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
