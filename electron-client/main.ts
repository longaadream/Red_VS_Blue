import { app, BrowserWindow, ipcMain, session } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as zlib from 'zlib'
import * as os from 'os'
import * as net from 'net'
import * as dgram from 'dgram'
import * as http from 'http'

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const LOCAL_PORT_HINT = 38521  // 首选端口，被占用时自动递增（避开 54300-54400 被 QMUpload 占用的范围）
let actualLocalPort = LOCAL_PORT_HINT  // 实际绑定成功的端口

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(start, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
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
    : path.join(__dirname, '../../android-client/www')
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

// ─── 本地服务器管理 ───────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null
let localServerReady = false

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
      if (Date.now() >= deadline) {
        finish(false)
        return
      }
      setTimeout(probe, 250)
    }

    const probe = () => {
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
  console.log(`[client] Local server port: ${actualLocalPort}`)

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

  // 如果用户已导入资源包且包内含有 data/ 目录，优先从资源包加载游戏数据
  const packDataDir = path.join(getPackRoot(), 'data')
  const usePackData = fs.existsSync(packDataDir)

  serverProcess = spawn(getNodeBin(), [serverEntry], {
    env: {
      ...process.env,
      PORT: String(actualLocalPort),
      DISABLE_WS: '1',
      NODE_ENV: 'production',
      APP_ROOT_DIR: appRoot,
      USER_DATA_DIR: userData,
      DATABASE_URL: databaseUrl,
      ...(usePackData ? { RESOURCE_PACK_DATA_DIR: packDataDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout?.on('data', (d) => process.stdout.write(d))
  serverProcess.stderr?.on('data', (d) => process.stderr.write(d))

  serverProcess.on('error', (err) => console.error('[client] server error:', err))
  serverProcess.on('exit', (code) => {
    serverProcess = null
    localServerReady = false
    console.log(`[client] local server exited: ${code}`)
  })

  // 等待服务器启动
  localServerReady = await waitForLocalServerReady(actualLocalPort)
  if (!localServerReady) {
    console.warn(`[client] local server did not become ready on port ${actualLocalPort}`)
  }
}

// ─── 资源包管理（Electron IPC，替代 Android 端的 Service Worker 方案）────────

/** 资源包直接写入 htmlRoot，无需 protocol 拦截 — 此函数保留为空壳供将来扩展 */
function setupPackProtocol(): void {
  // Direct-write approach: pack files are written straight into getHtmlRoot()
  // on import, so no file:// interception is needed.
}

/** IPC: 收到 ZIP 文件路径，直接解压到 htmlRoot 目录（覆盖同名文件）*/
ipcMain.handle('pack-import-from-path', async (_e, zipPath: string) => {
  const htmlRoot = getHtmlRoot()
  fs.mkdirSync(htmlRoot, { recursive: true })

  try {
    // 使用 adm-zip 库解压（更可靠）
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(zipPath)
    const zipEntries = zip.getEntries()
    let count = 0
    const resolvedHtmlRoot = path.resolve(htmlRoot)

    // 先从 ZIP 读取 pack.json 元数据
    let meta: Record<string, unknown> = {}
    const packJsonEntry = zip.getEntry('pack.json')
    if (packJsonEntry) {
      try {
        meta = JSON.parse(packJsonEntry.getData().toString('utf-8'))
      } catch (e) {
        console.error('[pack-import] Failed to parse pack.json:', e)
      }
    }

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue

      const entryName = entry.entryName
      // 跳过 resource-pack 根目录，直接解压其内容
      const rel = entryName.replace(/^resource-pack\//, '').replace(/^\/+/, '')
      // 跳过元数据文件，不写入 www 目录
      if (!rel || rel === 'pack.json') continue

      const dest = path.join(htmlRoot, rel)

      // 安全检查：防止路径穿越
      if (!path.resolve(dest).startsWith(resolvedHtmlRoot)) {
        console.warn('[pack-import] Skipping unsafe path:', entryName)
        continue
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true })
      zip.extractEntryTo(entry, path.dirname(dest), false, true)
      count++
    }

    console.log(`[pack-import] Extracted ${count} files to ${htmlRoot}`)
    return { ok: true, count, meta }
  } catch (e) {
    console.error('[pack-import] Failed:', e)
    return { ok: false, error: String(e) }
  }
})

/** IPC: 将解压好的资源包文件直接写入 htmlRoot（备用：URL 下载等无本地路径场景）*/
ipcMain.handle('pack-write-files', async (_e, files: { path: string; content: string }[]) => {
  const htmlRoot = getHtmlRoot()
  const resolvedHtmlRoot = path.resolve(htmlRoot)
  let count = 0
  for (const { path: filePath, content } of files) {
    const rel = filePath.startsWith('/') ? filePath.slice(1) : filePath
    const dest = path.join(htmlRoot, rel)
    if (!path.resolve(dest).startsWith(resolvedHtmlRoot)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from(content, 'base64'))
    count++
  }
  return { ok: true, count }
})

/** IPC: 清除整个资源包 */
ipcMain.handle('pack-clear', async () => {
  const packRoot = getPackRoot()
  if (fs.existsSync(packRoot)) fs.rmSync(packRoot, { recursive: true, force: true })
  return { ok: true }
})

/** IPC: 列出当前资源包中的所有文件路径 */
ipcMain.handle('pack-list', async () => {
  const packRoot = getPackRoot()
  const files: string[] = []
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push('/' + path.relative(packRoot, full).replace(/\\/g, '/'))
    }
  }
  walk(packRoot)
  return { ok: true, files }
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
      webSecurity: false,
    },
  })

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
      webSecurity: false,
    },
  })
  const adminPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'electron-client', 'admin', 'index.html')
    : path.join(__dirname, '../../electron-client/admin/index.html')
  win.loadURL(`file:///${adminPath.replace(/\\/g, '/')}?v=${Date.now()}`)
  adminWin = win
  win.on('closed', () => { adminWin = null })
}

