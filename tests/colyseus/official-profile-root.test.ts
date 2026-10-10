import fs from 'node:fs'
import path from 'node:path'

import { expect, it } from 'vitest'

const launcher = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/run-official-server.mjs'), 'utf8')

it('leaves the active profile root to the runtime after setting app and state roots', () => {
  expect(launcher).toContain('process.env.APP_ROOT_DIR = root')
  expect(launcher).toContain('process.env.USER_DATA_DIR = stateRoot')
  expect(launcher).not.toMatch(/(?:process\.env\.RVB_PROFILE_ROOT\s*=|delete\s+process\.env\.RVB_PROFILE_ROOT)/)
})
