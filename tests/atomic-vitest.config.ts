import path from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../vitest.config'

const config = mergeConfig(baseConfig, defineConfig({
  root: path.resolve(__dirname, '..'),
  test: {
    setupFiles: [path.resolve(__dirname, 'support/atomic-migration.setup.ts')],
  },
}))

// Vitest merges array options, so replace the repository-wide include list
// after loading the shared config instead of accidentally running every suite.
if (config.test) config.test.include = ['tests/game/gameplay-module*.test.ts']

export default config
