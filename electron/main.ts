import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as http from 'http'
import type WebSocket from 'ws'
import { randomBytes } from 'crypto'
import { shouldReportServerStartupFailure } from './server-process-lifecycle'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import {
  type ServerProfileReference,
  isHealthyCommittedServerObservation,
  readServerProfileState,
  recoverUncertainServerCommit,
  resolveServerProfileRoot,
} from './resource-pack-store'

let serverProcess: ChildProcess | null = null
const requestedServerStops = new WeakSet<ChildProcess>()
let tray: Tray | null = null
let dashboardWin: BrowserWindow | null = null
let serverRunning = false
let cleanupInterval: NodeJS.Timeout | null = null
const BATTLE_AUTHORITY_SHUTDOWN_REQUEST = 'rvb:battle-authority:shutdown'
const BATTLE_AUTHORITY_SHUTDOWN_RESULT = 'rvb:battle-authority:shutdown-result'
const SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 6_500
const PROFILE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
const PROFILE_ADMIN_KEY = randomBytes(32).toString('hex')
let allowAppExit = false
let appExitPromise: Promise<void> | null = null

type ChildLogStream = 'stdout' | 'stderr'
type ChildLogErrorSide = 'source' | 'target' | 'write'

type ChildLogForwardingRecord = {
  event: 'electron.child-log-forwarding.error'
  runtime: 'electron-server' | 'electron-client'
  stream: ChildLogStream
  side: ChildLogErrorSide
  code: string
  message: string
  recoverable: boolean
  action: 'stop-forwarding' | 'report-error'
}

type SafeLogForwarderOptions = {
  runtime: ChildLogForwardingRecord['runtime']
  stream: ChildLogStream
  report: (record: ChildLogForwardingRecord) => void
  reportUnexpectedError: (error: Error, record: ChildLogForwardingRecord) => void
}

export function attachSafeLogForwarder(
  source: NodeJS.ReadableStream,
  target: NodeJS.WritableStream,
  options: SafeLogForwarderOptions,
): () => void {
  let forwarding = true
  let disposed = false
  let errorReported = false
  let sourceFinished = false
  let pendingWrites = 0
  let disposeScheduled = false

  const stopForwarding = (): void => {
    if (!forwarding) return
    forwarding = false
    source.removeListener('data', onData)
  }

  const handleError = (side: ChildLogErrorSide, value: unknown): void => {
    const details = value && typeof value === 'object'
      ? value as { code?: unknown; message?: unknown }
      : {}
    const message = typeof details.message === 'string' ? details.message : String(value)
    const error = value && typeof value === 'object' && typeof details.message === 'string'
      ? value as Error
      : new Error(message)
    const code = typeof details.code === 'string' ? details.code : 'UNKNOWN'
    const recoverable = code === 'EPIPE'

    if (errorReported) return

    stopForwarding()
    errorReported = true
    const record: ChildLogForwardingRecord = {
      event: 'electron.child-log-forwarding.error',
      runtime: options.runtime,
      stream: options.stream,
      side,
      code,
      message,
      recoverable,
      action: recoverable ? 'stop-forwarding' : 'report-error',
    }

    try {
      options.report(record)
    } catch {
      // Diagnostics may use the same broken host pipe. EPIPE must remain contained.
    }
    if (!recoverable) options.reportUnexpectedError(error, record)
  }

  const maybeDispose = (): void => {
    if (!sourceFinished || pendingWrites > 0 || disposed || disposeScheduled) return
    disposeScheduled = true
    setImmediate(() => {
      disposeScheduled = false
      if (sourceFinished && pendingWrites === 0) dispose()
    })
  }

  const onData = (chunk: string | Uint8Array): void => {
    if (!forwarding) return
    pendingWrites += 1
    let settled = false
    const onWriteComplete = (error?: Error | null): void => {
      if (settled) return
      settled = true
      pendingWrites -= 1
      if (error) handleError('write', error)
      maybeDispose()
    }
    try {
      target.write(chunk, onWriteComplete)
    } catch (error) {
      onWriteComplete(
        error && typeof error === 'object' ? error as Error : new Error(String(error)),
      )
    }
  }
  const onSourceError = (error: unknown): void => handleError('source', error)
  const onTargetError = (error: unknown): void => handleError('target', error)
  const onTargetClose = (): void => stopForwarding()
  const onSourceFinished = (): void => {
    if (sourceFinished) return
    sourceFinished = true
    stopForwarding()
    maybeDispose()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopForwarding()
    source.removeListener('error', onSourceError)
    source.removeListener('end', onSourceFinished)
    source.removeListener('close', onSourceFinished)
    target.removeListener('error', onTargetError)
    target.removeListener('close', onTargetClose)
  }

  source.on('data', onData)
  source.on('error', onSourceError)
  source.once('end', onSourceFinished)
  source.once('close', onSourceFinished)
  target.on('error', onTargetError)
  target.once('close', onTargetClose)

  return dispose
}

