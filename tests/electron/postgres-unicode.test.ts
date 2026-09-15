import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { EmbeddedPostgresController } from '../../electron-client/embedded-postgres'
import { findFreePort } from '../../electron-client/local-port'

it.skipIf(process.platform !== 'win32')('initializes through a Chinese installation path and retains data across a new controller', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-unicode-pg-'))
  const original = path.resolve('_client-postgres')
  const install = path.join(root, '新建文件夹 (4)')
  fs.symlinkSync(original, install, 'junction')
  const options = { runtimeRoot: path.join(install, 'pgsql'), stateRoot: path.join(root, 'state'), findFreePort,
    protectSecret: (value: string) => Buffer.from(value), unprotectSecret: (value: Buffer) => value.toString() }
  let controller = new EmbeddedPostgresController(options)
  let pool: Pool | undefined
  try {
    pool = new Pool({ connectionString: (await controller.start()).url })
    await pool.query('CREATE TABLE unicode_probe (value text)')
    await pool.query('INSERT INTO unicode_probe VALUES ($1)', ['中文存档'])
    await pool.end(); pool = undefined
    await controller.stop()
    controller = new EmbeddedPostgresController(options)
    pool = new Pool({ connectionString: (await controller.start()).url })
    expect((await pool.query('SELECT value FROM unicode_probe')).rows).toEqual([{ value: '中文存档' }])
  } finally {
    await pool?.end()
    await controller.stop()
    // Remove only this test's junctions, never their targets.
    for (const name of fs.existsSync(options.stateRoot) ? fs.readdirSync(options.stateRoot) : []) {
      const item = path.join(options.stateRoot, name)
      if (fs.lstatSync(item).isSymbolicLink()) fs.unlinkSync(item)
    }
    fs.unlinkSync(install)
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unsafe test cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
