import { app, BrowserWindow, ipcMain, net as electronNet, protocol, session } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as zlib from 'zlib'
import * as os from 'os'
import * as nodeNet from 'net'
import * as dgram from 'dgram'
import * as http from 'http'
import { pathToFileURL } from 'url'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import { resolveDevelopmentProfile } from './development-profile'
import { resolveClientProtocolFile } from './client-protocol-resource'
import {
  RESOURCE_PACK_LIMITS,
  clearActiveResourcePack,
  getActiveResourcePackMeta,
  importResourcePackArchive,
  importResourcePackFromPath,
  isActivatableResourcePackPath,
  listActiveResourcePackFiles,
  resolveActiveResourcePackRoot,
} from './resource-pack-store'

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const LOCAL_PORT_HINT = 38521  // 首选端口，被占用时自动递增（避开 54300-54400 被 QMUpload 占用的范围）
let actualLocalPort = LOCAL_PORT_HINT  // 实际绑定成功的端口
let actualWsPort = 3001
const CLIENT_SCHEME = 'rvb-client'

protocol.registerSchemesAsPrivileged([{
  scheme: CLIENT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

// Development-only named profiles isolate Chromium storage, local identity,
// client configuration, and the ProcessSingleton lock. Electron keys
// requestSingleInstanceLock() by the current userData path, so this must run
// before the existing lock is requested.
const developmentProfile = resolveDevelopmentProfile(
  process.argv,
  app.isPackaged,
  app.getPath('userData'),
)
if (developmentProfile) {
  fs.mkdirSync(developmentProfile.userDataPath, { recursive: true })
  app.setPath('userData', developmentProfile.userDataPath)
  app.setPath('sessionData', developmentProfile.userDataPath)
  console.info(`[client] Development profile "${developmentProfile.name}" uses isolated userData: ${developmentProfile.userDataPath}`)
}

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = nodeNet.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = (srv.address() as nodeNet.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', () => resolve(findFreePort(start + 1)))
  })
}

// ─── 路径工具 ─────────────────────────────────────────────────────────────────

function getAppRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app')
  }
  // 开发模式：electron-client/dist/main.js → 项目根在 ../..
  return path.join(__dirname, '../..')
}

function getHtmlRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'www')
    : path.join(__dirname, '../../data/pages')
}

function getUserData(): string {
  return app.getPath('userData')
}

function getPackRoot(): string {
  return path.join(getUserData(), 'resource-pack')
}

function getConfigPath(): string {
  return path.join(getUserData(), 'rvb-client-config.json')
}

function restrictWindowNavigation(win: BrowserWindow, isAllowed: (rawUrl: string) => boolean): void {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame || !isAllowed(details.url)) details.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function getAdminRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'electron-client', 'admin')
    : path.join(__dirname, '../../electron-client/admin')
}

function getConnectRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'electron-client', 'connect')
    : path.join(__dirname, '../../electron-client/connect')
}

function isGameClientUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === `${CLIENT_SCHEME}:` && url.hostname === 'app'
  } catch {
    return false
  }
}

type ClientWindowRole = 'game' | 'admin' | 'connect'

function trustedTargets(roles: readonly ClientWindowRole[]) {
  const targets = {
    game: { role: 'game', window: mainWin, allowUrl: isGameClientUrl },
    admin: { role: 'admin', window: adminWin, allowUrl: (url: string) => isFileUrlWithinRoot(url, getAdminRoot()) },
    connect: { role: 'connect', window: connectWin, allowUrl: (url: string) => isFileUrlWithinRoot(url, getConnectRoot()) },
  }
  return roles.map((role) => targets[role])
}

function handleTrusted(
  channel: string,
  roles: readonly ClientWindowRole[],
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, channel, trustedTargets(roles))
    return listener(event, ...args)
  })
}

function getOnlineServerUrl(): string | null {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8')
    return (JSON.parse(raw) as { onlineUrl?: string }).onlineUrl || null
  } catch {
    return null
  }
}

function saveOnlineServerUrl(url: string): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true })
  fs.writeFileSync(getConfigPath(), JSON.stringify({ onlineUrl: url }), 'utf-8')
}

function clearOnlineServerUrl(): void {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify({}), 'utf-8')
  } catch {}
}