function logChildForwardingRecord(record: ChildLogForwardingRecord): void {
  console.warn('[electron:child-log-forwarding]', JSON.stringify(record))
}

function logUnexpectedChildStreamError(error: Error, record: ChildLogForwardingRecord): void {
  console.error('[electron] Unexpected child log stream error:', record, error)
}

function applyExplicitUserDataOverride(): void {
  const prefix = '--rvb-user-data-dir='
  const argument = process.argv.find(value => value.startsWith(prefix))
  const environmentPath = process.env.RVB_ELECTRON_USER_DATA_DIR
  if (environmentPath === undefined && !argument) return
  const rawPath = environmentPath ?? argument!.slice(prefix.length)
  const resolvedPath = path.resolve(rawPath)
  if (!rawPath || path.dirname(resolvedPath) === resolvedPath) {
    throw new Error('Invalid --rvb-user-data-dir path')
  }
  fs.mkdirSync(resolvedPath, { recursive: true })
  app.setPath('userData', resolvedPath)
  app.setPath('sessionData', resolvedPath)
}

// Apply the explicit candidate-only path before requestSingleInstanceLock()
// so Electron storage and ProcessSingleton are truly isolated.
applyExplicitUserDataOverride()

// ─── 路径工具 ────────────────────────────────────────────────────────────────

function getAppRoot(): string {
  if (app.isPackaged) {
    // 打包后：resources/app/
    return path.join(process.resourcesPath, 'app')
  }
  // 开发时：__dirname = electron/dist/，项目根在 ../..
  return path.join(__dirname, '../..')
}

function getUserData(): string {
  return app.getPath('userData')
}

function getPackRoot(): string {
  return path.join(getUserData(), 'resource-pack')
}

function profileRootForReference(reference: ServerProfileReference): string {
  return resolveServerProfileRoot(getPackRoot(), reference) ?? getAppRoot()
}

function getDashboardRoot(): string {
  return path.join(__dirname, '..', 'dashboard')
}

function restrictWindowNavigation(win: BrowserWindow, allowedRoot: string): void {
  const isAllowed = (rawUrl: string): boolean => isFileUrlWithinRoot(rawUrl, allowedRoot)

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame || !isAllowed(details.url)) details.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

// 找到可用的 node 可执行文件
// fork() 在 Electron 里用 Electron 二进制本身作解释器，会导致崩溃；
// 改用 spawn('node', ...) 调用系统 Node.js。
function getNodeBin(): string {
  if (app.isPackaged) {
    // 打包时尝试随 app 一起分发的 node.exe（Windows）或 node
    const candidate = path.join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'node'  // 开发模式：PATH 中的系统 node
}

// ─── 数据库初始化 ─────────────────────────────────────────────────────────────

/**
 * Find the standalone node_modules directory that contains the generated
 * Prisma client (.prisma/client/index.js + query engine binary).
 */
function findStandaloneModules(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'standalone', 'node_modules'),
    path.join(appRoot, '.next', 'standalone', 'node_modules'),
  ]
  for (const r of candidates) {
    if (fs.existsSync(path.join(r, '.prisma', 'client', 'index.js'))) return r
  }
  return null
}

function initDatabase(dbPath: string, appRoot: string): void {
  // Locate the init-db.js helper script (bundled as extraResource at resources/app/init-db.js)
  const initScript = path.join(appRoot, 'init-db.js')
  if (!fs.existsSync(initScript)) {
    console.error('[electron] init-db.js not found at', initScript, '— skipping DB init')
    return
  }

  const moduleRoot = findStandaloneModules(appRoot)
  if (!moduleRoot) {
    console.error('[electron] Standalone node_modules (with .prisma/client) not found — skipping DB init')
    return
  }

  console.log('[electron] Initialising database:', dbPath)
  try {
    execSync(
      `"${getNodeBin()}" "${initScript}" "file:${dbPath}" "${moduleRoot}"`,
      { env: process.env, cwd: appRoot, stdio: 'pipe' }
    )
    console.log('[electron] Database ready.')
  } catch (err) {
    console.error('[electron] initDatabase error:', err)
  }
}

// ─── Static 资源复制 ──────────────────────────────────────────────────────────

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

/**
 * Next.js standalone server.js 需要 static 文件与自身同目录下：
 *   <standaloneDir>/.next/static/   ← 从 <appRoot>/.next/static/ 复制
 *   <standaloneDir>/public/         ← 从 <appRoot>/public/ 复制
 * 若目标目录不存在则自动复制（开发模式 / 首次 build 后即可生效）。
 */
