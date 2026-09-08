import { it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { saveConfig, loadConfig } from '@/lib/server/official/windows-config'
import { findFreePort } from '../../electron-client/local-port'
import { acquireOfficialProcessLock } from '@/lib/server/official/process-lock'

it.skipIf(process.platform !== 'win32' || !fs.existsSync(path.resolve('dist/official-server/win-x64/server.mjs')))('boots the actual Windows package; encrypts local secrets; concurrent stale-lock recovery permits one server; admin leaves PG alive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-package-'))
  const built = path.resolve('dist/official-server/win-x64'), port = await findFreePort(38952)
  expect(fs.existsSync(path.join(built, 'node.exe'))).toBe(true)
  const file = path.join(root, 'official-config.json'), password = 'local-test-only-not-real-mail'
  saveConfig(file, { port, maxMatches: 2, smtp: { host: 'smtp.example.test', port: 465, user: 'test@example.test', from: 'test@example.test', password } })
  expect(fs.readFileSync(file, 'utf8')).not.toContain(password)
  expect(loadConfig(file)!.smtp.password).toBe(password)
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true })
  fs.writeFileSync(path.join(root, 'official.lock'), JSON.stringify({ pid: Number(dead.stdout.trim()), owner: 'exited-fixture' }))
  const env = { ...process.env, RVB_OFFICIAL_STATE_ROOT: root, RVB_OFFICIAL_NO_BROWSER: '1' }
  // IPC only belongs to this harness; the shipped server file is executed unchanged.
  const hook = "data:text/javascript,process.on('message',()=>{process.emit('SIGINT');process.channel?.unref()})"
  const processes: ChildProcess[] = [], exits: Promise<number | null>[] = [], logs: string[] = ['', '']
  const launch = (index: number) => {
    const child = spawn(path.join(built, 'node.exe'), ['--import', hook, path.join(built, 'server.mjs')], { cwd: built, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    processes.push(child); exits.push(once(child, 'exit').then(([code]) => code))
    child.stdout!.on('data', data => { logs[index] += data }); child.stderr!.on('data', data => { logs[index] += data })
    return child
  }
  launch(0); launch(1)
  try {
    await expect(Promise.race(exits)).resolves.toBe(1)
    const deadline = Date.now() + 60000
    let ready = false
    while (Date.now() < deadline) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/official/info`)).ok } catch {}
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    expect(ready, logs.join('\n')).toBe(true)
    const before = fs.readFileSync(path.join(root, 'official.lock'), 'utf8')
    const admin = spawn(path.join(built, 'node.exe'), [path.join(built, 'server.mjs'), '--admin', 'maintenance', 'on'], { cwd: built, env, windowsHide: true, stdio: 'pipe' })
    let adminLog = ''
    admin.stdout!.on('data', data => { adminLog += data }); admin.stderr!.on('data', data => { adminLog += data })
    expect((await once(admin, 'exit'))[0], adminLog).toBe(0)
    expect(fs.readFileSync(path.join(root, 'official.lock'), 'utf8')).toBe(before)
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true)
  } finally {
    for (const child of processes) if (child.exitCode === null && child.connected) child.send('stop')
    const codes = await Promise.all(exits)
    expect(codes.sort()).toEqual([0,1])
    expect(logs.join('\n')).toContain('Bundled PostgreSQL stopped')
    fs.writeFileSync(path.resolve('dist/multiplayer-qa/red196-package-startup.txt'), logs.join('\n--- isolated processes ---\n'))
  }
  expect(fs.existsSync(path.join(root, 'official.lock'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'postgres/data/postmaster.pid'))).toBe(false)
}, 100000)

it('never removes another active process lock or a crash recovery gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-official-lock-'))
  const release = acquireOfficialProcessLock(root)
  expect(() => acquireOfficialProcessLock(root)).toThrow('已经运行')
  release()
  fs.writeFileSync(path.join(root, 'official-start.lock'), 'crashed owner')
  expect(() => acquireOfficialProcessLock(root)).toThrow('official-start.lock')
  expect(fs.readFileSync(path.join(root, 'official-start.lock'), 'utf8')).toBe('crashed owner')
})