// ─── 进程树清理 ───────────────────────────────────────────────────────────────

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    // execSync 在 taskkill 卡住时会阻塞整个 quit 流程，导致 Electron 主进程
    // 和 GPU/renderer 子进程一起僵死。用 try/setTimeout 兜底 + 短超时。
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', timeout: 3000 })
    } catch {
      // taskkill 失败或超时——再尝试软杀一次，不阻塞
      try { proc.kill('SIGKILL') } catch {}
    }
  } else {
    try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {} }
  }
}

function killServer(): void {
  if (gatewayServer) {
    try { gatewayServer.close() } catch {}
    gatewayServer = null
  }
  localServerReady = false
  if (!serverProcess) return
  const proc = serverProcess
  serverProcess = null
  killProcessTree(proc)
}

// ─── 本地服务器管理 ───────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null
let gatewayServer: http.Server | null = null
let localServerReady = false
let lastServerExitCode: number | null = null
let lastServerStderr = ''
let actualBackendPort = 0

function proxyUpgrade(req: http.IncomingMessage, socket: nodeNet.Socket, head: Buffer, targetPort: number, targetPath?: string): void {
  const target = nodeNet.connect(targetPort, '127.0.0.1')
  let settled = false
  target.on('connect', () => {
    settled = true
    const lines = [`${req.method} ${targetPath || req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    target.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) target.write(head)
    socket.pipe(target)
    target.pipe(socket)
  })
  target.on('error', () => {
    if (!settled) {
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') } catch {}
    }
    try { socket.destroy() } catch {}
  })
  socket.on('error', () => { try { target.destroy() } catch {} })
}

function startPublicGateway(publicPort: number, backendPort: number, wsPort: number): Promise<void> {
  if (gatewayServer) return Promise.resolve()
  gatewayServer = http.createServer((req, res) => {
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: req.url || '/',
      headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad Gateway')
    })
    req.pipe(proxyReq)
  })
  gatewayServer.on('upgrade', (req, socket, head) => {
    const url = String(req.url || '')
    const isPublicWs = url === '/ws' || url === '/ws/' || url.startsWith('/ws/rooms')
    proxyUpgrade(req, socket as nodeNet.Socket, head, isPublicWs ? wsPort : backendPort, isPublicWs ? '/' : undefined)
  })
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      gatewayServer = null
      reject(err)
    }
    gatewayServer!.once('error', onError)
    gatewayServer!.listen(publicPort, '0.0.0.0', () => {
      gatewayServer!.off('error', onError)
      console.log(`[client] Public HTTP/WS gateway: ${publicPort} -> http ${backendPort}, ws ${wsPort}`)
      resolve()
    })
  })
}

function waitForLocalServerReady(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let settled = false

  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    const retry = () => {
      if (settled) return
      // Server process died — no point polling further
      if (!serverProcess) { finish(false); return }
      if (Date.now() >= deadline) {
        finish(false)
        return
      }
      setTimeout(probe, 250)
    }

    const probe = () => {
      if (!serverProcess) { finish(false); return }
      let retried = false
      const retryOnce = () => {
        if (retried) return
        retried = true
        retry()
      }
      const req = http.get(`http://127.0.0.1:${port}/api/ping`, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) finish(true)
        else retryOnce()
      })
      req.on('error', retryOnce)
      req.setTimeout(1000, () => {
        req.destroy()
        retryOnce()
      })
    }

    probe()
  })
}

function findServerEntry(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, '.next', 'standalone', 'server.js'),
    path.join(appRoot, 'standalone', 'server.js'),
  ]
  // Also scan standalone/<name>/server.js (nested structure from Turbopack)
  const standaloneDir = path.join(appRoot, 'standalone')
  if (fs.existsSync(standaloneDir)) {
    try {
      for (const e of fs.readdirSync(standaloneDir, { withFileTypes: true })) {
        if (e.isDirectory()) candidates.push(path.join(standaloneDir, e.name, 'server.js'))
      }
    } catch {}
  }
  return candidates.find(p => fs.existsSync(p)) ?? null
}

