import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { shouldReportServerStartupFailure } from './server-process-lifecycle'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import { RESOURCE_PACK_LIMITS, importResourcePackArchive } from './resource-pack-store'

let serverProcess: ChildProcess | null = null
const requestedServerStops = new WeakSet<ChildProcess>()
let tray: Tray | null = null
let dashboardWin: BrowserWindow | null = null
let serverRunning = false
let cleanupInterval: NodeJS.Timeout | null = null

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

function startGameServer(): void {
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

  let spawnedProcess: ChildProcess
  try {
    spawnedProcess = spawn(getNodeBin(), ['--require', samePortPreload, serverEntry], {
      cwd: path.dirname(serverEntry),
      env: {
        ...process.env,
        PORT: '3000',
        NODE_ENV: 'production',
        APP_ROOT_DIR: appRoot,
        USER_DATA_DIR: userData,
        DATABASE_URL: databaseUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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

  // 给服务器一点时间启动后再标记为 running
  setTimeout(() => {
    if (serverProcess === spawnedProcess) {
      serverRunning = true
      dashboardWin?.webContents.send('server-status', { running: true })
      updateTrayMenu()
      startRoomCleanup()
    }
  }, 2500)
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

function stopGameServer(): void {
  if (serverProcess) {
    const proc = serverProcess
    requestedServerStops.add(proc)
    serverProcess = null
    serverRunning = false
    if (cleanupInterval) {
      clearInterval(cleanupInterval)
      cleanupInterval = null
    }
    killProcessTree(proc)
    dashboardWin?.webContents.send('server-status', { running: false })
    updateTrayMenu()
  }
}

function restartGameServer(): void {
  stopGameServer()
  setTimeout(startGameServer, 500)
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
      click: serverRunning ? restartGameServer : startGameServer,
    },
    {
      label: '停止服务器',
      enabled: serverRunning,
      click: stopGameServer,
    },
    { type: 'separator' },
    { label: '退出', click: () => { stopGameServer(); app.exit(0) } },
  ]))
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
handleTrusted('restart-server', () => { restartGameServer() })
handleTrusted('stop-server', () => { stopGameServer() })
handleTrusted('start-server', () => { startGameServer() })
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
    const res = await fetch('http://localhost:3000/api/admin/resource-pack')
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return await res.json()
  } catch (e) {
    return { error: String(e) }
  }
})
handleTrusted('upload-resource-pack-data', async (_event, base64Data: string, _fileName: string) => {
  try {
    const maxBase64Length = Math.ceil(RESOURCE_PACK_LIMITS.maxArchiveBytes / 3) * 4 + 4
    if (typeof base64Data !== 'string' || base64Data.length > maxBase64Length) {
      throw new Error('Resource-pack compressed archive exceeds the 32 MiB limit')
    }
    const buffer = Buffer.from(base64Data, 'base64')
    const result = importResourcePackArchive(path.join(getUserData(), 'resource-pack'), buffer)
    return { success: true, message: '上传成功', meta: result.meta, count: result.count }
  } catch (e) {
    console.error('[electron] upload-resource-pack-data error:', e)
    return { success: false, message: String(e) }
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

  app.whenReady().then(() => {
    startGameServer()
    createDashboardWindow()
    createTray()
  })

  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
  app.on('before-quit', () => stopGameServer())
  app.on('activate', createDashboardWindow)
}
