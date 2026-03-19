import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/brokers/**', 'src/lib/market-data/**', 'src/lib/tools.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
