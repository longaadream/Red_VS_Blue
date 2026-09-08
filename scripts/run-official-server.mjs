import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { acquireOfficialProcessLock } from '../lib/server/official/process-lock.ts'
import { EmbeddedPostgresController } from '../electron-client/embedded-postgres.ts'
import { findFreePort } from '../electron-client/local-port.ts'
import { configureWindows, loadConfig, saveConfig, protectWindowsSecret, unprotectWindowsSecret } from '../lib/server/official/windows-config.ts'
import { createLiveMailer } from '../lib/server/official/live-mail.ts'
import { OfficialBackups } from '../lib/server/official/backup.ts'
import { OfficialError } from '../lib/server/official/accounts.ts'
import { startControlPanel } from '../lib/server/official/control-panel.ts'

const root = process.env.RVB_OFFICIAL_ROOT || (fs.existsSync(path.join(import.meta.dirname, 'data')) ? import.meta.dirname : path.resolve(import.meta.dirname, '..'))
const stateRoot = process.env.RVB_OFFICIAL_STATE_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Red-vs-Blue-Official')
fs.mkdirSync(stateRoot, { recursive: true })
const file = path.join(stateRoot, 'official-config.json')
const adminFile = path.join(stateRoot, 'admin-token.protected')
const panelFile = path.join(stateRoot, 'panel-url.protected')
const open = url => {
  if (process.env.RVB_OFFICIAL_NO_BROWSER === '1') return
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Microsoft.PowerShell.Management\\Start-Process -FilePath $env:RVB_OPEN_URL'], { env: { ...process.env, RVB_OPEN_URL: url }, windowsHide: true, stdio: 'ignore' })
  child.on('exit', code => { if (code) console.info('[official] 浏览器未能打开，请重新运行 Open-Control-Panel.cmd') })
  child.on('error', () => console.info('[official] 浏览器未能打开，请重新运行 Open-Control-Panel.cmd'))
}
const adminIndex = process.argv.indexOf('--admin')
if (process.argv.includes('--panel')) {
  try {
    const url = unprotectWindowsSecret(fs.readFileSync(panelFile)), parsed = new URL(url)
    if (parsed.hostname !== '127.0.0.1' || parsed.protocol !== 'http:' || parsed.pathname !== '/') throw new Error('Invalid local panel URL')
    const response = await fetch(new URL('/api/snapshot', parsed), { headers: { Authorization: `Bearer ${parsed.hash.slice(1)}` }, signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Panel unavailable')
    open(url)
    console.info('[official] 本机运营面板已请求打开')
  } catch { console.error('[official] 运营面板尚未启动，请先运行 Start-Official.cmd'); process.exitCode = 1 }
} else if (adminIndex >= 0) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    const token = unprotectWindowsSecret(fs.readFileSync(adminFile))
    const response = await fetch(`http://127.0.0.1:${saved.port}/official/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: process.argv[adminIndex + 1], value: process.argv[adminIndex + 2] }), signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    console.info('[official] 管理操作成功，已保留审计记录')
  } catch (error) { console.error('[official] 管理操作失败，请确认官方服务已启动：', error.message); process.exitCode = 1 }
} else {
// Own the process before touching PostgreSQL: a second launch must never stop it.
process.on('exit', acquireOfficialProcessLock(stateRoot))
process.env.APP_ROOT_DIR = root
process.env.USER_DATA_DIR = stateRoot
process.env.RVB_PROFILE_ROOT = root
const pagesRoot = path.join(root, 'data', 'pages')
let config = process.argv.includes('--configure') ? await configureWindows(file, open, pagesRoot) : loadConfig(file) || await configureWindows(file, open, pagesRoot)
const mail = createLiveMailer(config.smtp, smtp => { const next = { ...config, smtp }; saveConfig(file, next); config = next })
const backups = new OfficialBackups(stateRoot)
const runtimeRoot = fs.existsSync(path.join(root, 'postgres', 'pgsql')) ? path.join(root, 'postgres', 'pgsql') : path.join(root, '_client-postgres', 'pgsql')
const database = new EmbeddedPostgresController({ runtimeRoot, stateRoot: path.join(stateRoot, 'postgres'), findFreePort, portHint: 38731,
  protectSecret: protectWindowsSecret, unprotectSecret: unprotectWindowsSecret,
  onUnexpectedExit: () => { console.error('[official] 数据库进程退出，正在停止服务'); void shutdown() },
})
let app, panel, stopping = false, stopRequested = false, operationTask
const adminToken = randomBytes(32).toString('base64url')
fs.writeFileSync(adminFile, protectWindowsSecret(adminToken))
async function shutdown() {
  if (stopRequested) return
  stopRequested = true
  // HTTP disconnection does not cancel an accepted data operation.
  try { await operationTask } catch { /* The operation reports its own failure. Cleanup still runs. */ }
  stopping = true
  for (const cleanup of [() => panel?.close(), () => app?.close(), () => database.stop(), () => mail.close(), () => fs.rmSync(panelFile, { force: true })]) {
    try { await cleanup() } catch { process.exitCode = 1; console.error('[official] 停服清理发生错误，请保留数据与日志') }
  }
}
process.on('SIGINT', () => { void shutdown() }); process.on('SIGTERM', () => { void shutdown() })
async function startApp(listen = true) {
  if (stopping) throw new OfficialError('服务正在停止', 503)
  const connection = await database.start()
  const { createOfficialServer } = await import('../lib/server/official/server.ts')
  app = await createOfficialServer({ databaseUrl: connection.url, mail: mail.send, maxMatches: config.maxMatches, pagesRoot: path.join(root, 'data', 'pages'), adminToken })
  if (listen && !stopRequested) await app.start(config.port)
}
async function stopApp() {
  const previous = app; app = undefined; const errors = []
  try { await previous?.close() } catch (error) { errors.push(error) }
  try { await database.stop() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, '玩家服务或数据库未正常停止，未执行数据替换')
}
const operations = {
  read: async () => ({ smtp: mail.settings(), backups: await backups.list() }),
  execute: async (action, input) => {
    if (stopRequested || operationTask) throw new OfficialError('服务器正在维护数据或停止', 503)
    const task = executeOperation(action, input); operationTask = task
    try { await task } finally { if (operationTask === task) operationTask = undefined }
  },
}
async function executeOperation(action, input) {
    const reason = String(input.reason || '').trim(), value = String(input.value || '')
    if (action === 'smtp-save') {
      try { await mail.replace(input.smtp) } catch { throw new OfficialError('SMTP验证或保存失败，原配置仍然有效', 503) }
    } else if (action === 'backup-check') await backups.verify(value)
    else {
      if (!(await app.pool.query('SELECT maintenance FROM official_settings')).rows[0].maintenance) throw new OfficialError('请先开启维护，再进行备份或恢复', 409)
      if (action === 'backup-restore') await backups.verify(value)
      await app.ranked.prepareShutdown()
      try {
        await stopApp()
        const safety = await backups.create()
        if (action === 'backup-restore') {
          console.info('[official-backup] 恢复前自动备份已保存', { backupId: safety })
          await backups.stageRestore(value)
        }
        await startApp(false)
        if (action === 'backup-restore') {
          await app.pool.query('DELETE FROM official_sessions; DELETE FROM official_email_codes; UPDATE official_settings SET maintenance=TRUE')
          await backups.commitRestore()
        }
      } catch {
        // Preserve both copies. On any interrupted restore, the previous cluster wins.
        try { await stopApp(); await backups.recoverInterruptedRestore(); await startApp() }
        catch { void shutdown(); throw new OfficialError('数据维护失败，服务正在停止；请保留数据并重新运行 Start-Official.cmd', 503) }
        throw new OfficialError('备份或恢复失败，已重新启动原数据；请检查磁盘空间与备份完整性', 503)
      }
      if (!stopRequested) {
        try { await app.start(config.port) }
        catch { void shutdown(); throw new OfficialError('备份数据已保存，但玩家入口重启失败；请重新运行 Start-Official.cmd', 503) }
      }
    }
    await app.pool.query('INSERT INTO official_audit(action,detail) VALUES($1,$2)', [action, { value: action === 'smtp-save' ? 'SMTP配置（凭据不记录）' : value, reason }])
}
try {
  if (fs.existsSync(path.join(stateRoot, 'restore-intent.json'))) {
    try { await database.stop() } catch { console.info('[official-backup] 停止检查未成功，将独立验证旧进程已退出后恢复') }
    await backups.recoverInterruptedRestore()
  }
  await startApp()
  {
    panel = await startControlPanel({ get ranked() { return app.ranked }, mail, playerPort: config.port, pagesRoot, operations,
      assetsRoot: fs.existsSync(path.join(root, 'control-panel')) ? path.join(root, 'control-panel') : path.join(root, 'lib/server/official/panel'), shutdown })
    fs.writeFileSync(panelFile, protectWindowsSecret(panel.url))
    console.info(`[official] 排位入口：http://127.0.0.1:${config.port}/official.html`)
    console.info(`[official] 数据保存在 ${stateRoot}；按 Ctrl+C 正常停服。异地账号登录需要 HTTPS 入口。`)
    console.info('[official] 本机运营面板已就绪；可运行 Open-Control-Panel.cmd 重新打开')
    open(panel.url)
  }
} catch (error) { console.error('[official] 启动失败', { code: error?.code || 'START_FAILED', message: error?.message || 'Unknown error' }); await shutdown(); process.exitCode = 1 }

}
