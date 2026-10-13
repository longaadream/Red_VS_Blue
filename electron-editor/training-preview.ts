import { BrowserWindow, protocol, session, WebContentsView, type Session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { createTrainingResources, type TrainingProfileIdentity, type TrainingSnapshot } from './training-resources'

const scheme = 'rvb-editor-training'
const DEFAULT_TRAINING_ROOT_SEED = 594
const windows = new Set<BrowserWindow>()
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

/**
 * The editor preview deliberately has no renderer bridge. The only values
 * accepted by the retry URL are the small, serialisable training setup fields
 * below; authored content is still loaded from the frozen TrainingSnapshot.
 */
export interface TrainingLaunchOptions {
  rootSeed?: number
  setupConfig?: {
    firstPlayerId?: string
    firstFaction?: string
    secondFaction?: string
    firstTemplateIds?: string[]
    secondTemplateIds?: string[]
    mapId?: string
  }
  setupLog?: Array<{ type: string; input: Record<string, unknown> }>
  autoStart?: boolean
}

export interface EmbeddedTrainingPreviewResult {
  previewId: string
  contentHash: string
  viewId: number
  draft?: TrainingSnapshot['draft']
}

export interface EmbeddedTrainingPreviewBounds {
  x: number
  y: number
  width: number
  height: number
}

interface SecureTrainingContext {
  origin: string
  isolated: Session
  denyProxy: net.Server
  registered: boolean
  cleaned: boolean
  cleanup: () => void
}

interface EmbeddedTrainingPreview {
  previewId: string
  parent: BrowserWindow
  view: WebContentsView
  secure: SecureTrainingContext
  contentHash: string
  bounds: EmbeddedTrainingPreviewBounds
  fitToParent: boolean
  visible: boolean
  resize?: () => void
}

const embeddedPreviews = new Map<string, EmbeddedTrainingPreview>()

function parseTrainingProfileIdentity(value: unknown): TrainingProfileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练候选游戏资源身份无效')
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expected = ['authorityContentHash', 'engineAbi', 'resolvedProfileHash', 'runnerRevision', 'schemaVersion']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('训练候选游戏资源身份字段无效')
  if (candidate.schemaVersion !== 'rvb-game-profile-identity/v1') throw new Error('训练候选游戏资源身份版本不受支持')
  if (typeof candidate.engineAbi !== 'string' || !candidate.engineAbi.trim()
    || typeof candidate.runnerRevision !== 'string' || !candidate.runnerRevision.trim()
    || typeof candidate.resolvedProfileHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.resolvedProfileHash)
    || typeof candidate.authorityContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.authorityContentHash)) {
    throw new Error('训练候选游戏资源身份内容无效')
  }
  return Object.freeze({
    schemaVersion: 'rvb-game-profile-identity/v1',
    engineAbi: candidate.engineAbi,
    runnerRevision: candidate.runnerRevision,
    resolvedProfileHash: candidate.resolvedProfileHash,
    authorityContentHash: candidate.authorityContentHash,
  })
}

function fullParentBounds(parent: BrowserWindow): EmbeddedTrainingPreviewBounds {
  const [width, height] = parent.getContentSize()
  return { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }
}

function validRootSeed(value: unknown): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return undefined
  return (value as number) >>> 0
}

function sanitizeSetupConfig(value: unknown): TrainingLaunchOptions['setupConfig'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const text = (key: string, pattern: RegExp) => typeof input[key] === 'string' && pattern.test(input[key] as string) ? input[key] as string : undefined
  const ids = (key: string) => Array.isArray(input[key])
    ? (input[key] as unknown[]).filter(item => typeof item === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item)).slice(0, 64) as string[]
    : undefined
  const result: TrainingLaunchOptions['setupConfig'] = {
    firstPlayerId: text('firstPlayerId', /^training-(?:red|blue)$/),
    firstFaction: text('firstFaction', /^(?:red|blue)$/),
    secondFaction: text('secondFaction', /^(?:red|blue)$/),
    firstTemplateIds: ids('firstTemplateIds'),
    secondTemplateIds: ids('secondTemplateIds'),
    mapId: text('mapId', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  }
  return Object.values(result).some(value => value !== undefined) ? result : undefined
}

