import { defineConfig } from 'vitest/config';

// Tests never touch AWS or a real model. The recorded provider and local doubles
// keep the suite deterministic and free, which is what lets CI run it every push.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Phase 0 ships before the first test. Keep CI green until Phase 1 adds them.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'eval/score.ts'],
    },
  },
});