function ensureStandaloneAssets(appRoot: string, serverEntry: string): void {
  const standaloneDir = path.dirname(serverEntry)

  const pairs = [
    {
      src: path.join(appRoot, '.next', 'static'),
      dst: path.join(standaloneDir, '.next', 'static'),
    },
    {
      src: path.join(appRoot, 'public'),
      dst: path.join(standaloneDir, 'public'),
    },
  ]

  for (const { src, dst } of pairs) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      console.log(`[electron] Copying assets: ${src} → ${dst}`)
      try {
        copyDirSync(src, dst)
      } catch (err) {
        console.error(`[electron] Failed to copy assets (non-fatal):`, err)
      }
    }
  }
}

// ─── 进程树清理 ───────────────────────────────────────────────────────────────

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' }) } catch {}
  } else {
    try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {} }
  }
}

function requestGracefulServerShutdown(proc: ChildProcess): Promise<boolean> {
  if (!proc.connected || typeof proc.send !== 'function') return Promise.resolve(false)
  const requestId = `${process.pid}:${proc.pid ?? 'unknown'}:${Date.now()}`
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean, warning?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      proc.removeListener('message', onMessage)
      proc.removeListener('exit', onExit)
      if (warning) console.warn('[electron] graceful server shutdown failed:', warning)
      resolve(ok)
    }
    const onMessage = (message: unknown) => {
      const result = message as { type?: unknown; requestId?: unknown; ok?: unknown; error?: unknown }
      if (result.type !== BATTLE_AUTHORITY_SHUTDOWN_RESULT || result.requestId !== requestId) return
      finish(result.ok === true, result.ok === true ? undefined : String(result.error ?? 'journal drain failed'))
    }
    const onExit = () => finish(false, 'server exited before durable drain acknowledgement')
    const timeout = setTimeout(() => {
      finish(false, `timed out after ${SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms`)
    }, SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS)
    timeout.unref?.()
    proc.on('message', onMessage)
    proc.once('exit', onExit)
    try {
      proc.send({ type: BATTLE_AUTHORITY_SHUTDOWN_REQUEST, requestId }, error => {
        if (error) finish(false, error.message)
      })
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error))
    }
  })
}

async function stopChildProcessGracefully(
  proc: ChildProcess,
  requireDurable = false,
): Promise<void> {
  const durable = await requestGracefulServerShutdown(proc)
  if (!durable) {
    if (requireDurable) throw new Error('PROFILE_DURABLE_DRAIN_FAILED')
    console.error('[electron] forcing server stop with a potentially undurable battle journal')
  }
  if (proc.exitCode === null && proc.signalCode === null) killProcessTree(proc)
}

function requestApplicationExit(): void {
  if (allowAppExit) {
    app.exit(0)
    return
  }
  if (appExitPromise) return
  appExitPromise = stopGameServer()
    .catch(error => console.error('[electron] graceful application shutdown failed:', error))
    .finally(() => {
      allowAppExit = true
      app.exit(0)
    })
}

// ─── 游戏服务器进程 ───────────────────────────────────────────────────────────

function findServerEntry(appRoot: string): string | null {
  return [
    path.join(appRoot, '.next', 'standalone', 'server.js'),                               // 开发模式（标准路径）
    path.join(appRoot, '.next', 'standalone', path.basename(appRoot), 'server.js'),       // 旧版嵌套路径
    path.join(appRoot, 'standalone', 'server.js'),                                        // 打包模式（_standalone → standalone）
  ].find(p => fs.existsSync(p)) ?? null
}

function findSamePortPreload(appRoot: string, serverEntry: string): string | null {
  return [
    path.join(path.dirname(serverEntry), 'ws-same-port-server.cjs'),
    path.join(appRoot, 'scripts', 'ws-same-port-server.cjs'),
  ].find(candidate => fs.existsSync(candidate)) ?? null
}

type ProfileProcessBinding = {
  reference?: ServerProfileReference
  profileRoot: string
  activationId?: string
}

function stableProfileBinding(): ProfileProcessBinding {
  try {
    const stable = readServerProfileState(getPackRoot())?.stable
    if (!stable) return { profileRoot: getAppRoot() }
    return { reference: stable, profileRoot: profileRootForReference(stable) }
  } catch (error) {
    console.error('[profile] stable binding is invalid; server will recover through Bundled Base:', error)
    return { profileRoot: getAppRoot() }
  }
}