function sanitizeSetupLog(value: unknown): TrainingLaunchOptions['setupLog'] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > 4096) throw new Error('初始场景调整超过四千零九十六次，请重新布置场景；当前试玩保持不变。')
  const result: NonNullable<TrainingLaunchOptions['setupLog']> = []
  for (const candidate of value) {
    const invalid = (): never => { throw new Error('初始场景调整记录不完整，不能原样重试；当前试玩保持不变。') }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid()
    const input = (candidate as Record<string, unknown>).input
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
    const type = (candidate as Record<string, unknown>).type
    if (!['updateResources', 'removePiece', 'resetCooldowns', 'addPiece'].includes(String(type))) invalid()
    const clean: Record<string, unknown> = { type: String(type) }
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (key === 'type') continue
      if (typeof item === 'string' && item.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(item)) clean[key] = item
      else if (typeof item === 'number' && Number.isSafeInteger(item)) clean[key] = item
      else invalid()
    }
    result.push({ type: String(type), input: clean })
  }
  return result.length ? result : undefined
}

function launchQuery(origin: string, options: TrainingLaunchOptions = {}): string {
  const params = new URLSearchParams({ mode: 'training' })
  params.set('rootSeed', String(validRootSeed(options.rootSeed) ?? DEFAULT_TRAINING_ROOT_SEED))
  if (options.autoStart) params.set('autoStart', '1')
  const setup = sanitizeSetupConfig(options.setupConfig)
  if (setup) params.set('setup', JSON.stringify(setup))
  const setupLog = sanitizeSetupLog(options.setupLog)
  if (setupLog) params.set('setupLog', JSON.stringify(setupLog))
  return `${origin}/battle.html?${params.toString()}`
}

