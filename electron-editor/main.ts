import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, utilityProcess } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import {
  EditorContentOperationQueueV1,
  normalizeEditorContentOperationRequestV1,
  resolveEditorDataDirectoryV1,
  resolveEditorDataFilePathV1,
} from './content-pipeline-ipc'
import {
  importAssetV1,
  listAssetsV1,
  listPveJsonV1,
  prepareWorkspacePackageV1,
  readAssetDataUrlV1,
  readPveJsonV1,
  writePveJsonV1,
} from './workspace'

// ─── 路径工具 ─────────────────────────────────────────────────────────────────

function getProjectRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app')
  }
  // electron-editor/dist/main.js → ../../ = project root
  return path.join(__dirname, '..', '..')
}

function getDataRoot(): string {
  return path.join(ensureAuthoringWorkspace(), 'data')
}

function getAuthoringRoot(): string {
  return path.join(app.getPath('userData'), 'content-authoring')
}

function ensureAuthoringWorkspace(): string {
  const workspace = getAuthoringRoot()
  const data = path.join(workspace, 'data')
  if (!fs.existsSync(data)) {
    fs.mkdirSync(workspace, { recursive: true })
    fs.cpSync(path.join(getProjectRoot(), 'data'), data, {
      recursive: true,
      errorOnExist: false,
      force: false,
    })
  }
  const images = path.join(workspace, 'images')
  const bundledImages = path.join(getProjectRoot(), 'public', 'images')
  if (!fs.existsSync(images)) {
    fs.mkdirSync(images, { recursive: true })
    if (fs.existsSync(bundledImages)) fs.cpSync(bundledImages, images, {
      recursive: true,
      errorOnExist: false,
      force: false,
    })
  }
  for (const directory of ['archives', 'keys', 'reports', 'sources']) {
    fs.mkdirSync(path.join(workspace, directory), { recursive: true })
  }
  return workspace
}

function getEditorUiRoot(): string {
  return path.join(__dirname, '..', 'ui')
}

function restrictWindowNavigation(browserWindow: BrowserWindow, allowedRoot: string): void {
  const isAllowed = (rawUrl: string): boolean => isFileUrlWithinRoot(rawUrl, allowedRoot)

  browserWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  browserWindow.webContents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame || !isAllowed(details.url)) details.preventDefault()
  })
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

// ─── 安全校验 ─────────────────────────────────────────────────────────────────

function safePath(
  subdir: string,
  filename: string,
  intent: 'read' | 'write' = 'read',
): string {
  return resolveEditorDataFilePathV1(getDataRoot(), subdir, filename, intent)
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
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const uiRoot = getEditorUiRoot()
  restrictWindowNavigation(win, uiRoot)
  win.loadFile(path.join(uiRoot, 'index.html'))
  win.setMenu(null)
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  ensureAuthoringWorkspace()
  createWindow()
})
app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!win || win.isDestroyed()) createWindow() })

function handleTrusted(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, channel, [{
      role: 'editor',
      window: win,
      allowUrl: (rawUrl) => isFileUrlWithinRoot(rawUrl, getEditorUiRoot()),
    }])
    return listener(event, ...args)
  })
}

// ─── IPC: 文件列表 ─────────────────────────────────────────────────────────────

handleTrusted('list-files', (_e, subdir: string) => {
  let dir: string
  try {
    dir = resolveEditorDataDirectoryV1(getDataRoot(), subdir)
  } catch {
    return []
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ filename: f, id: f.replace(/\.json$/, '') }))
})

// ─── IPC: 读取文件 ─────────────────────────────────────────────────────────────

handleTrusted('read-file', (_e, subdir: string, filename: string) => {
  const file = safePath(subdir, filename)
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file)
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
})

// ─── IPC: 写入文件 ─────────────────────────────────────────────────────────────

handleTrusted('write-file', (_e, subdir: string, filename: string, data: unknown) => {
  const file = safePath(subdir, filename, 'write')
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  return { ok: true }
})

// ─── IPC: 创建文件并登记 manifest ──────────────────────────────────────────────

