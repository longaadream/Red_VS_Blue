import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, utilityProcess } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import { CreativeWorkbench } from './workbench'
import { assertSkillGraphArtifact } from './skill-graph'
import { assertContentProjectRoot, createContentProject, openContentProject, readDocumentSnapshot, writeDocumentSnapshot } from './content-project'
import {
  EditorContentOperationQueueV1,
  normalizeEditorContentOperationRequestV1,
  resolveEditorDataDirectoryV1,
  resolveEditorDataFilePathV1,
  resolveEditorWorkspacePathV1,
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

let selectedProject: string | null = null
function getAuthoringRoot(): string {
  if (selectedProject) assertContentProjectRoot(selectedProject)
  return selectedProject ?? path.join(app.getPath('userData'), 'content-authoring')
}

function ensureAuthoringWorkspace(): string {
  const workspace = getAuthoringRoot()
  if (selectedProject) return workspace
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
    show: !process.argv.includes('--editor-smoke-hidden'),
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
      backgroundThrottling: !process.argv.includes('--editor-smoke-hidden'),
      offscreen: process.argv.includes('--editor-smoke-hidden'),
    },
  })
  const uiRoot = getEditorUiRoot()
  restrictWindowNavigation(win, uiRoot)
  win.loadFile(path.join(uiRoot, 'index.html'))
  win.setMenu(null)
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  const checkIndex = process.argv.indexOf('--check-content-task')
  if (checkIndex !== -1) {
    try {
      const root = process.argv[checkIndex + 1]
      const id = process.argv[checkIndex + 2]
      const result = new CreativeWorkbench(root, getProjectRoot(), editorLauncher()).check(id)
      console.log(JSON.stringify({ taskId: id, contentHash: result.contentHash, check: result.check }))
      app.exit(result.check && !result.check.issues.some(issue => issue.severity === 'error') ? 0 : 1)
    } catch (error) { console.error(String(error)); app.exit(1) }
    return
  }
  const settings = path.join(app.getPath('userData'), 'content-project-selection.json')
  if (fs.existsSync(settings)) {
    try { selectedProject = openContentProject(JSON.parse(fs.readFileSync(settings, 'utf8')).root) }
    catch (error) { dialog.showErrorBox('无法恢复内容项目', String(error) + '\n将打开默认工作区，原项目不会修改。') }
  }
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

