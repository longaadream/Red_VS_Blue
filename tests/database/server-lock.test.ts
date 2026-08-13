import { createRequire } from 'module'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { acquireServerLock } = require('../../scripts/server-lock.js') as {
  acquireServerLock: (lockPath: string, owner: string) => { release: () => void }
}
const temporaryDirectories: string[] = []
const projectRoot = path.resolve(__dirname, '../..')

function createLockPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'rvb-red14-lock-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'server.lock')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('single game server lock', () => {
  it('rejects a second live server and permits a new server after release', () => {
    const lockPath = createLockPath()
    const first = acquireServerLock(lockPath, 'first-test-server')

    expect(() => acquireServerLock(lockPath, 'second-test-server')).toThrow(/already running/i)

    first.release()
    const next = acquireServerLock(lockPath, 'replacement-test-server')
    next.release()
  })

  it('recovers a valid lock whose owning process no longer exists', () => {
    const lockPath = createLockPath()
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-process-token',
      owner: 'crashed-test-server',
    }))

    const lock = acquireServerLock(lockPath, 'recovered-test-server')

    lock.release()
  })

  it('rejects a second server before it can initialize its database', () => {
    const lockPath = createLockPath()
    const databasePath = path.join(path.dirname(lockPath), 'must-not-exist.db')
    const first = acquireServerLock(lockPath, 'first-test-server')

    const second = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts', 'start-server.js'), 'dev'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          RVB_SERVER_LOCK_PATH: lockPath,
          DATABASE_URL: `file:${databasePath.replace(/\\/g, '/')}`,
        },
      },
    )

    expect(second.status).toBe(1)
    expect(second.stderr).toMatch(/already running/i)
    expect(existsSync(databasePath)).toBe(false)
    first.release()
  })
})