handleTrusted('create-file', (_e, subdir: string, id: string, data: unknown) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('ID 只能包含小写字母、数字和单个连字符')
  }
  if (!data || Array.isArray(data) || typeof data !== 'object' || (data as { id?: unknown }).id !== id) {
    throw new Error('JSON 的 id 必须与文件 ID 完全一致')
  }

  const file = safePath(subdir, `${id}.json`, 'write')
  const manifestFile = safePath(subdir, 'manifest.json', 'write')
  if (fs.existsSync(file)) throw new Error(`文件已存在: ${id}.json`)

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as unknown
  if (!Array.isArray(manifest) || !manifest.every(value => typeof value === 'string')) {
    throw new Error('manifest.json 必须是字符串数组')
  }
  if (manifest.includes(id)) throw new Error(`manifest 已包含 ID: ${id}`)

  const nextManifest = [...manifest, id].sort()
  let created = false
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' })
    created = true
    fs.writeFileSync(manifestFile, JSON.stringify(nextManifest, null, 2) + '\n', 'utf-8')
  } catch (error) {
    if (created && fs.existsSync(file)) fs.unlinkSync(file)
    throw error
  }
  return { ok: true, filename: `${id}.json` }
})

// ─── IPC: 在系统编辑器中打开 ───────────────────────────────────────────────────

handleTrusted('open-in-editor', (_e, subdir: string, filename: string) => {
  const file = safePath(subdir, filename)
  return shell.openPath(file)
})

// ─── IPC: PVE JSON 与静态图片资源 ─────────────────────────────────────────────

handleTrusted('list-pve-files', () => listPveJsonV1(ensureAuthoringWorkspace()))

handleTrusted('read-pve-file', (_e, relativePath: string) =>
  readPveJsonV1(ensureAuthoringWorkspace(), relativePath))

handleTrusted('write-pve-file', (_e, relativePath: string, data: unknown) => {
  writePveJsonV1(ensureAuthoringWorkspace(), relativePath, data)
  return { ok: true }
})

handleTrusted('open-pve-in-editor', (_e, relativePath: string) => {
  readPveJsonV1(ensureAuthoringWorkspace(), relativePath)
  return shell.openPath(path.join(getAuthoringRoot(), 'data', 'pve', ...relativePath.split('/')))
})

handleTrusted('list-assets', () => listAssetsV1(ensureAuthoringWorkspace()))

handleTrusted('read-asset', (_e, relativePath: string) =>
  readAssetDataUrlV1(ensureAuthoringWorkspace(), relativePath))

handleTrusted('import-asset', async (_e, destinationPath: string, replace = false) => {
  if (!win) throw new Error('Editor window unavailable')
  const selection = await dialog.showOpenDialog(win, {
    title: replace ? '选择替换图片' : '导入图片资源',
    properties: ['openFile'],
    filters: [{ name: '静态图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }],
  })
  if (selection.canceled || selection.filePaths.length !== 1) return { canceled: true }
  const source = selection.filePaths[0]
  const destination = destinationPath || path.basename(source)
  return { canceled: false, file: importAssetV1(getAuthoringRoot(), source, destination, replace) }
})

handleTrusted('copy-text', (_e, value: string) => {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid clipboard text')
  clipboard.writeText(value)
  return { ok: true }
})

handleTrusted('prepare-workspace-package', () =>
  prepareWorkspacePackageV1(ensureAuthoringWorkspace(), getProjectRoot()))

// ─── IPC: 规范化内容操作 → 自包含 worker ─────────────────────────────────────

function runContentWorker(request: unknown): Promise<unknown> {
  const workerPath = path.join(__dirname, 'content-pipeline-worker.cjs')
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'RVB Content Pipeline',
    })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('CONTENT_WORKER_TIMEOUT'))
    }, 10 * 60 * 1000)
    child.once('message', (message: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      const envelope = message as { ok?: boolean; result?: unknown; error?: string }
      if (envelope?.ok === true) resolve(envelope.result)
      else reject(new Error(envelope?.error || 'CONTENT_WORKER_FAILED'))
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`CONTENT_WORKER_EXIT_${code}`))
    })
    child.postMessage(request)
  })
}

const contentOperationQueue = new EditorContentOperationQueueV1()

handleTrusted('content-operation', (_event, rawRequest: unknown) => {
  const workspace = ensureAuthoringWorkspace()
  const request = normalizeEditorContentOperationRequestV1(
    workspace,
    getProjectRoot(),
    rawRequest,
  )
  return contentOperationQueue.enqueue(() => runContentWorker(request))
})