function getNodeBin(): string {
  if (app.isPackaged) {
    const candidate = path.join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'node'
}

function findStandaloneModules(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'standalone', 'node_modules'),
    path.join(appRoot, '.next', 'standalone', 'node_modules'),
  ]
  // Also scan standalone/<name>/node_modules (nested structure from Turbopack)
  const standaloneDir = path.join(appRoot, 'standalone')
  if (fs.existsSync(standaloneDir)) {
    try {
      for (const e of fs.readdirSync(standaloneDir, { withFileTypes: true })) {
        if (e.isDirectory()) candidates.push(path.join(standaloneDir, e.name, 'node_modules'))
      }
    } catch {}
  }
  for (const r of candidates) {
    if (fs.existsSync(path.join(r, '.prisma', 'client', 'index.js'))) return r
  }
  return null
}

function initDatabase(dbPath: string, appRoot: string): void {
  const initScript = path.join(appRoot, 'init-db.js')
  if (!fs.existsSync(initScript)) {
    console.error('[client] init-db.js not found — skipping DB init')
    return
  }
  const moduleRoot = findStandaloneModules(appRoot)
  if (!moduleRoot) {
    console.error('[client] Standalone .prisma/client not found — skipping DB init')
    return
  }
  try {
    execSync(
      `"${getNodeBin()}" "${initScript}" "file:${dbPath}" "${moduleRoot}"`,
      { env: process.env, cwd: appRoot, stdio: 'pipe' }
    )
    console.log('[client] Database ready.')
  } catch (err) {
    console.error('[client] initDatabase error:', err)
  }
}