function waitForServerReady(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const probe = (): void => {
      if (!serverProcess) return resolve(false)
      if (Date.now() >= deadline) return resolve(false)
      const request = http.get('http://127.0.0.1:3000/api/ping', response => {
        response.resume()
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) resolve(true)
        else setTimeout(probe, 250)
      })
      request.once('error', () => setTimeout(probe, 250))
      request.setTimeout(1_000, () => request.destroy())
    }
    probe()
  })
}

async function startGameServer(profileBinding?: ProfileProcessBinding): Promise<void> {
  if (serverProcess) return

  const appRoot = getAppRoot()
  const userData = getUserData()

  // 开发模式：复用项目里的 prisma/dev.db（与 npm run dev 共享同一数据库）
  // 打包后：使用 AppData 里的独立数据库，并自动跑 migration
  let databaseUrl: string
  if (app.isPackaged) {
    const dbPath = path.join(userData, 'game.db')
    if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true })
    try { initDatabase(dbPath, appRoot) } catch (err) {
      console.error('[electron] initDatabase error:', err)
    }
    databaseUrl = `file:${dbPath}`
  } else {
    // 开发模式：直接用项目目录下的 dev.db（绝对路径避免 cwd 差异）
    databaseUrl = `file:${path.join(appRoot, 'prisma', 'dev.db')}`
    console.log('[electron] Dev mode: using', databaseUrl)
  }

  const serverEntry = findServerEntry(appRoot)
  if (!serverEntry) {
    const msg = `server.js not found under .next/standalone/\n\nAppRoot: ${appRoot}\n\nPlease run "npm run build" first.`
    console.error('[electron]', msg)
    dialog.showErrorBox('服务器未构建', msg)
    return
  }

  const samePortPreload = findSamePortPreload(appRoot, serverEntry)
  if (!samePortPreload) {
    const msg = `ws-same-port-server.cjs not found for ${serverEntry}`
    console.error('[electron]', msg)
    dialog.showErrorBox('服务器网络入口缺失', msg)
    return
  }

  // 确保 CSS / JS / 图片等 static 资源在 standalone 目录下
  ensureStandaloneAssets(appRoot, serverEntry)

  const binding = profileBinding ?? stableProfileBinding()
  let spawnedProcess: ChildProcess
  try {
    spawnedProcess = spawn(getNodeBin(), ['--require', samePortPreload, serverEntry], {
      cwd: path.dirname(serverEntry),
      env: {
        ...process.env,
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        NODE_ENV: 'production',
        RVB_BATTLE_AUTHORITY_V2: '1',
        RVB_BATTLE_ASYNC_JOURNAL: '1',
        RVB_TURN_TIMER_ENABLED: '1',
        APP_ROOT_DIR: appRoot,
        USER_DATA_DIR: userData,
          DATABASE_URL: databaseUrl,
          RVB_PROFILE_ADMIN_KEY: PROFILE_ADMIN_KEY,
          RVB_ALLOW_LOCAL_DEV_PROFILES: app.isPackaged ? '0' : '1',
          RVB_PROFILE_ADMISSION_PAUSED: binding?.activationId ?? 'startup-recovery',
        RVB_PROFILE_ROOT: binding.profileRoot,
        RVB_RESOLVED_PROFILE_HASH: binding.reference?.resolvedProfileHash,
        RVB_AUTHORITY_CONTENT_HASH: binding.reference?.authorityContentHash,
        RVB_PROFILE_ENGINE_ABI: binding.reference?.compatibility.engineAbi,
        RVB_PROFILE_CONTENT_ABI: binding.reference?.compatibility.contentAbi,
        RVB_PROFILE_ACTIVATION_ID: binding.activationId,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    serverProcess = spawnedProcess
  } catch (err) {
    const msg = `Failed to spawn server process:\n${err}`
    console.error('[electron]', msg)
    dialog.showErrorBox('无法启动服务器', msg)
    return
  }

  if (spawnedProcess.stdout) {
    attachSafeLogForwarder(spawnedProcess.stdout, process.stdout, {
      runtime: 'electron-server',
      stream: 'stdout',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }
  if (spawnedProcess.stderr) {
    attachSafeLogForwarder(spawnedProcess.stderr, process.stderr, {
      runtime: 'electron-server',
      stream: 'stderr',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }

  spawnedProcess.on('error', (err) => {
    console.error('[electron] Server process error:', err)
    if (!requestedServerStops.has(spawnedProcess)) {
      dialog.showErrorBox('服务器错误', String(err))
    }
    if (serverProcess === spawnedProcess) {
      serverRunning = false
      serverProcess = null
      dashboardWin?.webContents.send('server-status', { running: false })
      updateTrayMenu()
    }
  })

  spawnedProcess.on('exit', (code) => {
    const stoppedByRequest = requestedServerStops.has(spawnedProcess)
    requestedServerStops.delete(spawnedProcess)
    if (serverProcess === spawnedProcess) {
      serverRunning = false
      serverProcess = null
      dashboardWin?.webContents.send('server-status', { running: false, code })
      updateTrayMenu()
    }
    console.log(`[electron] Server exited with code ${code}`)
    if (shouldReportServerStartupFailure(code, stoppedByRequest)) {
      dialog.showErrorBox(
        '服务器启动失败',
        '端口 3000 已被占用。\n\n请关闭占用 3000 端口的其他程序（如 npm run dev），然后点击"启动服务器"重试。'
      )
    }
  })

  serverRunning = await waitForServerReady()
  if (serverProcess === spawnedProcess && serverRunning) {
    dashboardWin?.webContents.send('server-status', { running: true })
    updateTrayMenu()
    startRoomCleanup()
  }
}

function startRoomCleanup(): void {
  if (cleanupInterval) return

  const cleanupRooms = async () => {
    try {
      const adminKey = process.env.ROOM_ADMIN_KEY || 'admin-secret-key'
      const response = await fetch('http://localhost:3000/api/admin/rooms/cleanup', {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      })
      if (response.ok) {
        const result = await response.json() as { deletedCount?: number }
        if (result.deletedCount && result.deletedCount > 0) {
          console.log(`[cleanup] Deleted ${result.deletedCount} old rooms`)
        }
      }
    } catch (err) {
      console.error('[cleanup] Cleanup failed:', err)
    }
  }

  cleanupRooms()
  cleanupInterval = setInterval(cleanupRooms, 60 * 60 * 1000)
}

async function stopGameServer(requireDurable = false): Promise<void> {
  if (!serverProcess) return
  const proc = serverProcess
  await stopChildProcessGracefully(proc, requireDurable)
  requestedServerStops.add(proc)
  serverProcess = null
  serverRunning = false
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
  dashboardWin?.webContents.send('server-status', { running: false })
  updateTrayMenu()
}

async function restartGameServer(
  profileBinding?: ProfileProcessBinding,
  requireDurable = false,
): Promise<void> {
  await stopGameServer(requireDurable)
  await new Promise(resolve => setTimeout(resolve, 500))
  await startGameServer(profileBinding)
}

// ─── 管理面板窗口 ─────────────────────────────────────────────────────────────

function createDashboardWindow(): void {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show()
    dashboardWin.focus()
    return
  }

  dashboardWin = new BrowserWindow({
    width: 560,
    height: 480,
    title: 'RED vs BLUE Server',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  const dashboardRoot = getDashboardRoot()
  restrictWindowNavigation(dashboardWin, dashboardRoot)
  dashboardWin.loadFile(path.join(dashboardRoot, 'index.html'))
  dashboardWin.on('close', (e) => {
    e.preventDefault()
    dashboardWin?.hide()
  })
}

// ─── 系统托盘 ─────────────────────────────────────────────────────────────────

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('RED vs BLUE Server')
  updateTrayMenu()
  tray.on('double-click', createDashboardWindow)
}

function updateTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '打开管理面板', click: createDashboardWindow },
    { type: 'separator' },
    {
      label: serverRunning ? '重启服务器' : '启动服务器',
      click: () => {
        void (serverRunning
          ? restartStableGameServerAndRecover()
          : startStableGameServerAndRecover())
      },
    },
    {
      label: '停止服务器',
      enabled: serverRunning,
      click: () => { void stopGameServer() },
    },
    { type: 'separator' },
    { label: '退出', click: requestApplicationExit },
  ]))
}

// Electron/Next JSON replies are validated at each authority boundary below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

let profileMutationTail: Promise<unknown> = Promise.resolve()

function enqueueProfileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = profileMutationTail.then(operation, operation)
  profileMutationTail = next.then(() => undefined, () => undefined)
  return next
}