function loadLocalGame(): void {
  const win = createGameWindow()
  // loadURL with cache-busting param to prevent Chromium from serving stale file:// cache
  const indexPath = path.join(getHtmlRoot(), 'index.html').replace(/\\/g, '/')
  win.loadURL(`file:///${indexPath}?v=${Date.now()}`)

  // 仅当本地服务器实际启动后，才注入默认服务器 URL（once：只注入一次，不影响后续页面导航）
  win.webContents.once('did-finish-load', () => {
    if (!serverProcess || !localServerReady) return
    win.webContents.executeJavaScript(`
      (function() {
        var key = 'rvb_server_url';
        localStorage.setItem(key, 'http://localhost:${actualLocalPort}');
        localStorage.setItem('rvb_remote_server_url', 'http://localhost:${actualLocalPort}');
        if (typeof updateFloatBar === 'function') updateFloatBar();
        if (typeof refreshUserUI === 'function') refreshUserUI();
      })();
    `)
  })
}

function loadOnlineGame(serverUrl: string): void {
  const win = createGameWindow()
  const indexPath = path.join(getHtmlRoot(), 'index.html').replace(/\\/g, '/')
  win.loadURL(`file:///${indexPath}?v=${Date.now()}`)

  // once：只在首次加载 index.html 时注入，不覆盖用户后续切换 LAN/本机模式时的地址
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (function() {
        localStorage.setItem('rvb_server_url', ${JSON.stringify(serverUrl)});
        localStorage.setItem('rvb_remote_server_url', ${JSON.stringify(serverUrl)});
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
      webSecurity: false,
    },
  })
  const connectPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'electron-client', 'connect', 'index.html')
    : path.join(__dirname, '../../electron-client/connect/index.html')
  win.loadURL(`file:///${connectPath.replace(/\\/g, '/')}?v=${Date.now()}`)
  connectWin = win
  win.on('closed', () => { connectWin = null })
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

// 读取已保存的远程服务器地址（UI 初始化时调用）
ipcMain.handle('get-remote-url', () => getOnlineServerUrl())

// 保存远程服务器地址（连接成功后调用，不跳转页面）
ipcMain.handle('set-remote-url', (_e, url: string) => {
  saveOnlineServerUrl(url)
})

