import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { OfficialBackups } from '@/lib/server/official/backup'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rvb-backup-'))
  await fs.mkdir(path.join(root, 'postgres/data'), { recursive: true })
  await fs.writeFile(path.join(root, 'postgres/credential.bin'), 'protected-local-credential')
  await fs.writeFile(path.join(root, 'postgres/data/PG_VERSION'), '16')
  await fs.writeFile(path.join(root, 'postgres/data/accounts'), 'original')
  return { root, backups: new OfficialBackups(root), accounts: path.join(root, 'postgres/data/accounts') }
}
describe('official local backup integrity and crash recovery', () => {
  it('copies the stopped cluster, verifies every byte, and refuses corrupted and traversal inputs', async () => {
    const { root, backups } = await fixture(), id = await backups.create()
    expect((await backups.list()).map(b => b.id)).toEqual([id])
    await backups.verify(id)
    await expect(backups.verify('../postgres')).rejects.toThrow('编号')
    await fs.writeFile(path.join(root, 'backups', id, 'postgres/data/accounts'), 'tampered')
    await expect(backups.stageRestore(id)).rejects.toThrow('校验失败')
    expect(await fs.readFile(path.join(root, 'postgres/data/accounts'), 'utf8')).toBe('original')
    await fs.writeFile(path.join(root, 'postgres/data/postmaster.pid'), '123')
    await expect(backups.create()).rejects.toThrow('正常停止')
  })
  it('rolls back an interrupted restore and retains the pre-restore data, then commits a verified restore', async () => {
    const { root, backups, accounts } = await fixture(), id = await backups.create()
    await fs.writeFile(accounts, 'new-account')
    await backups.stageRestore(id)
    expect(await fs.readFile(accounts, 'utf8')).toBe('original')
    expect(await new OfficialBackups(root).recoverInterruptedRestore()).toBe(true)
    expect(await fs.readFile(accounts, 'utf8')).toBe('new-account')
    await backups.stageRestore(id); await backups.commitRestore()
    expect(await backups.recoverInterruptedRestore()).toBe(false)
    expect(await fs.readFile(accounts, 'utf8')).toBe('original')
    expect((await fs.readdir(root)).some(name => name.startsWith('postgres.previous-'))).toBe(true)
  })
  it('preserves a crashed replacement with a stale PID but refuses to move a live process cluster', async () => {
    const { root, backups, accounts } = await fixture(), id = await backups.create()
    await fs.writeFile(accounts, 'before-restore'); await backups.stageRestore(id)
    const pid = path.join(root, 'postgres/data/postmaster.pid')
    await fs.writeFile(pid, String(process.pid))
    await expect(backups.recoverInterruptedRestore()).rejects.toThrow('仍在运行')
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true })
    expect(child.status).toBe(0)
    await fs.writeFile(pid, child.stdout.trim())
    expect(await backups.recoverInterruptedRestore()).toBe(true)
    expect(await fs.readFile(accounts, 'utf8')).toBe('before-restore')
    expect((await fs.readdir(root)).some(name => name.startsWith('postgres.failed-'))).toBe(true)
  })
})