function profileApiRequest<T extends JsonObject = JsonObject>(
  route: string,
  options: { method?: 'GET' | 'POST'; json?: JsonObject; archive?: Buffer } = {},
): Promise<T> {
  const body = options.archive
    ?? (options.json ? Buffer.from(JSON.stringify(options.json), 'utf8') : null)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: route,
      method: options.method ?? 'GET',
      headers: {
        'x-rvb-profile-admin-key': PROFILE_ADMIN_KEY,
        ...(options.archive ? { 'content-type': 'application/zip' } : {}),
        ...(options.json ? { 'content-type': 'application/json' } : {}),
        ...(body ? { 'content-length': body.byteLength } : {}),
        ...(!app.isPackaged ? { 'x-rvb-local-dev-profile': '1' } : {}),
      },
    }, response => {
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > 2 * 1024 * 1024) {
          request.destroy(new Error('PROFILE_API_RESPONSE_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        let parsed: JsonObject
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject
        } catch {
          reject(new Error(`PROFILE_API_INVALID_RESPONSE: ${response.statusCode ?? 0}`))
          return
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(String(parsed.message ?? parsed.error ?? `HTTP ${response.statusCode}`)) as Error & { code?: string }
          error.code = typeof parsed.error === 'string' ? parsed.error : 'PROFILE_API_FAILED'
          reject(error)
          return
        }
        resolve(parsed as T)
      })
    })
    request.once('error', reject)
    request.setTimeout(30_000, () => request.destroy(new Error('PROFILE_API_TIMEOUT')))
    if (body) request.write(body)
    request.end()
  })
}

