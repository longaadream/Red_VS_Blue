import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { acquireOfficialProcessLock } from '../lib/server/official/process-lock.ts'
import { EmbeddedPostgresController } from '../electron-client/embedded-postgres.ts'
import { findFreePort } from '../electron-client/local-port.ts'
import { configureWindows, loadConfig, protectWindowsSecret, unprotectWindowsSecret } from '../lib/server/official/windows-config.ts'
import { createSmtpMailer } from '../lib/server/official/mail.ts'

const root = process.env.RVB_OFFICIAL_ROOT || (fs.existsSync(path.join(import.meta.dirname, 'data')) ? import.meta.dirname : path.resolve(import.meta.dirname, '..'))
const stateRoot = process.env.RVB_OFFICIAL_STATE_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Red-vs-Blue-Official')
fs.mkdirSync(stateRoot, { recursive: true })
const file = path.join(stateRoot, 'official-config.json')
const adminFile = path.join(stateRoot, 'admin-token.protected')
const adminIndex = process.argv.indexOf('--admin')
if (adminIndex >= 0) {
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
const open = url => {
  if (process.env.RVB_OFFICIAL_NO_BROWSER === '1') return
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:RVB_OPEN_URL'], { env: { ...process.env, RVB_OPEN_URL: url }, windowsHide: true, stdio: 'ignore' })
  child.on('exit', code => { if (code) console.info('[official] 请手动打开终端中的本机地址') })
  child.on('error', () => console.info('[official] 请手动打开终端中的本机地址'))
}
const config = process.argv.includes('--configure') ? await configureWindows(file, open) : loadConfig(file) || await configureWindows(file, open)
const mail = createSmtpMailer(config.smtp)
const runtimeRoot = fs.existsSync(path.join(root, 'postgres', 'pgsql')) ? path.join(root, 'postgres', 'pgsql') : path.join(root, '_client-postgres', 'pgsql')
const database = new EmbeddedPostgresController({ runtimeRoot, stateRoot: path.join(stateRoot, 'postgres'), findFreePort, portHint: 38731,
  protectSecret: protectWindowsSecret, unprotectSecret: unprotectWindowsSecret,
  onUnexpectedExit: () => { console.error('[official] 数据库进程退出，正在停止服务'); void shutdown() },
})
let app, stopping = false
const adminToken = randomBytes(32).toString('base64url')
fs.writeFileSync(adminFile, protectWindowsSecret(adminToken))
async function shutdown() {
  if (stopping) return
  stopping = true
  for (const cleanup of [() => app?.close(), () => database.stop(), () => mail.close()]) {
    try { await cleanup() } catch { process.exitCode = 1; console.error('[official] 停服清理发生错误，请保留数据与日志') }
  }
}
process.on('SIGINT', () => { void shutdown() }); process.on('SIGTERM', () => { void shutdown() })
try {
  const connection = await database.start()
  const { createOfficialServer } = await import('../lib/server/official/server.ts')
  app = await createOfficialServer({ databaseUrl: connection.url, mail: mail.send, maxMatches: config.maxMatches, pagesRoot: path.join(root, 'data', 'pages'), adminToken })
  {
    await app.start(config.port)
    console.info(`[official] 排位入口：http://127.0.0.1:${config.port}/official.html`)
    console.info(`[official] 数据保存在 ${stateRoot}；按 Ctrl+C 正常停服。异地账号登录需要 HTTPS 入口。`)
    open(`http://127.0.0.1:${config.port}/official.html`)
  }
} catch (error) { console.error('[official] 启动失败', { code: error?.code || 'START_FAILED', message: error?.message || 'Unknown error' }); await shutdown(); process.exitCode = 1 }

}