// 连接服务器并在新窗口中打开游戏
ipcMain.handle('connect-server', async (_e, url: string) => {
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
ipcMain.handle('clear-remote-url', () => {
  clearOnlineServerUrl()
})

// 返回离线模式
ipcMain.handle('go-offline', () => {
  clearOnlineServerUrl()
})

ipcMain.handle('open-local-game', async () => {
  clearOnlineServerUrl()
  await startLocalServer()
  if (!localServerReady) return { ok: false, error: 'Local server is not ready' }
  if (connectWin && !connectWin.isDestroyed()) {
    connectWin.close()
    connectWin = null
  }
  loadLocalGame()
  return { ok: true }
})

// 查询当前模式
ipcMain.handle('get-mode', () => ({
  isLocal: localServerReady,
  localUrl: `http://localhost:${actualLocalPort}`,
  ready: localServerReady,
}))

// 重启本地服务器
ipcMain.handle('restart-server', async () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
    localServerReady = false
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
  await startLocalServer()
  return { ok: true }
})

// 获取本机局域网 IPv4 地址列表（供 LAN 扫描定位子网）
ipcMain.handle('get-lan-ips', () => {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return ips
})

// 获取主机信息（端口 + LAN IP 列表），供"我当主机"功能使用
ipcMain.handle('get-host-info', () => {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address)
    }
  }
  return { port: actualLocalPort, ips, running: serverProcess !== null && localServerReady, ready: localServerReady }
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

ipcMain.handle('start-host-broadcast', () => {
  // 停掉旧的
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (broadcastSocket) { try { broadcastSocket.close() } catch {} broadcastSocket = null }

  const myIps = getLanIpList()
  const hostname = os.hostname()
  const port = actualLocalPort

  const send = () => {
    for (const ip of myIps) {
      const payload = JSON.stringify({ magic: 'RVB_DISCOVER', name: hostname, ip, port })
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

ipcMain.handle('stop-host-broadcast', () => {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null }
  if (broadcastSocket) { try { broadcastSocket.close() } catch {} broadcastSocket = null }
  return { ok: true }
})

// 发现主机：监听 UDP 广播 timeoutMs 毫秒，通过 webContents.send 推送结果
ipcMain.handle('start-discover-hosts', (_e, timeoutMs: number) => {
  const timeout = timeoutMs > 0 ? timeoutMs : 3000
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return { ok: false }

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
        if (!win.isDestroyed()) win.webContents.send('udp-host-found', info)
      } catch {}
    })
    sock.on('error', () => { try { sock!.close() } catch {} })
  } catch { return { ok: false } }

  setTimeout(() => {
    try { sock!.close() } catch {}
    if (!win.isDestroyed()) win.webContents.send('udp-discovery-done')
  }, timeout)

  return { ok: true }
})

// 资源包状态
ipcMain.handle('get-resource-pack-status', async () => {
  try {
    const http = require('http')
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${actualLocalPort}/api/admin/resource-pack`, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
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
ipcMain.handle('upload-resource-pack', async (_event, filePath) => {
  try {
    const http = require('http')
    const fs = require('fs')
    const boundary = '----FormBoundary' + Date.now()
    const fileContent = fs.readFileSync(filePath)
    const filename = filePath.split(/[\\/]/).pop()

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
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ success: false, message: 'Parse error' }) }
        })
      })
      req.on('error', (e) => resolve({ success: false, message: e.message }))
      req.write(body)
      req.end()
    })
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// 资源包上传（base64 数据）
ipcMain.handle('upload-resource-pack-data', async (_event, base64, filename) => {
  try {
    const http = require('http')
    const buffer = Buffer.from(base64, 'base64')
    const boundary = '----FormBoundary' + Date.now()

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`
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
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ success: false, message: 'Parse error' }) }
        })
      })
      req.on('error', (e) => resolve({ success: false, message: e.message }))
      req.write(body)
      req.end()
    })
  } catch (e) {
    return { success: false, message: e.message }
  }
})

// ─── 证书 ─────────────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('ignore-certificate-errors')
// Bypass system proxy (Clash/V2Ray/etc.) — game server is accessed directly via frp
app.commandLine.appendSwitch('no-proxy-server')
// Disable disk cache so Chromium never serves stale file:// responses
app.commandLine.appendSwitch('disable-http-cache')

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(true)
})

// ─── 应用生命周期 ─────────────────────────────────────────────────────────────

setupPackProtocol()

app.whenReady().then(async () => {
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
  // 检查是否有保存的远程服务器地址
  const savedUrl = getOnlineServerUrl()
  if (savedUrl) {
    // 有保存的地址，直接连接
    loadOnlineGame(savedUrl)
  } else {
    // 没有保存的地址，显示连接页面
    openConnectWindow()
  }
})

app.on('window-all-closed', () => {
  serverProcess?.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => serverProcess?.kill())

app.on('activate', () => {
  if (!mainWin || mainWin.isDestroyed()) loadLocalGame()
})
