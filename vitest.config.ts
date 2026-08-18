import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{ts,js}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      hono: path.resolve(__dirname, 'tests/support/hono.ts'),
    },
  },
})