async function startLocalServer(): Promise<void> {
  if (serverProcess) {
    if (!localServerReady) {
      localServerReady = await waitForLocalServerReady(actualLocalPort, 5000)
    }
    return
  }

  localServerReady = false
  actualLocalPort = await findFreePort(LOCAL_PORT_HINT)
  actualBackendPort = await findFreePort(actualLocalPort + 1)
  console.log(`[client] Public server port: ${actualLocalPort}`)
  console.log(`[client] Internal HTTP port: ${actualBackendPort}`)

  const appRoot = getAppRoot()
  const userData = getUserData()

  let databaseUrl: string
  if (app.isPackaged) {
    const dbPath = path.join(userData, 'game.db')
    fs.mkdirSync(userData, { recursive: true })
    try { initDatabase(dbPath, appRoot) } catch {}
    databaseUrl = `file:${dbPath}`
  } else {
    databaseUrl = `file:${path.join(appRoot, 'prisma', 'dev.db')}`
  }

  const serverEntry = findServerEntry(appRoot)
  if (!serverEntry) {
    console.warn('[client] server.js not found, offline mode unavailable')
    localServerReady = false
    return
  }

  // 为 WebSocket 服务器找一个独立的空闲端口（避开主端口和 QMUpload 占用区间）
  actualWsPort = await findFreePort(actualBackendPort + 1)
  console.log(`[client] WebSocket port: ${actualWsPort}`)

  serverProcess = spawn(getNodeBin(), [serverEntry], {
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      PORT: String(actualBackendPort),
      WS_PORT: String(actualWsPort),
      NODE_ENV: 'production',
      APP_ROOT_DIR: appRoot,
      USER_DATA_DIR: userData,
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  lastServerExitCode = null
  lastServerStderr = ''

  serverProcess.stdout?.on('data', (d) => process.stdout.write(d))
  serverProcess.stderr?.on('data', (d) => {
    process.stderr.write(d)
    lastServerStderr = (lastServerStderr + d.toString()).slice(-3000)
  })

  serverProcess.on('error', (err) => console.error('[client] server error:', err))
  serverProcess.on('exit', (code) => {
    lastServerExitCode = code
    serverProcess = null
    localServerReady = false
    console.log(`[client] local server exited: ${code}`)
    if (lastServerStderr) console.error('[client] last stderr:', lastServerStderr.slice(-500))
  })

  // 等待服务器启动
  const backendReady = await waitForLocalServerReady(actualBackendPort)
  if (!backendReady) {
    localServerReady = false
    console.warn(`[client] local server did not become ready on port ${actualBackendPort}`)
    return
  }

  try {
    await startPublicGateway(actualLocalPort, actualBackendPort, actualWsPort)
    localServerReady = await waitForLocalServerReady(actualLocalPort, 5000)
  } catch (err) {
    localServerReady = false
    console.error('[client] public gateway failed:', err)
  }
  if (!localServerReady) {
    console.warn(`[client] public gateway did not become ready on port ${actualLocalPort}`)
  }
}

// ─── 资源包管理（Electron IPC，替代 Android 端的 Service Worker 方案）────────

async function setupPackProtocol(): Promise<void> {
  await session.defaultSession.protocol.handle(CLIENT_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname !== 'app') return new Response('Not found', { status: 404 })
      const decodedPath = decodeURIComponent(requestUrl.pathname)
      if (decodedPath.includes('\\') || decodedPath.includes('\0')) return new Response('Not found', { status: 404 })
      const segments = decodedPath.replace(/^\/+/, '').split('/')
      if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        return new Response('Not found', { status: 404 })
      }
      const relativePath = segments.join('/')
      const target = resolveClientProtocolFile({
        relativePath,
        htmlRoot: getHtmlRoot(),
        appRoot: getAppRoot(),
        activePackRoot: isActivatableResourcePackPath(relativePath)
          ? resolveActiveResourcePackRoot(getPackRoot())
          : null,
        isPackaged: app.isPackaged,
      })
      if (!target) return new Response('Not found', { status: 404 })
      return electronNet.fetch(pathToFileURL(target).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** IPC: import one complete archive into an isolated immutable version. */
handleTrusted('pack-import-from-path', ['game'], async (_e, zipPath: string) => {
  try {
    const result = importResourcePackFromPath(getPackRoot(), zipPath)
    return { ok: true, count: result.count, meta: result.meta }
  } catch (e) {
    console.error('[pack-import] Failed:', e)
    return { ok: false, error: String(e) }
  }
})

handleTrusted('pack-import-data', ['game'], async (_e, base64Data: string) => {
  try {
    const maxBase64Length = Math.ceil(RESOURCE_PACK_LIMITS.maxArchiveBytes / 3) * 4 + 4
    if (typeof base64Data !== 'string' || base64Data.length > maxBase64Length) {
      throw new Error('Resource-pack compressed archive exceeds the 32 MiB limit')
    }
    const result = importResourcePackArchive(getPackRoot(), Buffer.from(base64Data, 'base64'))
    return { ok: true, count: result.count, meta: result.meta }
  } catch (e) {
    console.error('[pack-import] Failed:', e)
    return { ok: false, error: String(e) }
  }
})

/** IPC: reset activation to built-in assets while retaining immutable versions. */
handleTrusted('pack-clear', ['game'], async () => {
  clearActiveResourcePack(getPackRoot())
  return { ok: true }
})

/** IPC: 列出当前资源包中的所有文件路径 */
handleTrusted('pack-list', ['game'], async () => {
  return {
    ok: true,
    files: listActiveResourcePackFiles(getPackRoot()),
    meta: getActiveResourcePackMeta(getPackRoot()),
  }
})

// ─── 游戏窗口 ─────────────────────────────────────────────────────────────────

let mainWin: BrowserWindow | null = null

function createGameWindow(): BrowserWindow {
  if (mainWin && !mainWin.isDestroyed()) mainWin.close()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'RED vs BLUE',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  restrictWindowNavigation(win, isGameClientUrl)
  win.setMenuBarVisibility(false)

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12') win.webContents.openDevTools()
  })

  mainWin = win
  return win
}

let adminWin: BrowserWindow | null = null

function openAdminWindow(): void {
  if (adminWin && !adminWin.isDestroyed()) {
    adminWin.focus()
    return
  }
  const win = new BrowserWindow({
    width: 500,
    height: 700,
    title: '服务器管理',
    parent: mainWin || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const adminPath = path.join(getAdminRoot(), 'index.html')
  restrictWindowNavigation(win, (url) => isFileUrlWithinRoot(url, getAdminRoot()))
  win.loadURL(`file:///${adminPath.replace(/\\/g, '/')}?v=${Date.now()}`)
  adminWin = win
  win.on('closed', () => { adminWin = null })
}

function loadLocalGame(): void {
  const win = createGameWindow()
  win.loadURL(`${CLIENT_SCHEME}://app/index.html?v=${Date.now()}`)

  // 仅当本地服务器实际启动后，才注入默认服务器 URL（once：只注入一次，不影响后续页面导航）
  win.webContents.once('did-finish-load', () => {
    if (!serverProcess || !localServerReady) return
    win.webContents.executeJavaScript(`
      (function() {
        var url = 'http://localhost:${actualLocalPort}';
        if (window.RvBUtils && RvBUtils.saveServerConfig) {
          RvBUtils.saveServerConfig({ mode: 'local', url: url, wsPort: ${actualLocalPort} });
        } else {
          localStorage.setItem('rvb_server_url', url);
          localStorage.setItem('rvb_lobby_server_mode', 'local');
          localStorage.setItem('rvb_local_server_url', url);
          localStorage.setItem('rvb_remote_server_url', url);
          localStorage.setItem('rvb_ws_port', '${actualLocalPort}');
        }
        if (typeof updateFloatBar === 'function') updateFloatBar();
        if (typeof refreshUserUI === 'function') refreshUserUI();
      })();
    `)
  })
}

function loadOnlineGame(serverUrl: string): void {
  const win = createGameWindow()
  win.loadURL(`${CLIENT_SCHEME}://app/index.html?v=${Date.now()}`)

  // once：只在首次加载 index.html 时注入，不覆盖用户后续切换 LAN/本机模式时的地址
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (function() {
        var url = ${JSON.stringify(serverUrl)};
        if (window.RvBUtils && RvBUtils.saveServerConfig) {
          RvBUtils.saveServerConfig({ mode: 'remote', url: url });
        } else {
          localStorage.setItem('rvb_server_url', url);
          localStorage.setItem('rvb_lobby_server_mode', 'remote');
          localStorage.setItem('rvb_remote_server_url', url);
        }
        if (typeof updateFloatBar === 'function') updateFloatBar();
        if (typeof refreshUserUI === 'function') refreshUserUI();
      })();
    `)
  })
}

let connectWin: BrowserWindow | null = null

function openConnectWindow(): void {
  if (connectWin && !connectWin.isDestroyed()) {
    connectWin.focus()
    return
  }
  const win = new BrowserWindow({
    width: 500,
    height: 400,
    title: '连接服务器',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const connectPath = path.join(getConnectRoot(), 'index.html')
  restrictWindowNavigation(win, (url) => isFileUrlWithinRoot(url, getConnectRoot()))
  win.loadURL(`file:///${connectPath.replace(/\\/g, '/')}?v=${Date.now()}`)
  connectWin = win
  win.on('closed', () => { connectWin = null })
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

// 读取已保存的远程服务器地址（UI 初始化时调用）
handleTrusted('get-remote-url', ['connect'], () => getOnlineServerUrl())

// 保存远程服务器地址（连接成功后调用，不跳转页面）
handleTrusted('set-remote-url', ['connect', 'game'], (_e, url: string) => {
  saveOnlineServerUrl(url)
})

// 连接服务器并在新窗口中打开游戏
handleTrusted('connect-server', ['connect'], async (_e, url: string) => {
  saveOnlineServerUrl(url)
  // 关闭连接窗口，打开游戏窗口
  if (connectWin && !connectWin.isDestroyed()) {
    connectWin.close()
    connectWin = null
  }
  loadOnlineGame(url)
  return { ok: true }
})

// 清除远程服务器地址
handleTrusted('clear-remote-url', ['connect', 'game'], () => {
  clearOnlineServerUrl()
})

// 返回离线模式
handleTrusted('go-offline', ['connect', 'game'], () => {
  clearOnlineServerUrl()
})

handleTrusted('open-local-game', ['connect'], async () => {
  clearOnlineServerUrl()
  await startLocalServer()
  if (!localServerReady) {
    const exitMsg = lastServerExitCode !== null
      ? `Local server exited with code ${lastServerExitCode}`
      : 'Local server did not become ready'
    const detail = lastServerStderr ? '\n' + lastServerStderr.slice(-500) : ''
    return { ok: false, error: exitMsg + detail }
  }
  if (connectWin && !connectWin.isDestroyed()) {
    connectWin.close()
    connectWin = null
  }
  loadLocalGame()
  return { ok: true }
})

// 查询当前模式
handleTrusted('get-mode', ['game'], () => ({
  isLocal: localServerReady,
  localUrl: `http://localhost:${actualLocalPort}`,
  wsPort: actualLocalPort,
  ready: localServerReady,
}))

// 重启本地服务器
handleTrusted('restart-server', ['admin'], async () => {
  killServer()
  await new Promise(resolve => setTimeout(resolve, 1000))
  await startLocalServer()
  return { ok: true }
})

// 获取本机局域网 IPv4 地址列表（供 LAN 扫描定位子网）
handleTrusted('get-lan-ips', ['game'], () => {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
})

// 获取主机信息（端口 + LAN IP 列表），供"我当主机"功能使用
handleTrusted('get-host-info', ['game'], () => {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return { port: actualLocalPort, wsPort: actualLocalPort, ips, running: serverProcess !== null && localServerReady, ready: localServerReady }
})

// ─── UDP LAN 主机广播与发现 ───────────────────────────────────────────────────

const DISCOVERY_PORT = 7877

function getLanIpList(): string[] {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
}

let broadcastSocket: dgram.Socket | null = null
let broadcastTimer: NodeJS.Timeout | null = null

handleTrusted('start-host-broadcast', ['game'], () => {
  // 停掉旧的
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (broadcastSocket) { try { broadcastSocket.close() } catch {} broadcastSocket = null }

  const myIps = getLanIpList()
  const hostname = os.hostname()
  const port = actualLocalPort
  const wsPort = actualLocalPort

  const send = () => {
    for (const ip of myIps) {
      const payload = JSON.stringify({ magic: 'RVB_DISCOVER', name: hostname, ip, port, wsPort })
      const buf = Buffer.from(payload)
      const subnet = ip.substring(0, ip.lastIndexOf('.') + 1) + '255'
      for (const target of [subnet, '255.255.255.255']) {
        try {
          const sock = dgram.createSocket('udp4')
          sock.bind(() => {
            sock.setBroadcast(true)
            sock.send(buf, 0, buf.length, DISCOVERY_PORT, target, () => sock.close())
          })
        } catch {}
      }
    }
  }
  send()
  broadcastTimer = setInterval(send, 2000)
  return { ok: true }
})

handleTrusted('stop-host-broadcast', ['game'], () => {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (broadcastSocket) { try { broadcastSocket.close() } catch {} broadcastSocket = null }
  return { ok: true }
})

// 发现主机：监听 UDP 广播 timeoutMs 毫秒，通过 webContents.send 推送结果
handleTrusted('start-discover-hosts', ['game'], (event, timeoutMs: number) => {
  const timeout = timeoutMs > 0 ? timeoutMs : 3000
  const sender = event.sender

  const seen = new Set<string>()
  let sock: dgram.Socket | null = null
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    sock.bind(DISCOVERY_PORT, () => {
      try { sock!.setBroadcast(true) } catch {}
    })
    sock.on('message', (msg) => {
      try {
        const info = JSON.parse(msg.toString('utf8'))
        if (info.magic !== 'RVB_DISCOVER') return
        const key = info.ip + ':' + info.port
        if (seen.has(key)) return
        seen.add(key)
        if (!sender.isDestroyed()) sender.send('udp-host-found', info)
      } catch {}
    })
    sock.on('error', () => { try { sock!.close() } catch {} })
  } catch { return { ok: false } }

  setTimeout(() => {
    try { sock!.close() } catch {}
    if (!sender.isDestroyed()) sender.send('udp-discovery-done')
  }, timeout)

  return { ok: true }
})

// 资源包状态
handleTrusted('get-resource-pack-status', ['admin'], async () => {
  try {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${actualLocalPort}/api/admin/resource-pack`, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ error: 'Parse error' }) }
        })
      })
      req.on('error', () => resolve({ error: 'Server not running' }))
      req.setTimeout(3000, () => { req.destroy(); resolve({ error: 'Timeout' }) })
    })
  } catch { return { error: 'Failed' } }
})

// 资源包上传（文件路径）
handleTrusted('upload-resource-pack', ['admin'], async (_event, filePath: string) => {
  try {
    const boundary = '----FormBoundary' + Date.now()
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
      throw new Error('Resource-pack compressed archive is empty or exceeds 32 MiB')
    }
    const fileContent = fs.readFileSync(filePath)
    const filename = (filePath.split(/[\\/]/).pop() || 'resource-pack.zip').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`
    )
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([header, fileContent, footer])

    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: actualLocalPort,
        path: '/api/admin/resource-pack/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-admin-key': 'admin-secret-key',
          'Content-Length': body.length,
        }
      }, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ success: false, message: 'Parse error' }) }
        })
      })
      req.on('error', (e: Error) => resolve({ success: false, message: e.message }))
      req.write(body)
      req.end()
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, message }
  }
})