handleTrusted('project-info', () => ({ root: ensureAuthoringWorkspace() }))
function editorLauncher() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  return app.isPackaged ? [portable && path.isAbsolute(portable) ? portable : process.execPath] : [process.execPath, path.join(__dirname, 'main.js')]
}
function workbench() { return new CreativeWorkbench(ensureAuthoringWorkspace(), getProjectRoot(), editorLauncher()) }
handleTrusted('source-flow-analyze', (_event, category, document) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- The packaged parser is an explicit local CJS bundle.
  const parser = require('./source-flow.cjs') as typeof import('./source-flow')
  const directory = resolveEditorDataDirectoryV1(getDataRoot(), 'pieces')
  const pieces = fs.readdirSync(directory).filter(file => file.endsWith('.json') && file !== 'manifest.json')
    .map(file => JSON.parse(fs.readFileSync(resolveEditorDataFilePathV1(getDataRoot(), 'pieces', file, 'read'), 'utf8')))
  return parser.analyzeContentFlow(category, document, pieces)
})
handleTrusted('source-flow-edit', (_event, category, document, request) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Same packaged local parser; never evaluates authored code.
  const parser = require('./source-flow.cjs') as typeof import('./source-flow')
  return parser.editFlowNode(category, document, request)
})
handleTrusted('workbench-list', () => workbench().list())
handleTrusted('workbench-create', (_event, input) => workbench().create(input))
handleTrusted('workbench-inspect', (_event, id: string) => workbench().inspect(id))
handleTrusted('workbench-check', (_event, id: string) => workbench().check(id))
handleTrusted('workbench-feedback', (_event, id: string, input) => workbench().feedback(id, input))
handleTrusted('workbench-scenario', (_event, id: string, input) => workbench().scenario(id, input))
handleTrusted('workbench-keep', (_event, id: string, hash: string) => workbench().keep(id, hash))
handleTrusted('workbench-handoff', (_event, id: string) => {
  const result = workbench().handoff(id)
  clipboard.writeText(result.text)
  return { path: result.path }
})
handleTrusted('visual-catalog', () => {
  const errors: string[] = []
  const read = (file: string): unknown => {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('目录文件过大')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  const documents: Record<string, Record<string, unknown>[]> = {}
  for (const collection of ['skills', 'rules', 'pieces']) {
    documents[collection] = []
    const directory = resolveEditorDataDirectoryV1(getDataRoot(), collection)
    for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'manifest.json')) {
      try {
        const value = read(safePath(collection, filename))
        if (value && typeof value === 'object' && !Array.isArray(value)) documents[collection].push(value as Record<string, unknown>)
      } catch (error) { errors.push(`${collection}/${filename}: ${String(error)}`) }
    }
  }
  let keywords: unknown[] = []
  try {
    const own = resolveEditorWorkspacePathV1(getDataRoot(), 'skill-keywords.json', 'keywords', 'write')
    const file = fs.existsSync(own) ? own : path.join(getProjectRoot(), 'data', 'skill-keywords.json')
    const value = read(file)
    if (!Array.isArray(value)) throw new Error('关键词目录必须是数组')
    keywords = value
  } catch (error) { errors.push(`skill-keywords.json: ${String(error)}`) }
  const statusTags: unknown[] = []
  for (const document of [...documents.skills, ...documents.pieces]) {
    for (const value of [document.statusTag, document.initialStatusTags]) {
      const items = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
      for (const item of items) if (item && typeof item === 'object' && typeof item.id === 'string' && typeof item.type === 'string') statusTags.push(item)
    }
  }
  return {
    keywords,
    skills: documents.skills.map(({ id, name, description, keywords, effectTags }) => ({ id, name, description, keywords, effectTags })),
    rules: documents.rules.map(({ id, name }) => ({ id, name })),
    effects: [...new Set(documents.skills.flatMap(skill => Array.isArray(skill.effectTags) ? skill.effectTags.filter(tag => typeof tag === 'string') : []))],
    statusTags,
    errors,
  }
})
handleTrusted('project-reveal', () => shell.openPath(ensureAuthoringWorkspace()))
handleTrusted('project-select', async (_e, mode: 'open' | 'official' | 'blank') => {
  if (!win || !['open', 'official', 'blank'].includes(mode)) throw new Error('无效的项目操作')
  const selection = await dialog.showOpenDialog(win, {
    title: mode === 'open' ? '打开内容项目文件夹' : '选择新项目的保存位置',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (selection.canceled || selection.filePaths.length !== 1) return { canceled: true }
  const root = mode === 'open'
    ? openContentProject(selection.filePaths[0])
    : createContentProject(selection.filePaths[0], mode, getProjectRoot())
  fs.writeFileSync(path.join(app.getPath('userData'), 'content-project-selection.json'), JSON.stringify({ root }) + '\n')
  selectedProject = root
  return { canceled: false, root }
})

handleTrusted('read-document', (_e, subdir: string, filename: string) => readDocumentSnapshot(safePath(subdir, filename)))
handleTrusted('write-document', (_e, subdir: string, filename: string, data: unknown, revision: string) =>
  writeDocumentSnapshot(safePath(subdir, filename, 'write'), data, revision))

handleTrusted('read-pve-document', (_e, relativePath: string) => {
  readPveJsonV1(ensureAuthoringWorkspace(), relativePath)
  return readDocumentSnapshot(path.join(getAuthoringRoot(), 'data', 'pve', relativePath))
})
handleTrusted('write-pve-document', (_e, relativePath: string, data: unknown, revision: string) => {
  readPveJsonV1(ensureAuthoringWorkspace(), relativePath)
  return writeDocumentSnapshot(path.join(getAuthoringRoot(), 'data', 'pve', relativePath), data, revision)
})

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
  assertSkillGraphArtifact(data)
  const file = safePath(subdir, filename, 'write')
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  return { ok: true }
})

// ─── IPC: 创建文件并登记 manifest ──────────────────────────────────────────────

handleTrusted('create-file', (_e, subdir: string, id: string, data: unknown) => {
  assertSkillGraphArtifact(data)
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