function decodeProfileArchive(base64Data: string): Buffer {
  const maxBase64Length = Math.ceil(PROFILE_ARCHIVE_MAX_BYTES / 3) * 4 + 4
  if (
    typeof base64Data !== 'string'
    || base64Data.length === 0
    || base64Data.length > maxBase64Length
    || base64Data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)
  ) throw new Error('Resource-pack archive is not valid bounded base64')
  const archive = Buffer.from(base64Data, 'base64')
  if (archive.byteLength === 0 || archive.byteLength > PROFILE_ARCHIVE_MAX_BYTES) {
    throw new Error('Resource-pack compressed archive is empty or exceeds 32 MiB')
  }
  return archive
}

function probeProfileWebSocket(timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const modulePath = app.isPackaged
      ? path.join(getAppRoot(), 'standalone', 'node_modules', 'ws', 'lib', 'websocket.js')
      : 'ws'
    const WebSocketClient = require(modulePath) as new (address: string) => WebSocket
    const socket = new WebSocketClient('ws://127.0.0.1:3000/ws/rooms/__profile-health__')
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try { socket.close() } catch {}
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error('PROFILE_WEBSOCKET_TIMEOUT')), timeoutMs)
    socket.once('open', () => finish())
    socket.once('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    socket.once('unexpected-response', (_request, response) => finish(new Error(`PROFILE_WEBSOCKET_HTTP_${response.statusCode}`)))
  })
}

async function recordProfileActivationFailure(
  activationId: string,
  stage: string,
  error: unknown,
  keepAdmissionPaused = false,
): Promise<void> {
  await profileApiRequest('/api/content-profile/activation/failure', {
    method: 'POST',
    json: {
      activationId,
      code: 'CANDIDATE_ACTIVATION_FAILED',
      stage,
      message: error instanceof Error ? error.message : String(error),
      keepAdmissionPaused,
    },
  })
}

async function observeCommittedProfileAfterRecovery(): Promise<JsonObject | null> {
  if (!serverRunning) return null
  try {
    const recovery = await profileApiRequest('/api/content-profile/recovery', { method: 'POST' })
    if (recovery.requiresProcessRestart === true) return null
    return await profileApiRequest('/api/content-profile')
  } catch {
    return null
  }
}