async function createSecureTrainingContext(appRoot: string, snapshot: TrainingSnapshot): Promise<SecureTrainingContext> {
  if (!snapshot.profileIdentity) throw new Error('训练候选缺少已验证的游戏资源身份')
  // Normalize and validate the identity before the isolated protocol is
  // registered. The renderer receives this exact identity as a frozen JSON
  // resource and never resolves it through the server profile runtime.
  const profileIdentity = parseTrainingProfileIdentity(snapshot.profileIdentity)
  const resources = createTrainingResources(appRoot, { ...snapshot, profileIdentity })
  const id = randomUUID()
  const origin = `${scheme}://${id}`
  const isOwnUrl = (url: URL) => url.protocol === `${scheme}:` && url.hostname === id && !url.port && !url.username && !url.password
  const isolated = session.fromPartition(`editor-training-${id}`)
  // WebRTC bypasses webRequest: force TCP through our rejecting loopback proxy.
  const denyProxy = net.createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => { denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve) })
  const address = denyProxy.address() as net.AddressInfo
  let registered = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    denyProxy.close()
    if (registered) isolated.protocol.unhandle(scheme)
    void isolated.clearStorageData().catch(() => {})
  }
  try {
    await isolated.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port};socks=127.0.0.1:${address.port}`, proxyBypassRules: '<-loopback>' })
    isolated.on('will-download', event => event.preventDefault())
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('data:') && !details.url.startsWith(`blob:${origin}/`) })
    })
    await isolated.protocol.handle(scheme, request => {
      const url = new URL(request.url)
      if (!isOwnUrl(url) || request.method !== 'GET') return new Response('Forbidden', { status: 403 })
      const result = resources(url.pathname)
      return result ? new Response(new Uint8Array(result.bytes), { headers: { 'Content-Type': result.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }) : new Response('候选资源不存在', { status: 404 })
    })
    registered = true
    return { origin, isolated, denyProxy, registered, cleaned, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

function attachTrainingSecurity(contents: WebContents, secure: SecureTrainingContext, title?: string): void {
  const isOwnUrl = (raw: string) => {
    try {
      const url = new URL(raw)
      return url.protocol === `${scheme}:` && raw.startsWith(secure.origin + '/') && !url.port && !url.username && !url.password
    } catch { return false }
  }
  const allowedNavigation = (raw: string) => {
    try {
      const url = new URL(raw)
      return isOwnUrl(raw) && ['/battle.html', '/training.html'].includes(url.pathname) && url.searchParams.get('mode') === 'training'
    } catch { return false }
  }
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  contents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault() })
  contents.on('will-frame-navigate', details => { if (!details.isMainFrame || !allowedNavigation(details.url)) details.preventDefault() })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (title) contents.on('page-title-updated', event => { event.preventDefault() })
}

function destroyEmbeddedPreview(preview: EmbeddedTrainingPreview): void {
  if (preview.resize) preview.parent.removeListener('resize', preview.resize)
  if (!preview.parent.isDestroyed()) {
    try { preview.parent.contentView.removeChildView(preview.view) } catch { /* already removed during shutdown */ }
  }
  if (!preview.view.webContents.isDestroyed()) {
    try { preview.view.webContents.close() } catch { /* cleanup below is authoritative */ }
  }
  preview.secure.cleanup()
}

async function createEmbeddedPreview(
  parent: BrowserWindow,
  appRoot: string,
  snapshot: TrainingSnapshot,
  previewId: string,
  options: TrainingLaunchOptions,
  bounds: EmbeddedTrainingPreviewBounds,
): Promise<EmbeddedTrainingPreview> {
  const secure = await createSecureTrainingContext(appRoot, snapshot)
  const view = new WebContentsView({
    webPreferences: {
      session: secure.isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: true,
    },
  })
  const preview: EmbeddedTrainingPreview = { previewId, parent, view, secure, contentHash: snapshot.contentHash, bounds, fitToParent: false, visible:false }
  attachTrainingSecurity(view.webContents, secure)
  view.webContents.once('destroyed', () => {
    if (preview.resize) parent.removeListener('resize', preview.resize)
    if (embeddedPreviews.get(previewId)?.view === view) embeddedPreviews.delete(previewId)
    secure.cleanup()
  })
  view.webContents.on('console-message', (_event, _level, message) => {
    if (message === '__RVB_TRAINING_EVENT__' && !parent.isDestroyed()) {
      parent.webContents.send('training-preview-updated', { previewId })
    }
  })
  view.setBounds(bounds)
  try {
    await view.webContents.loadURL(launchQuery(secure.origin, options))
    return preview
  } catch (error) {
    destroyEmbeddedPreview(preview)
    throw error
  }
}

export async function openEmbeddedTrainingPreview(
  parent: BrowserWindow,
  appRoot: string,
  snapshot: TrainingSnapshot,
  options: TrainingLaunchOptions = {},
): Promise<EmbeddedTrainingPreviewResult> {
  if (parent.isDestroyed()) throw new Error('编辑器窗口不可用')
  const previewId = randomUUID()
  const bounds = fullParentBounds(parent)
  const preview = await createEmbeddedPreview(parent, appRoot, snapshot, previewId, options, bounds)
  if (parent.isDestroyed()) {
    destroyEmbeddedPreview(preview)
    throw new Error('编辑器已关闭，本次试玩已取消。')
  }
  preview.fitToParent = true
  // The renderer explicitly attaches it after measuring its canvas. Keeping
  // a loading view detached prevents a tab change from being overwritten.
  const resize = () => {
    if (!preview.fitToParent || preview.parent.isDestroyed() || preview.view.webContents.isDestroyed()) return
    preview.bounds = fullParentBounds(preview.parent)
    preview.view.setBounds(preview.bounds)
  }
  parent.on('resize', resize)
  preview.resize = resize
  embeddedPreviews.set(previewId, preview)
  return { previewId, contentHash: snapshot.contentHash, viewId: preview.view.webContents.id, ...(snapshot.draft ? { draft: snapshot.draft } : {}) }
}

export async function retryEmbeddedTrainingPreview(
  previewId: string,
  appRoot: string,
  snapshot: TrainingSnapshot,
): Promise<EmbeddedTrainingPreviewResult> {
  const current = embeddedPreviews.get(previewId)
  if (!current || current.parent.isDestroyed()) throw new Error('训练营预览已关闭')
  let launch: TrainingLaunchOptions
  try {
    const state = await current.view.webContents.executeJavaScript(`(() => {
      const value = window.__RVB_TRAINING__
      return value && { rootSeed: value.rootSeed, setupConfig: value.setupConfig, setupLog: value.initialSetupLog }
    })()`, true) as { rootSeed?: unknown; setupConfig?: unknown; setupLog?: unknown } | null
    const rootSeed = validRootSeed(state?.rootSeed)
    const setupConfig = sanitizeSetupConfig(state?.setupConfig)
    const setupLog = sanitizeSetupLog(state?.setupLog)
    if (rootSeed === undefined || !setupConfig) throw new Error('训练营初始场景尚未就绪，请稍后重试')
    launch = {
      rootSeed,
      setupConfig,
      setupLog,
      autoStart: true,
    }
  } catch (error) {
    // Never guess a seed or scenario for retry: a retry is valid only after
    // the first run has published its frozen setup metadata.
    throw error instanceof Error ? error : new Error('训练营初始场景尚未就绪，请稍后重试')
  }
  const replacement = await createEmbeddedPreview(current.parent, appRoot, snapshot, previewId, launch, current.bounds)
  if (embeddedPreviews.get(previewId) !== current || current.parent.isDestroyed()) {
    destroyEmbeddedPreview(replacement)
    throw new Error('训练营已关闭，本次重试已取消。')
  }
  replacement.fitToParent = current.fitToParent
  replacement.visible = current.visible
  if (replacement.visible) current.parent.contentView.addChildView(replacement.view)
  if (replacement.fitToParent) {
    const resize = () => {
      if (!replacement.fitToParent || replacement.parent.isDestroyed() || replacement.view.webContents.isDestroyed()) return
      replacement.bounds = fullParentBounds(replacement.parent)
      replacement.view.setBounds(replacement.bounds)
    }
    replacement.resize = resize
    current.parent.on('resize', resize)
  }
  embeddedPreviews.set(previewId, replacement)
  destroyEmbeddedPreview(current)
  return { previewId, contentHash: snapshot.contentHash, viewId: replacement.view.webContents.id, ...(snapshot.draft ? { draft: snapshot.draft } : {}) }
}

export function setEmbeddedTrainingPreviewBounds(previewId: string, rawBounds: unknown): void {
  const preview = embeddedPreviews.get(previewId)
  if (!preview || preview.parent.isDestroyed()) throw new Error('训练营预览已关闭')
  if (!rawBounds || typeof rawBounds !== 'object' || Array.isArray(rawBounds)) throw new Error('训练营预览区域无效')
  const input = rawBounds as Record<string, unknown>
  const number = (key: keyof EmbeddedTrainingPreviewBounds): number => typeof input[key] === 'number' ? input[key] as number : 0
  const bounds = { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
  if (!Object.values(bounds).every(value => Number.isSafeInteger(value) && value >= 0)
    || bounds.width < 1 || bounds.height < 1 || bounds.width > 10000 || bounds.height > 10000) throw new Error('训练营预览区域无效')
  preview.bounds = bounds
  preview.fitToParent = false
  preview.view.setBounds(preview.bounds)
}

export function setEmbeddedTrainingPreviewVisible(previewId: string, visible: boolean): void {
  const preview = embeddedPreviews.get(previewId)
  if (!preview || preview.parent.isDestroyed()) return
  preview.visible = visible
  if (visible) {
    preview.parent.contentView.addChildView(preview.view)
    preview.view.setBounds(preview.bounds)
  } else {
    try { preview.parent.contentView.removeChildView(preview.view) } catch { /* already hidden */ }
  }
}

export function closeEmbeddedTrainingPreview(previewId: string): void {
  const preview = embeddedPreviews.get(previewId)
  if (!preview) return
  embeddedPreviews.delete(previewId)
  destroyEmbeddedPreview(preview)
}

export async function inspectEmbeddedTrainingPreview(previewId: string): Promise<Record<string, unknown> | null> {
  const preview = embeddedPreviews.get(previewId)
  if (!preview || preview.view.webContents.isDestroyed()) return null
  const value = await preview.view.webContents.executeJavaScript(`(() => {
    const state = window.__RVB_TRAINING__
    if (!state) return null
    return {
      rootSeed: state.rootSeed,
      setupConfig: state.setupConfig,
      initialStateHash: state.initialStateHash,
      stateHash: state.stateHash,
      actionLog: Array.isArray(state.actionLog) ? state.actionLog : [],
      setupLog: Array.isArray(state.setupLog) ? state.setupLog : [],
      actionCount: Array.isArray(state.actionLog) ? state.actionLog.length : 0,
    }
  })()`, true) as Record<string, unknown> | null
  return value ? { previewId, ...value, contentHash: preview.contentHash } : null
}

export async function openTrainingPreview(appRoot: string, snapshot: TrainingSnapshot, hidden = false): Promise<{ contentHash: string; windowId: number; draft?: TrainingSnapshot['draft'] }> {
  const secure = await createSecureTrainingContext(appRoot, snapshot)
  const title = snapshot.draft
    ? `训练营 · 草稿试用 · ${snapshot.draft.skillName} · ${snapshot.contentHash.slice(0, 12)}`
    : `训练营 · 已接受版本 ${snapshot.contentHash.slice(0, 12)}`
  let preview: BrowserWindow | undefined
  try {
    preview = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 700, title, show: !hidden,
      webPreferences: { session: secure.isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: !hidden, offscreen: hidden } })
    windows.add(preview)
    attachTrainingSecurity(preview.webContents, secure, title)
    preview.on('closed', () => { windows.delete(preview!); secure.cleanup() })
    await preview.loadURL(launchQuery(secure.origin))
    return { contentHash: snapshot.contentHash, windowId: preview.id, ...(snapshot.draft ? { draft: snapshot.draft } : {}) }
  } catch (error) {
    if (preview && !preview.isDestroyed()) preview.destroy()
    secure.cleanup()
    throw error
  }
}

export function closeTrainingPreviews(): void {
  for (const preview of embeddedPreviews.values()) destroyEmbeddedPreview(preview)
  embeddedPreviews.clear()
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
}