// 资源包上传（base64 数据）
handleTrusted('upload-resource-pack-data', ['admin'], async (_event, base64: string, filename: string) => {
  try {
    const maxBase64Length = Math.ceil(RESOURCE_PACK_LIMITS.maxArchiveBytes / 3) * 4 + 4
    if (typeof base64 !== 'string' || base64.length > maxBase64Length) {
      throw new Error('Resource-pack compressed archive exceeds the 32 MiB limit')
    }
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length === 0 || buffer.length > RESOURCE_PACK_LIMITS.maxArchiveBytes) {
      throw new Error('Resource-pack compressed archive is empty or exceeds 32 MiB')
    }
    const safeFilename = String(filename || 'resource-pack.zip').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
    const boundary = '----FormBoundary' + Date.now()

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/zip\r\n\r\n`
    )
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
    const body = Buffer.concat([header, buffer, footer])

    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: actualLocalPort,
        path: '/api/admin/resource-pack/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-admin-key': 'admin-secret-key',
          'Content-Length': body.length,
        }
      }, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ success: false, message: 'Parse error' }) }
        })
      })
      req.on('error', (e: Error) => resolve({ success: false, message: e.message }))
      req.write(body)
      req.end()
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { success: false, message }
  }
})

// Bypass system proxy (Clash/V2Ray/etc.) — game server is accessed directly via frp
app.commandLine.appendSwitch('no-proxy-server')
// Disable disk cache so Chromium never serves stale file:// responses
app.commandLine.appendSwitch('disable-http-cache')

// ─── 应用生命周期 ─────────────────────────────────────────────────────────────

// 防止双开：第二个实例启动会立即退出，并让第一个实例聚焦窗口。
// 这是避免"关掉一个窗口还有一堆 RED vs BLUE 进程留下"的根本之策——
// 之前可能因为偶然双击双开累积了多份 Electron + Node 子进程。
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
}

// 主进程异常退出兜底——保证 Node 子进程不会成为孤儿进程
process.on('exit', () => { try { killServer() } catch {} })
process.on('SIGINT', () => { try { killServer() } catch {} ; app.exit(0) })
process.on('SIGTERM', () => { try { killServer() } catch {} ; app.exit(0) })

app.whenReady().then(async () => {
  await setupPackProtocol()
  // 启动时清除上一版本残留的 Service Worker / Cache Storage，避免旧缓存遮蔽新页面
  try {
    await session.defaultSession.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    })
    console.log('[client] Cleared service worker + cache storage on startup')
  } catch (e) {
    console.warn('[client] Failed to clear SW/cache storage:', e)
  }

  await startLocalServer()
  // 暂时强制使用本地服务器，跳过在线服务器
  openConnectWindow()
  // const savedUrl = getOnlineServerUrl()
  // if (savedUrl) {
  //   loadOnlineGame(savedUrl)
  // } else {
  //   openConnectWindow()
  // }
})

app.on('window-all-closed', () => {
  killServer()
  if (process.platform !== 'darwin') {
    app.quit()
    // 兜底：如果 app.quit() 因某种原因没让所有子进程退出，1.5s 后强制 exit。
    setTimeout(() => app.exit(0), 1500).unref()
  }
})

app.on('before-quit', () => killServer())

// 关键兜底：所有窗口都关闭、quit 完成后强制退出主进程，
// 杜绝 Electron GPU/renderer/utility 子进程残留。
app.on('quit', () => { try { process.exit(0) } catch {} })

app.on('activate', () => {
  if (!mainWin || mainWin.isDestroyed()) loadLocalGame()
})