async function activateProfileHash(targetProfileHash: string): Promise<JsonObject> {
  if (!serverRunning) throw new Error('PROFILE_SERVER_NOT_READY')
  const before = await profileApiRequest('/api/content-profile')
  if (before.state?.stable?.resolvedProfileHash === targetProfileHash) {
    if (
      before.server?.healthy !== true
      || before.server?.activationId !== null
      || before.server?.profile?.resolvedProfileHash !== targetProfileHash
    ) throw new Error('ACTIVE_PROFILE_IDENTITY_OR_HEALTH_MISMATCH')
    return { ok: true, alreadyActive: true, state: before.state, server: before.server }
  }
  let stage = 'activation-plan'
  let plan: JsonObject | null = null
  try {
    plan = await profileApiRequest('/api/content-profile/activation/plan', {
      method: 'POST',
      json: { targetProfileHash },
    })
    if (plan.reloadMode === 'authority-restart') {
      stage = 'candidate-server-start'
      await restartGameServer({
        reference: plan.target as ServerProfileReference,
        profileRoot: String(plan.profileRoot),
        activationId: String(plan.activationId),
      }, true)
      if (!serverRunning) throw new Error('CANDIDATE_SERVER_START_FAILED')
    } else if (plan.reloadMode === 'presentation-refresh') {
      stage = 'candidate-server-rebind'
      await profileApiRequest('/api/content-profile/activation/rebind', {
        method: 'POST',
        json: { activationId: plan.activationId, targetProfileHash },
      })
    } else {
      throw new Error(`UNSUPPORTED_PROFILE_RELOAD_MODE: ${String(plan.reloadMode)}`)
    }

    stage = 'candidate-server-health'
    const candidate = await profileApiRequest('/api/content-profile')
    const report = candidate.server
    if (
      !report?.healthy
      || report.activationId !== plan.activationId
      || report.profile?.resolvedProfileHash !== targetProfileHash
      || report.profile?.authorityContentHash !== plan.target.authorityContentHash
      || report.profile?.compatibility?.engineAbi !== plan.target.compatibility.engineAbi
      || report.profile?.compatibility?.contentAbi !== plan.target.compatibility.contentAbi
    ) throw new Error('CANDIDATE_SERVER_IDENTITY_OR_HEALTH_MISMATCH')

    stage = 'candidate-websocket-health'
    await probeProfileWebSocket()

    stage = 'activation-commit'
    const committed = await profileApiRequest('/api/content-profile/activation/commit', {
      method: 'POST',
      json: { activationId: plan.activationId, targetProfileHash },
    })
    return { ok: true, ...committed }
  } catch (error) {
    if (plan) {
      const durableDrainFailed = error instanceof Error && error.message === 'PROFILE_DURABLE_DRAIN_FAILED'
      if (stage === 'activation-commit') {
        let readOnlyObserved: JsonObject | null = null
        if (serverRunning) {
          try {
            readOnlyObserved = await profileApiRequest('/api/content-profile')
          } catch {}
        }
        if (isHealthyCommittedServerObservation(readOnlyObserved, targetProfileHash)) {
          return {
            ok: true,
            commitRecovered: true,
            state: readOnlyObserved!.state,
            server: readOnlyObserved!.server,
          }
        }
        const code = (error as Error & { code?: string }).code
        const commitIsUncertain = !code || code === 'PROFILE_COMMIT_RESPONSE_UNCERTAIN'
        if (commitIsUncertain) {
        try {
          const observed = await recoverUncertainServerCommit(
            targetProfileHash,
            observeCommittedProfileAfterRecovery,
            async () => {
              await restartGameServer(stableProfileBinding())
              if (!serverRunning) throw new Error('PROFILE_COMMIT_RECOVERY_RESTART_FAILED')
            },
          )
          if (observed) {
            return { ok: true, commitRecovered: true, state: observed.state, server: observed.server }
          }
        } catch {}
        }
      }
      let failureRecorded = false
      if (serverRunning) {
        try {
          await recordProfileActivationFailure(
            String(plan.activationId),
            stage,
            error,
            durableDrainFailed,
          )
          failureRecorded = true
        } catch (recordError) {
          console.error('[profile] activation failure evidence write failed', {
            activationId: String(plan.activationId),
            stage,
            error: recordError instanceof Error ? recordError.message : String(recordError),
          })
        }
      }
      if (!durableDrainFailed) await restartStableGameServerAndRecover()
      if (!failureRecorded && serverRunning) {
        try {
          await recordProfileActivationFailure(
            String(plan.activationId),
            stage,
            error,
            durableDrainFailed,
          )
        } catch (recordError) {
          console.error('[profile] activation failure evidence retry failed', {
            activationId: String(plan.activationId),
            stage,
            error: recordError instanceof Error ? recordError.message : String(recordError),
          })
        }
      }
    }
    const typed = error as Error & { code?: string }
    return {
      ok: false,
      error: typed.message,
      code: typed.code ?? 'PROFILE_ACTIVATION_FAILED',
      stage,
      ...(typed.message === 'PROFILE_DURABLE_DRAIN_FAILED'
        ? { admissionPaused: true, requiresApplicationRestart: true }
        : {}),
    }
  }
}

async function selectAndActivateRollback(target: 'previous-stable' | 'bundled-base'): Promise<JsonObject> {
  const selected = await profileApiRequest('/api/content-profile/rollback', {
    method: 'POST',
    json: { target },
  })
  const targetHash = selected.targetProfileHash
    ?? selected.state?.candidate?.resolvedProfileHash
  if (typeof targetHash !== 'string') throw new Error('PROFILE_ROLLBACK_TARGET_MISSING')
  return activateProfileHash(targetHash)
}

async function recoverProfileOnStartup(): Promise<void> {
  if (!serverRunning) throw new Error('PROFILE_SERVER_NOT_READY')
  let recovered = await profileApiRequest('/api/content-profile/recovery', { method: 'POST' })
  if (recovered.requiresProcessRestart === true) {
    await restartGameServer(stableProfileBinding())
    if (!serverRunning) throw new Error('PROFILE_STARTUP_RECOVERY_RESTART_FAILED')
    recovered = await profileApiRequest('/api/content-profile/recovery', { method: 'POST' })
    if (recovered.requiresProcessRestart === true) {
      throw new Error('PROFILE_STARTUP_RECOVERY_DID_NOT_CONVERGE')
    }
  }
  const report = await profileApiRequest('/api/content-profile')
  const stableProfileHash = recovered.state?.stable?.resolvedProfileHash
  if (
    typeof stableProfileHash !== 'string'
    || report.state?.stable?.resolvedProfileHash !== stableProfileHash
    || report.server?.profile?.resolvedProfileHash !== stableProfileHash
    || report.server?.healthy !== true
  ) throw new Error('PROFILE_STARTUP_RECOVERY_HEALTH_MISMATCH')
}

