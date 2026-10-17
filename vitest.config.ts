import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
