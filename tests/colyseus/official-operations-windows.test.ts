import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { saveConfig, unprotectWindowsSecret } from '@/lib/server/official/windows-config'
import { findFreePort } from '../../electron-client/local-port'

it.skipIf(process.platform !== 'win32')('keeps restored credentials off the network until commit, and serializes abort plus shutdown with backup', async () => {
  const built = path.resolve('dist/official-server', process.env.RVB_OFFICIAL_BUILD_VARIANT || 'win-x64')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-ops-package-')), port = await findFreePort(38985)
  saveConfig(path.join(root, 'official-config.json'), { port, maxMatches: 2, smtp: { host: 'smtp.example.test', port: 465, user: 'a@example.test', from: 'a@example.test', password: 'isolated-test-password' } })
  // Instrument only this isolated process's filesystem boundaries; the shipped bundle is unchanged.
  const hook = `import fs from 'node:fs/promises';
    let blockCopy=false,copyRelease,commitRelease;const cp=fs.cp,unlink=fs.unlink;
    fs.cp=async(...args)=>{if(blockCopy&&String(args[1]).replaceAll(String.fromCharCode(92),'/').endsWith('.partial/postgres')){blockCopy=false;process.send('copy-pending');await new Promise(r=>copyRelease=r)}return cp(...args)};
    fs.unlink=async(...args)=>{if(String(args[0]).endsWith('restore-intent.json')){process.send('commit-pending');await new Promise(r=>commitRelease=r)}return unlink(...args)};
    process.channel?.unref();process.on('message',message=>{if(message==='block-copy')blockCopy=true;if(message==='release-copy')copyRelease?.();if(message==='release-commit')commitRelease?.();if(message==='stop')process.emit('SIGINT')});`
  const child = spawn(path.join(built, 'node.exe'), ['--import', 'data:text/javascript,' + encodeURIComponent(hook), path.join(built, 'server.mjs')], { cwd: built, env: { ...process.env, RVB_OFFICIAL_STATE_ROOT: root, RVB_OFFICIAL_NO_BROWSER: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit'); let log = ''
  child.stdout!.on('data', b => { log += b }); child.stderr!.on('data', b => { log += b })
  const messages = new Set<string>(); child.on('message', m => { messages.add(String(m)) })
  async function until(test: () => boolean | Promise<boolean>, label: string) { const end = Date.now() + 60000; while (Date.now() < end) { if (await test()) return; if (child.exitCode !== null) throw new Error(label + ': process exited\n' + log); await new Promise(r => setTimeout(r, 100)) } throw new Error('timeout ' + label + '\n' + log) }
  async function query(sql: string, values?: unknown[]) {
    const pid = fs.readFileSync(path.join(root, 'postgres/data/postmaster.pid'), 'utf8').split(/\r?\n/)
    const pool = new Pool({ host: '127.0.0.1', port: Number(pid[3]), database: 'rvb_colyseus', user: 'rvb', password: unprotectWindowsSecret(fs.readFileSync(path.join(root, 'postgres/credential.bin'))) })
    try { return await pool.query(sql, values) } finally { await pool.end() }
  }
  try {
    await until(() => fs.existsSync(path.join(root, 'panel-url.protected')), 'panel startup')
    const panel = new URL(unprotectWindowsSecret(fs.readFileSync(path.join(root, 'panel-url.protected'))))
    const headers = { Authorization: 'Bearer ' + panel.hash.slice(1), Origin: panel.origin, 'Content-Type': 'application/json' }
    async function action(name: string, value = '') {
      const response = await fetch(panel.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ action: name, value, reason: '隔离故障演练' }) })
      expect(response.status, await response.text()).toBe(200)
    }
    await action('maintenance', 'on')
    const token = 'isolated-restored-session', hash = createHash('sha256').update(token).digest('hex')
    await query("INSERT INTO official_accounts(id,email,name,password_hash) VALUES('restore-account','restore@example.test','恢复前账号','fixture')")
    await query("INSERT INTO official_sessions(token_hash,account_id) VALUES($1,'restore-account')", [hash])
    expect((await fetch(`http://127.0.0.1:${port}/official/me`, { headers: { Authorization: 'Bearer ' + token } })).status).toBe(200)
    await action('backup-create')
    const config = await fetch(panel.origin + '/api/config', { headers }).then(r => r.json()), id = config.backups[0].id
    await query("INSERT INTO official_accounts(id,email,name,password_hash) VALUES('after-backup','after@example.test','新增账号','fixture')")
    const restore = action('backup-restore', id)
    await until(() => messages.has('commit-pending'), 'restore precommit barrier')
    await expect(fetch(`http://127.0.0.1:${port}/official/me`, { headers: { Authorization: 'Bearer ' + token } })).rejects.toThrow()
    expect((await query('SELECT count(*)::int n FROM official_sessions')).rows[0].n).toBe(0)
    expect((await query('SELECT maintenance FROM official_settings')).rows[0].maintenance).toBe(true)
    child.send('release-commit'); await restore
    expect((await fetch(`http://127.0.0.1:${port}/official/me`, { headers: { Authorization: 'Bearer ' + token } })).status).toBe(401)
    expect((await query('SELECT count(*)::int n FROM official_accounts')).rows[0].n).toBe(1)
    child.send('block-copy')
    const controller = new AbortController()
    const copying = fetch(panel.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ action: 'backup-create', reason: '中断演练' }), signal: controller.signal }).catch(() => undefined)
    await until(() => messages.has('copy-pending'), 'backup copy barrier')
    controller.abort(); await copying; child.send('stop')
    await new Promise(r => setTimeout(r, 100)); expect(child.exitCode).toBeNull()
    child.send('release-copy')
    expect((await exited)[0], log).toBe(0)
    expect(fs.existsSync(path.join(root, 'postgres/data/postmaster.pid'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'panel-url.protected'))).toBe(false)
    await expect(fetch(`http://127.0.0.1:${port}/official/info`)).rejects.toThrow()
  } finally {
    if (child.exitCode === null && child.connected) { child.send('release-copy'); child.send('release-commit'); child.send('stop'); await exited }
    fs.writeFileSync(path.resolve('dist/multiplayer-qa/red196-ops-fault-startup.txt'), log)
  }
}, 180000)