async function startStableGameServerAndRecover(): Promise<void> {
  await startGameServer(stableProfileBinding())
  await recoverProfileOnStartup()
}

async function restartStableGameServerAndRecover(): Promise<void> {
  await stopGameServer()
  await new Promise(resolve => setTimeout(resolve, 500))
  await startStableGameServerAndRecover()
}

// ─── IPC 处理器 ───────────────────────────────────────────────────────────────

function handleTrusted(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, channel, [{
      role: 'dashboard',
      window: dashboardWin,
      allowUrl: (rawUrl) => isFileUrlWithinRoot(rawUrl, getDashboardRoot()),
    }])
    return listener(event, ...args)
  })
}

handleTrusted('get-status', () => ({ running: serverRunning, port: 3000 }))
handleTrusted('restart-server', async () => { await restartStableGameServerAndRecover() })
handleTrusted('stop-server', async () => { await stopGameServer() })
handleTrusted('start-server', async () => { await startStableGameServerAndRecover() })
handleTrusted('get-lobby', async () => {
  try {
    const res = await fetch('http://localhost:3000/api/lobby')
    return res.ok ? await res.json() : { rooms: [] }
  } catch {
    return { rooms: [] }
  }
})
handleTrusted('get-rooms', async () => {
  try {
    const res = await fetch('http://localhost:3000/api/rooms')
    return res.ok ? await res.json() : { rooms: [] }
  } catch {
    return { rooms: [] }
  }
})
handleTrusted('delete-room', async (_event, roomId: string) => {
  try {
    const adminKey = process.env.ROOM_ADMIN_KEY || 'admin-secret-key'
    const res = await fetch(`http://localhost:3000/api/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': adminKey }
    })
    return res.ok ? { success: true } : { success: false, error: await res.text() }
  } catch (e) {
    return { success: false, error: String(e) }
  }
})
handleTrusted('get-resource-pack-status', async () => {
  try {
    return await profileApiRequest('/api/content-profile')
  } catch (e) {
    return { error: String(e) }
  }
})
handleTrusted('upload-resource-pack-data', async (_event, base64Data: string, _fileName: string) => {
  try {
    const result: JsonObject = await enqueueProfileMutation(async (): Promise<JsonObject> => {
      const archive = decodeProfileArchive(base64Data)
      const installed: JsonObject = await profileApiRequest('/api/content-profile/install', {
        method: 'POST',
        archive,
      })
      return {
        ...installed,
        count: Array.isArray(installed.profile?.files) ? installed.profile.files.length : 0,
      }
    })
    return { success: true, message: 'Profile 已安装为 candidate，等待显式激活', meta: result.reference, ...result }
  } catch (e) {
    console.error('[electron] upload-resource-pack-data error:', e)
    return { success: false, message: String(e) }
  }
})
handleTrusted('activate-resource-pack', async (_event, targetProfileHash: string) => {
  return enqueueProfileMutation(() => activateProfileHash(targetProfileHash))
})
handleTrusted('rollback-resource-pack', async (_event, target: 'previous-stable' | 'bundled-base') => {
  try {
    if (target !== 'previous-stable' && target !== 'bundled-base') throw new Error('Invalid profile rollback target')
    return await enqueueProfileMutation(() => selectAndActivateRollback(target))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// ─── 应用生命周期 ─────────────────────────────────────────────────────────────

// 防止多个实例同时运行（避免多次抢占端口）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 第二个实例启动时，唤起已有窗口
    createDashboardWindow()
  })

  app.whenReady().then(async () => {
    try {
      await startStableGameServerAndRecover()
    } catch (error) {
      console.error('[profile] startup recovery failed; admission remains closed:', error)
      dialog.showErrorBox(
        '内容配置恢复失败',
        '服务器未开放连接。请查看日志并重启应用；仍失败时请回退到 Bundled Base。',
      )
      return
    }
    createDashboardWindow()
    createTray()
  })

  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
  app.on('before-quit', event => {
    if (allowAppExit) return
    event.preventDefault()
    requestApplicationExit()
  })
  app.on('activate', createDashboardWindow)
}
