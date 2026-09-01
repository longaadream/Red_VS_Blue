import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EmbeddedPostgresController } from '../../../electron-client/embedded-postgres'
import { findFreePort } from '../../../electron-client/local-port'

const projectRoot = path.resolve(__dirname, '../../..')
const runtimeRoot = path.join(projectRoot, '_client-postgres', 'pgsql')
const canRunEmbedded = process.platform === 'win32'
  && fs.existsSync(path.join(runtimeRoot, 'bin', 'postgres.exe'))

describe.skipIf(!canRunEmbedded)('RED-161 bundled PostgreSQL battle authority', () => {
  it('passes the full PostgreSQL journal, recovery, deduplication, and terminal barrier integration', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-embedded-authority-pg-'))
    const controller = new EmbeddedPostgresController({
      runtimeRoot,
      stateRoot,
      findFreePort,
      portHint: 38721,
      protectSecret: plaintext => Buffer.from(plaintext, 'utf8'),
      unprotectSecret: encrypted => encrypted.toString('utf8'),
    })
    try {
      const connection = await controller.start()
      const result = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d', '/s', '/c',
            'npx.cmd vitest run tests/integration/postgres/postgres-authority.integration.test.ts --reporter=verbose',
          ], {
            cwd: projectRoot,
            env: { ...process.env, RVB_TEST_POSTGRES_URL: connection.url },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60_000,
          })
        : spawnSync('npx', [
            'vitest', 'run',
            'tests/integration/postgres/postgres-authority.integration.test.ts',
            '--reporter=verbose',
          ], {
        cwd: projectRoot,
        env: { ...process.env, RVB_TEST_POSTGRES_URL: connection.url },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
          })
      expect(
        result.status,
        `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      ).toBe(0)
      expect(result.stdout).toContain('1 passed')
    } finally {
      await controller.stop()
      fs.rmSync(stateRoot, { recursive: true, force: true })
    }
  }, 90_000)
})
