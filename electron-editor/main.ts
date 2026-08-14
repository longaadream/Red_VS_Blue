import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'

// ─── 路径工具 ─────────────────────────────────────────────────────────────────

function getProjectRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app')
  }
  // electron-editor/dist/main.js → ../../ = project root
  return path.join(__dirname, '..', '..')
}

function getDataRoot(): string {
  return path.join(getProjectRoot(), 'data')
}

function restrictWindowNavigation(browserWindow: BrowserWindow, allowedRoot: string): void {
  const resolvedRoot = path.resolve(allowedRoot)
  const isAllowed = (rawUrl: string): boolean => {
    try {
      const url = new URL(rawUrl)
      if (url.protocol !== 'file:') return false
      const target = path.resolve(fileURLToPath(url))
      return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep)
    } catch {
      return false
    }
  }

  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

// ─── 安全校验 ─────────────────────────────────────────────────────────────────

const SAFE_NAME = /^[a-zA-Z0-9_\-]+\.json$/

function safePath(subdir: string, filename: string): string {
  if (!SAFE_NAME.test(filename)) throw new Error('Invalid filename: ' + filename)
  if (!/^[a-zA-Z0-9_\-/]+$/.test(subdir)) throw new Error('Invalid subdir: ' + subdir)
  const full = path.resolve(path.join(getDataRoot(), subdir, filename))
  const root = path.resolve(getDataRoot())
  if (!full.startsWith(root + path.sep) && !full.startsWith(root)) {
    throw new Error('Path traversal denied')
  }
  return full
}

// ─── 窗口 ─────────────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'RED vs BLUE — 数据编辑器',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const uiRoot = path.join(__dirname, '..', 'ui')
  restrictWindowNavigation(win, uiRoot)
  win.loadFile(path.join(uiRoot, 'index.html'))
  win.setMenu(null)
  // win.webContents.openDevTools()
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!win || win.isDestroyed()) createWindow() })

// ─── IPC: 文件列表 ─────────────────────────────────────────────────────────────

ipcMain.handle('list-files', (_e, subdir: string) => {
  if (!/^[a-zA-Z0-9_\-/]+$/.test(subdir)) return []
  const dir = path.join(getDataRoot(), subdir)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ filename: f, id: f.replace(/\.json$/, '') }))
})

// ─── IPC: 读取文件 ─────────────────────────────────────────────────────────────

ipcMain.handle('read-file', (_e, subdir: string, filename: string) => {
  const file = safePath(subdir, filename)
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file)
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
})

// ─── IPC: 写入文件 ─────────────────────────────────────────────────────────────

ipcMain.handle('write-file', (_e, subdir: string, filename: string, data: unknown) => {
  const file = safePath(subdir, filename)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  return { ok: true }
})

// ─── IPC: 在系统编辑器中打开 ───────────────────────────────────────────────────

ipcMain.handle('open-in-editor', (_e, subdir: string, filename: string) => {
  const file = safePath(subdir, filename)
  return shell.openPath(file)
})

// ─── IPC: 运行构建脚本（流式输出） ─────────────────────────────────────────────

ipcMain.handle('run-build', (event, args: { name: string; version: string; desc: string }) => {
  const projectRoot = getProjectRoot()
  const scriptPath = path.join(projectRoot, 'scripts', 'build-resource-pack.js')

  const push = (line: string) => event.sender.send('build-output', { line })

  if (!fs.existsSync(scriptPath)) {
    push(`[错误] 找不到构建脚本: ${scriptPath}`)
    event.sender.send('build-output', { done: true, exitCode: 1 })
    return
  }

  // Validate args (only alphanum + hyphen, limited length)
  const safeName    = (args.name    || 'editor-build').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 50) || 'editor-build'
  const safeVersion = (args.version || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 50)
  const safeDesc    = (args.desc    || '').replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 200)

  const child = spawn(
    'node',
    [scriptPath, '--name', safeName, '--version', safeVersion, '--desc', safeDesc],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  )

  child.stdout.on('data', (d: Buffer) => {
    d.toString().split('\n').forEach(l => l.trim() && push(l))
  })
  child.stderr.on('data', (d: Buffer) => {
    d.toString().split('\n').forEach(l => l.trim() && push('[stderr] ' + l))
  })
  child.on('close', (code: number | null) => {
    event.sender.send('build-output', { done: true, exitCode: code ?? -1 })
  })
  child.on('error', (err: Error) => {
    push(`[错误] ${err.message}`)
    event.sender.send('build-output', { done: true, exitCode: -1 })
  })
})
