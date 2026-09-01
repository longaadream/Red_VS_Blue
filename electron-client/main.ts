import { app, BrowserWindow, dialog, ipcMain, net as electronNet, protocol, safeStorage, session } from 'electron'
import { spawn, ChildProcess, execSync } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as dgram from 'dgram'
import * as http from 'http'
import { randomBytes } from 'crypto'
import { pathToFileURL } from 'url'
import { assertTrustedIpcSender, isFileUrlWithinRoot } from './ipc-trust'
import { resolveDevelopmentProfile } from './development-profile'
import { findFreePort } from './local-port'
import { resolveClientProtocolFile } from './client-protocol-resource'
import { EmbeddedPostgresController } from './embedded-postgres'
import {
  LOCAL_GAME_OPEN_CANCELLED,
  LocalGameLifecycleGate,
} from './local-game-lifecycle'
import {
  type DesktopProfileReference,
  getActiveResourcePackMeta,
  isHealthyCommittedProfileObservation,
  recoverUncertainProfileCommit,
  isActivatableResourcePackPath,
  listActiveResourcePackFiles,
  readDesktopProfileState,
  reconcileProfileRendererCommit,
  resolveActiveResourcePackRoot,
} from './resource-pack-store'

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const LOCAL_PORT_HINT = 38521  // 首选端口，被占用时自动递增（避开 54300-54400 被 QMUpload 占用的范围）
let actualLocalPort = LOCAL_PORT_HINT  // 实际绑定成功的端口
const GAME_PORT_HINT = 38621
let actualGamePort = GAME_PORT_HINT
const CLIENT_SCHEME = 'rvb-client'
const BATTLE_AUTHORITY_SHUTDOWN_REQUEST = 'rvb:battle-authority:shutdown'
const BATTLE_AUTHORITY_SHUTDOWN_RESULT = 'rvb:battle-authority:shutdown-result'
const SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 6_500
const PROFILE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
const PROFILE_ADMIN_KEY = randomBytes(32).toString('hex')
let allowAppExit = false
let appExitPromise: Promise<void> | null = null

type GameProfileIdentity = Readonly<{
  schemaVersion: 'rvb-game-profile-identity/v1'
  engineAbi: string
  runnerRevision: 'rvb-battle-runner/v1'
  resolvedProfileHash: string
  authorityContentHash: string
}>

type ChildLogStream = 'stdout' | 'stderr'
type ChildLogErrorSide = 'source' | 'target' | 'write'

type ChildLogForwardingRecord = {
  event: 'electron.child-log-forwarding.error'
  runtime: 'electron-client'
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
  console.error('[client] Unexpected child log stream error:', record, error)
}

protocol.registerSchemesAsPrivileged([{
  scheme: CLIENT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

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

// Keep Electron storage and ProcessSingleton aligned with the explicit
// candidate profile. This must run before either development-profile handling
// or requestSingleInstanceLock().
applyExplicitUserDataOverride()

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

function profileRootForReference(reference: DesktopProfileReference): string {
  if (reference.kind === 'bundled-base') return getAppRoot()
  const profileRoot = path.join(getPackRoot(), 'profiles', reference.resolvedProfileHash)
  if (!fs.existsSync(path.join(profileRoot, '.rvb', 'profile.json'))) {
    throw new Error(`PROFILE_SNAPSHOT_INCOMPLETE: ${reference.resolvedProfileHash}`)
  }
  return profileRoot
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
      if (warning) console.warn('[client] graceful server shutdown failed:', warning)
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
    console.error('[client] forcing server stop with a potentially undurable battle journal')
  }
  if (proc.exitCode === null && proc.signalCode === null) killProcessTree(proc)
}

async function killServer(requireDurable = false, invalidateOpening = true): Promise<void> {
  const finishShutdown = localGameLifecycle.beginShutdown(invalidateOpening)
  try {
    const startup = localGameStartupPromise
    if (startup) {
      try {
        await startup
      } catch (error) {
        console.error('[client] local authority startup failed while shutdown was waiting:', error)
      }
    }
    if (gameServerProcess) {
      const gameProc = gameServerProcess
      await stopChildProcessGracefully(gameProc, requireDurable)
      localGameReady = false
      localAuthorityProfileIdentity = null
      if (gameServerProcess === gameProc) gameServerProcess = null
    }
    if (embeddedPostgres) await embeddedPostgres.stop()
    if (!serverProcess) return
    // The Profile/Next process does not own the battle journal and therefore does
    // not implement the Colyseus durable-drain IPC contract. Waiting for that ACK
    // here falsely reports a database shutdown failure after the real authority
    // and PostgreSQL have already stopped.
    const profileProc = serverProcess
    localServerReady = false
    localProfileIdentity = null
    serverProcess = null
    killProcessTree(profileProc)
  } finally {
    finishShutdown()
  }
}

function forceKillServer(): void {
  localGameReady = false
  localAuthorityProfileIdentity = null
  if (gameServerProcess) {
    const gameProc = gameServerProcess
    gameServerProcess = null
    killProcessTree(gameProc)
  }
  if (embeddedPostgres) {
    embeddedPostgres.forceStop()
  }
  localServerReady = false
  localProfileIdentity = null
  if (!serverProcess) return
  const proc = serverProcess
  serverProcess = null
  killProcessTree(proc)
}

function requestApplicationExit(): void {
  if (allowAppExit) {
    app.exit(0)
    return
  }
  if (appExitPromise) return
  appExitPromise = killServer(true)
    .then(() => {
      allowAppExit = true
      app.exit(0)
    })
    .catch(error => {
      console.error('[client] durable application shutdown failed; processes remain fail-closed:', error)
      appExitPromise = null
      dialog.showErrorBox(
        '无法安全退出',
        '战斗记录尚未确认写入数据库，游戏服务仍保持运行。请稍后再次退出；不要强制结束进程。',
      )
    })
}

// ─── 本地服务器管理 ───────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null
let localServerReady = false
let gameServerProcess: ChildProcess | null = null
let localGameReady = false
let localGameStartupPromise: Promise<void> | null = null
let localGameOpenPromise: Promise<{ ok: boolean; error?: string }> | null = null
const localGameLifecycle = new LocalGameLifecycleGate()
let embeddedPostgres: EmbeddedPostgresController | null = null
let localProfileIdentity: GameProfileIdentity | null = null
let localAuthorityProfileIdentity: GameProfileIdentity | null = null
let lastServerExitCode: number | null = null
let lastServerStderr = ''
type ProfileProcessBinding = {
  reference?: DesktopProfileReference
  profileRoot: string
  activationId?: string
}

function stableProfileBinding(): ProfileProcessBinding {
  try {
    const stable = readDesktopProfileState(getPackRoot())?.stable
    if (!stable) return { profileRoot: getAppRoot() }
    return {
      reference: stable,
      profileRoot: profileRootForReference(stable),
    }
  } catch (error) {
    console.error('[profile] stable binding is invalid; server will recover through Bundled Base:', error)
    // Never let getDataRoot() fall back to the still-corrupt active.json.
    // The gated bootstrap process reads only bundled files until the central
    // Store repairs the pointer and confirms whether a fresh process is needed.
    return { profileRoot: getAppRoot() }
  }
}

function gameProfileIdentityFromReference(reference: DesktopProfileReference): GameProfileIdentity {
  return {
    schemaVersion: 'rvb-game-profile-identity/v1',
    engineAbi: reference.compatibility.engineAbi,
    runnerRevision: 'rvb-battle-runner/v1',
    resolvedProfileHash: reference.resolvedProfileHash,
    authorityContentHash: reference.authorityContentHash,
  }
}

function refreshLocalProfileIdentity(targetProfileHash?: string): void {
  const reference = readDesktopProfileState(getPackRoot())?.stable
  if (!reference || (targetProfileHash && reference.resolvedProfileHash !== targetProfileHash)) {
    localProfileIdentity = null
    throw new Error('LOCAL_PROFILE_IDENTITY_STATE_MISMATCH')
  }
  localProfileIdentity = gameProfileIdentityFromReference(reference)
}

function parseGameProfileIdentity(value: unknown): GameProfileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LOCAL_AUTHORITY_PROFILE_IDENTITY_INVALID')
  }
  const identity = value as Partial<GameProfileIdentity>
  const keys = Object.keys(identity).sort().join(',')
  if (
    keys !== 'authorityContentHash,engineAbi,resolvedProfileHash,runnerRevision,schemaVersion'
    || identity.schemaVersion !== 'rvb-game-profile-identity/v1'
    || identity.runnerRevision !== 'rvb-battle-runner/v1'
    || typeof identity.engineAbi !== 'string'
    || !/^[a-f0-9]{64}$/.test(identity.resolvedProfileHash ?? '')
    || !/^[a-f0-9]{64}$/.test(identity.authorityContentHash ?? '')
  ) throw new Error('LOCAL_AUTHORITY_PROFILE_IDENTITY_INVALID')
  return identity as GameProfileIdentity
}

function fetchAuthorityProfileIdentity(port: number): Promise<GameProfileIdentity> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/catalog/identity`, response => {
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > 64 * 1024) request.destroy(new Error('LOCAL_AUTHORITY_PROFILE_IDENTITY_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`LOCAL_AUTHORITY_PROFILE_IDENTITY_HTTP_${response.statusCode ?? 0}`))
          return
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { profileIdentity?: unknown }
          resolve(parseGameProfileIdentity(payload.profileIdentity))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(3_000, () => request.destroy(new Error('LOCAL_AUTHORITY_PROFILE_IDENTITY_TIMEOUT')))
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

function waitForGameAuthorityReady(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const probe = () => {
      if (!gameServerProcess) {
        resolve(false)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      const request = http.get(`http://127.0.0.1:${port}/healthz`, response => {
        response.resume()
        if (response.statusCode === 200) resolve(true)
        else setTimeout(probe, 250)
      })
      request.on('error', () => setTimeout(probe, 250))
      request.setTimeout(1000, () => request.destroy())
    }
    probe()
  })
}

function findColyseusEntry(appRoot: string): string | null {
  const candidates = app.isPackaged
    ? [path.join(appRoot, 'standalone', 'colyseus', 'colyseus-server.mjs')]
    : [path.join(appRoot, '_client-colyseus', 'colyseus-server.mjs')]
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

function getEmbeddedPostgresRuntimeRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'postgres', 'pgsql')
    : path.join(getAppRoot(), '_client-postgres', 'pgsql')
}

function getEmbeddedPostgres(): EmbeddedPostgresController {
  if (embeddedPostgres) return embeddedPostgres
  if (process.platform !== 'win32') {
    throw new Error('The bundled PostgreSQL runtime currently supports Windows x64 only; set RVB_POSTGRES_URL for this platform')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('System credential encryption is unavailable; embedded PostgreSQL cannot start safely')
  }
  embeddedPostgres = new EmbeddedPostgresController({
    runtimeRoot: getEmbeddedPostgresRuntimeRoot(),
    stateRoot: path.join(getUserData(), 'postgres', '16'),
    findFreePort,
    protectSecret: plaintext => safeStorage.encryptString(plaintext),
    unprotectSecret: encrypted => safeStorage.decryptString(encrypted),
    onUnexpectedExit: (code, signal) => {
      console.error(`[client] embedded PostgreSQL exited unexpectedly: code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      localGameReady = false
      localAuthorityProfileIdentity = null
      if (gameServerProcess) {
        const gameProc = gameServerProcess
        gameServerProcess = null
        killProcessTree(gameProc)
      }
    },
  })
  return embeddedPostgres
}

async function resolveAuthorityDatabaseUrl(): Promise<string> {
  const external = process.env.RVB_POSTGRES_URL
  if (external) {
    let protocol = ''
    try { protocol = new URL(external).protocol }
    catch { throw new Error('Configured PostgreSQL authority URL is invalid') }
    if (protocol !== 'postgresql:' && protocol !== 'postgres:') {
      throw new Error('Configured battle authority database must use PostgreSQL')
    }
    console.info('[client] Using externally configured PostgreSQL authority')
    return external
  }
  console.info('[client] Starting bundled PostgreSQL authority for LAN hosting')
  const connection = await getEmbeddedPostgres().start()
  console.info(`[client] Bundled PostgreSQL ready on loopback port ${connection.port}`)
  return connection.url
}

function localAuthorityStartupErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === LOCAL_GAME_OPEN_CANCELLED) {
    return '本地主机启动已取消，请稍后重试。'
  }
  if (/safeStorage|credential encryption|凭据加密/i.test(message)) {
    return '系统凭据加密不可用，无法安全启动本机数据库。'
  }
  if (/runtime manifest|runtime is missing|SHA-256|inventory/i.test(message)) {
    return '内置 PostgreSQL 文件校验失败，请重新安装游戏。'
  }
  if (/must use PostgreSQL|URL is invalid/i.test(message)) {
    return 'PostgreSQL 连接配置无效，请检查服务器配置。'
  }
  return '本机战斗服务启动失败，请查看客户端日志。'
}

async function startLocalGameAuthorityOnce(profileBinding?: ProfileProcessBinding): Promise<void> {
  if (gameServerProcess) {
    if (!localGameReady) localGameReady = await waitForGameAuthorityReady(actualGamePort, 5000)
    if (localGameReady) {
      try {
        localAuthorityProfileIdentity = await fetchAuthorityProfileIdentity(actualGamePort)
      } catch (error) {
        localGameReady = false
        localAuthorityProfileIdentity = null
        throw error
      }
    }
    return
  }

  localGameReady = false
  localAuthorityProfileIdentity = null
  actualGamePort = await findFreePort(GAME_PORT_HINT)
  const appRoot = getAppRoot()
  const entry = findColyseusEntry(appRoot)
  if (!entry) {
    console.error('[client] packaged Colyseus authority is missing; run npm run build:colyseus')
    return
  }
  const binding = profileBinding ?? stableProfileBinding()
  const databaseUrl = await resolveAuthorityDatabaseUrl()
  console.log(`[client] Colyseus/PostgreSQL game port: ${actualGamePort}`)
  gameServerProcess = spawn(getNodeBin(), [entry], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RVB_COLYSEUS_PORT: String(actualGamePort),
      RVB_COLYSEUS_HOST: '0.0.0.0',
      RVB_POSTGRES_URL: databaseUrl,
      RVB_TURN_TIMER_ENABLED: '1',
      APP_ROOT_DIR: appRoot,
      USER_DATA_DIR: getUserData(),
      RVB_PROFILE_ROOT: binding.profileRoot,
      RVB_RESOLVED_PROFILE_HASH: binding.reference?.resolvedProfileHash,
      RVB_AUTHORITY_CONTENT_HASH: binding.reference?.authorityContentHash,
      RVB_PROFILE_ENGINE_ABI: binding.reference?.compatibility.engineAbi,
      RVB_PROFILE_CONTENT_ABI: binding.reference?.compatibility.contentAbi,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  lastServerExitCode = null
  lastServerStderr = ''
  if (gameServerProcess.stdout) {
    attachSafeLogForwarder(gameServerProcess.stdout, process.stdout, {
      runtime: 'electron-client',
      stream: 'stdout',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }
  if (gameServerProcess.stderr) {
    gameServerProcess.stderr.on('data', data => {
      lastServerStderr = (lastServerStderr + data.toString()).slice(-3000)
    })
    attachSafeLogForwarder(gameServerProcess.stderr, process.stderr, {
      runtime: 'electron-client',
      stream: 'stderr',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }
  const spawned = gameServerProcess
  spawned.on('error', error => console.error('[client] Colyseus authority error:', error))
  spawned.on('exit', code => {
    lastServerExitCode = code
    if (gameServerProcess === spawned) {
      gameServerProcess = null
      localGameReady = false
      localAuthorityProfileIdentity = null
    }
    console.log(`[client] Colyseus authority exited: ${code}`)
    if (lastServerStderr) console.error('[client] last Colyseus stderr:', lastServerStderr.slice(-500))
  })
  localGameReady = await waitForGameAuthorityReady(actualGamePort)
  if (!localGameReady) {
    console.error(`[client] Colyseus/PostgreSQL authority did not become ready on port ${actualGamePort}`)
    return
  }
  try {
    localAuthorityProfileIdentity = await fetchAuthorityProfileIdentity(actualGamePort)
  } catch (error) {
    localGameReady = false
    localAuthorityProfileIdentity = null
    throw error
  }
}

async function startLocalGameAuthority(profileBinding?: ProfileProcessBinding): Promise<void> {
  if (localGameStartupPromise) {
    await localGameStartupPromise
    return
  }
  const startup = startLocalGameAuthorityOnce(profileBinding)
  localGameStartupPromise = startup
  try {
    await startup
  } finally {
    if (localGameStartupPromise === startup) localGameStartupPromise = null
  }
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

async function startLocalServer(
  profileBinding?: ProfileProcessBinding,
  expectedGeneration?: number,
): Promise<void> {
  if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
  if (serverProcess) {
    if (!localServerReady) {
      localServerReady = await waitForLocalServerReady(actualLocalPort, 5000)
    }
    if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
    return
  }

  localServerReady = false
  actualLocalPort = await findFreePort(LOCAL_PORT_HINT)
  if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
  console.log(`[client] Public server port: ${actualLocalPort}`)

  const appRoot = getAppRoot()
  const userData = getUserData()

  const serverEntry = findServerEntry(appRoot)
  if (!serverEntry) {
    console.warn('[client] server.js not found, offline mode unavailable')
    localServerReady = false
    return
  }
  const binding = profileBinding ?? stableProfileBinding()
  serverProcess = spawn(getNodeBin(), [serverEntry], {
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      PORT: String(actualLocalPort),
      HOSTNAME: '0.0.0.0',
      NODE_ENV: 'production',
      // This process only serves Profile HTTP APIs and presentation assets.
      // Player rooms/actions belong exclusively to Colyseus/PostgreSQL.
      APP_ROOT_DIR: appRoot,
      USER_DATA_DIR: userData,
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

  lastServerExitCode = null
  lastServerStderr = ''

  if (serverProcess.stdout) {
    attachSafeLogForwarder(serverProcess.stdout, process.stdout, {
      runtime: 'electron-client',
      stream: 'stdout',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (d) => {
      lastServerStderr = (lastServerStderr + d.toString()).slice(-3000)
    })
    attachSafeLogForwarder(serverProcess.stderr, process.stderr, {
      runtime: 'electron-client',
      stream: 'stderr',
      report: logChildForwardingRecord,
      reportUnexpectedError: logUnexpectedChildStreamError,
    })
  }

  const spawnedProcess = serverProcess
  spawnedProcess.on('error', (err) => console.error('[client] server error:', err))
  spawnedProcess.on('exit', (code) => {
    lastServerExitCode = code
    if (serverProcess === spawnedProcess) {
      serverProcess = null
      localServerReady = false
      localProfileIdentity = null
    }
    console.log(`[client] local server exited: ${code}`)
    if (lastServerStderr) console.error('[client] last stderr:', lastServerStderr.slice(-500))
  })

  localServerReady = await waitForLocalServerReady(actualLocalPort)
  if (!localServerReady) {
    console.warn(`[client] local server did not become ready on port ${actualLocalPort}`)
  }
}

// ─── Profile 安装、激活与回退 ─────────────────────────────────────────────────

// Electron/Next JSON replies are validated at each authority boundary below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>

type ProfileApiRequestOptions = {
  method?: 'GET' | 'POST'
  json?: JsonObject
  archive?: Buffer
}

let profileMutationTail: Promise<unknown> = Promise.resolve()

function enqueueProfileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = profileMutationTail.then(operation, operation)
  profileMutationTail = next.then(() => undefined, () => undefined)
  return next
}

function profileApiRequest<T extends JsonObject = JsonObject>(
  route: string,
  options: ProfileApiRequestOptions = {},
): Promise<T> {
  const body = options.archive
    ?? (options.json ? Buffer.from(JSON.stringify(options.json), 'utf8') : null)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: actualLocalPort,
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
    request.on('error', reject)
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

async function readProfileArchive(filePath: string): Promise<Buffer> {
  const stat = await fs.promises.stat(filePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > PROFILE_ARCHIVE_MAX_BYTES) {
    throw new Error('Resource-pack compressed archive is empty or exceeds 32 MiB')
  }
  return fs.promises.readFile(filePath)
}

async function installProfileArchive(archive: Buffer): Promise<JsonObject> {
  if (!localServerReady) throw new Error('PROFILE_SERVER_NOT_READY')
  const result = await profileApiRequest('/api/content-profile/install', {
    method: 'POST',
    archive,
  })
  return {
    ok: true,
    ...result,
    count: Array.isArray(result.profile?.files) ? result.profile.files.length : 0,
    meta: result.reference ?? null,
  }
}

async function verifyRendererCandidate(
  reference: DesktopProfileReference,
  profileRoot: string,
  activationId: string,
): Promise<void> {
  const required = [
    'data/pieces/manifest.json',
    'data/skills/manifest.json',
    'data/cards/manifest.json',
    'data/cards/lucky-coin.json',
  ]
  const activePackRoot = reference.kind === 'installed' ? profileRoot : null
  for (const relativePath of required) {
    const resolved = resolveClientProtocolFile({
      relativePath,
      htmlRoot: getHtmlRoot(),
      appRoot: getAppRoot(),
      activePackRoot,
      isPackaged: app.isPackaged,
    })
    if (!resolved) throw new Error(`PROFILE_RENDERER_RESOURCE_MISSING: ${relativePath}`)
    JSON.parse(fs.readFileSync(resolved, 'utf8'))
  }

  const smokeSession = session.fromPartition(`rvb-profile-smoke-${activationId}`, { cache: false })
  const serverUrl = `http://127.0.0.1:${actualLocalPort}`
  await smokeSession.protocol.handle(CLIENT_SCHEME, request => (
    serveClientProtocolRequest(request, activePackRoot, serverUrl)
  ))
  const smokeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      session: smokeSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  restrictWindowNavigation(smokeWindow, isGameClientUrl)
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }
      const timeout = setTimeout(
        () => finish(new Error('PROFILE_RENDERER_SMOKE_TIMEOUT')),
        15_000,
      )
      smokeWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame) finish(new Error(`PROFILE_RENDERER_LOAD_FAILED: ${code} ${description}`))
      })
      smokeWindow.webContents.once('render-process-gone', (_event, details) => {
        finish(new Error(`PROFILE_RENDERER_GONE: ${details.reason}`))
      })
      smokeWindow.once('unresponsive', () => finish(new Error('PROFILE_RENDERER_UNRESPONSIVE')))
      smokeWindow.webContents.on('did-finish-load', () => {
        void (async () => {
          const current = new URL(smokeWindow.webContents.getURL())
          if (current.pathname !== '/index.html') return
          const requiredLiteral = JSON.stringify(required)
          const ready = await smokeWindow.webContents.executeJavaScript(`(async () => {
            const required = ${requiredLiteral}
            const parsed = []
            for (const relativePath of required) {
              let response
              try {
                response = await fetch('${CLIENT_SCHEME}://app/' + relativePath, { cache: 'no-store' })
              } catch (error) {
                throw new Error('PROFILE_RENDERER_RESOURCE_FETCH_FAILED: ' + relativePath + ': ' + String(error))
              }
              if (!response.ok) throw new Error('renderer resource HTTP ' + response.status + ': ' + relativePath)
              parsed.push(await response.json())
            }
            return {
              readyState: document.readyState,
              bodyChildren: document.body ? document.body.children.length : 0,
              title: document.title,
              parsedProfileResources: parsed.length
            }
          })()`)
          if (
            ready?.readyState !== 'complete'
            || ready?.bodyChildren < 1
            || ready?.parsedProfileResources !== required.length
          ) {
            finish(new Error('PROFILE_RENDERER_DOCUMENT_INVALID'))
            return
          }
          finish()
        })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
      })
      void smokeWindow.loadURL(`${CLIENT_SCHEME}://app/__profile-smoke__.html`)
        .catch(error => finish(error instanceof Error ? error : new Error(String(error))))
    })
  } finally {
    if (!smokeWindow.isDestroyed()) smokeWindow.destroy()
    await smokeSession.protocol.unhandle(CLIENT_SCHEME)
    await smokeSession.clearStorageData()
  }
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

async function recordProfileRendererEvidence(
  kind: 'postcommit-renderer-failure' | 'postcommit-renderer-rollback',
  evidence: Readonly<{
    code: string
    stage: string
    message: string
    targetProfileHash: string
    rollbackTarget: 'previous-stable' | null
    rollbackSucceeded?: boolean
  }>,
): Promise<void> {
  const record = {
    event: 'content-profile',
    kind,
    ...evidence,
    rollbackSucceeded: evidence.rollbackSucceeded ?? null,
  }
  console.info(JSON.stringify(record))
  await profileApiRequest('/api/content-profile/activation/failure', {
    method: 'POST',
    json: {
      evidenceKind: kind,
      ...evidence,
      rollbackSucceeded: evidence.rollbackSucceeded ?? null,
    },
  })
}

function reloadMainRendererAndWait(
  expectedProfileHash: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = mainWin
    if (!win || win.isDestroyed()) return reject(new Error('PROFILE_RENDERER_WINDOW_MISSING'))
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      win.webContents.removeListener('did-finish-load', onFinish)
      win.webContents.removeListener('did-fail-load', onFail)
      win.webContents.removeListener('render-process-gone', onGone)
      win.removeListener('unresponsive', onUnresponsive)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onFinish = (): void => {
      void win.webContents.executeJavaScript(`(async () => {
        const bridge = window.electronAPI
        if (!bridge || typeof bridge.packList !== 'function') {
          throw new Error('PROFILE_RENDERER_BRIDGE_MISSING')
        }
        const status = await bridge.packList()
        return {
          readyState: document.readyState,
          bodyChildren: document.body ? document.body.children.length : 0,
          stableProfileHash: status && status.state && status.state.stable && status.state.stable.resolvedProfileHash,
          serverProfileHash: status && status.server && status.server.profile && status.server.profile.resolvedProfileHash,
          serverHealthy: status && status.server && status.server.healthy,
        }
      })()`).then(ready => {
        if (
          ready?.readyState !== 'complete'
          || ready?.bodyChildren < 1
          || ready?.stableProfileHash !== expectedProfileHash
          || ready?.serverProfileHash !== expectedProfileHash
          || ready?.serverHealthy !== true
        ) {
          finish(new Error('PROFILE_RENDERER_RELOAD_READINESS_MISMATCH'))
          return
        }
        finish()
      }, error => finish(error instanceof Error ? error : new Error(String(error))))
    }
    const onFail = (
      _event: Electron.Event,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) finish(new Error(`PROFILE_RENDERER_RELOAD_FAILED: ${code} ${description}`))
    }
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      finish(new Error(`PROFILE_RENDERER_RELOAD_GONE: ${details.reason}`))
    }
    const onUnresponsive = (): void => finish(new Error('PROFILE_RENDERER_RELOAD_UNRESPONSIVE'))
    const timeout = setTimeout(
      () => finish(new Error('PROFILE_RENDERER_RELOAD_TIMEOUT')),
      timeoutMs,
    )
    win.webContents.once('did-finish-load', onFinish)
    win.webContents.on('did-fail-load', onFail)
    win.webContents.once('render-process-gone', onGone)
    win.once('unresponsive', onUnresponsive)
    win.webContents.reloadIgnoringCache()
  })
}

async function reconcileMainRendererAfterCommit(
  targetProfileHash: string,
  stage: string,
  success: JsonObject,
  allowRendererRollback: boolean,
): Promise<JsonObject> {
  refreshLocalProfileIdentity(targetProfileHash)
  return await reconcileProfileRendererCommit({
    expectedProfileHash: targetProfileHash,
    stage,
    success,
    allowRollback: allowRendererRollback,
    reloadAndVerify: reloadMainRendererAndWait,
    releaseAdmission: async expectedProfileHash => {
      await profileApiRequest('/api/content-profile/activation/release', {
        method: 'POST',
        json: { targetProfileHash: expectedProfileHash },
      })
    },
    rollbackPreviousStable: () => selectAndActivateRollback('previous-stable', false),
    recordFailureEvidence: evidence => recordProfileRendererEvidence(
      'postcommit-renderer-failure',
      evidence,
    ),
    recordRollbackEvidence: evidence => recordProfileRendererEvidence(
      'postcommit-renderer-rollback',
      evidence,
    ),
    enterFailClosed: async () => {
      await killServer()
    },
  }) as JsonObject
}

async function observeCommittedProfileAfterRecovery(): Promise<JsonObject | null> {
  if (!localServerReady) return null
  try {
    const recovery = await profileApiRequest(
      '/api/content-profile/recovery?keepAdmissionPaused=1',
      { method: 'POST' },
    )
    if (recovery.requiresProcessRestart === true) return null
    return await profileApiRequest('/api/content-profile')
  } catch {
    return null
  }
}

async function activateProfileHash(
  targetProfileHash: string,
  allowRendererRollback = true,
): Promise<JsonObject> {
  if (!localServerReady) throw new Error('PROFILE_SERVER_NOT_READY')
  const before = await profileApiRequest('/api/content-profile')
  if (before.state?.stable?.resolvedProfileHash === targetProfileHash) {
    if (
      before.server?.healthy !== true
      || before.server?.activationId !== null
      || before.server?.profile?.resolvedProfileHash !== targetProfileHash
    ) throw new Error('ACTIVE_PROFILE_IDENTITY_OR_HEALTH_MISMATCH')
    return await reconcileMainRendererAfterCommit(
      targetProfileHash,
      'renderer-already-active-reload',
      { alreadyActive: true, state: before.state, server: before.server },
      allowRendererRollback,
    )
  }

  let stage = 'activation-plan'
  let plan: JsonObject | null = null
  try {
    plan = await profileApiRequest('/api/content-profile/activation/plan', {
      method: 'POST',
      json: { targetProfileHash },
    })
    const targetReference = plan.target as DesktopProfileReference
    const targetBinding: ProfileProcessBinding = {
      reference: targetReference,
      profileRoot: String(plan.profileRoot),
      activationId: String(plan.activationId),
    }

    if (plan.reloadMode === 'authority-restart') {
      stage = 'candidate-server-start'
      await killServer(true)
      await startLocalServer(targetBinding)
      if (!localServerReady) throw new Error('CANDIDATE_SERVER_START_FAILED')
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

    stage = 'candidate-profile-http-health'

    stage = 'candidate-renderer-preflight'
    await verifyRendererCandidate(
      targetReference,
      targetBinding.profileRoot,
      String(plan.activationId),
    )

    stage = 'activation-commit'
    const committed = await profileApiRequest('/api/content-profile/activation/commit', {
      method: 'POST',
      json: {
        activationId: plan.activationId,
        targetProfileHash,
        keepAdmissionPaused: true,
      },
    })
    stage = 'colyseus-authority-start'
    await startLocalGameAuthority(targetBinding)
    if (!localGameReady) throw new Error('COLYSEUS_POSTGRES_AUTHORITY_START_FAILED')
    stage = 'renderer-commit-reload'
    return await reconcileMainRendererAfterCommit(
      targetProfileHash,
      stage,
      committed,
      allowRendererRollback,
    )
  } catch (error) {
    if (plan) {
      const durableDrainFailed = error instanceof Error && error.message === 'PROFILE_DURABLE_DRAIN_FAILED'
      const keepAdmissionPaused = durableDrainFailed || !allowRendererRollback
      if (stage === 'activation-commit') {
        let readOnlyObserved: JsonObject | null = null
        if (localServerReady) {
          try {
            readOnlyObserved = await profileApiRequest('/api/content-profile')
          } catch {}
        }
        if (isHealthyCommittedProfileObservation(readOnlyObserved, targetProfileHash)) {
          stage = 'renderer-commit-recovery-reload'
          return await reconcileMainRendererAfterCommit(
            targetProfileHash,
            stage,
            {
              commitRecovered: true,
              state: readOnlyObserved!.state,
              server: readOnlyObserved!.server,
            },
            allowRendererRollback,
          )
        }
        const code = (error as Error & { code?: string }).code
        const commitIsUncertain = !code || code === 'PROFILE_COMMIT_RESPONSE_UNCERTAIN'
        if (commitIsUncertain) {
        try {
          const observed = await recoverUncertainProfileCommit(
            targetProfileHash,
            observeCommittedProfileAfterRecovery,
            async () => {
              await killServer()
              await startLocalServer(stableProfileBinding())
              if (!localServerReady) throw new Error('PROFILE_COMMIT_RECOVERY_RESTART_FAILED')
            },
          )
          if (observed) {
            stage = 'renderer-commit-recovery-reload'
            return await reconcileMainRendererAfterCommit(
              targetProfileHash,
              stage,
              { commitRecovered: true, state: observed.state, server: observed.server },
              allowRendererRollback,
            )
          }
        } catch {}
        }
      }
      let failureRecorded = false
      if (localServerReady) {
        try {
          await recordProfileActivationFailure(
            String(plan.activationId),
            stage,
            error,
            keepAdmissionPaused,
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
      if (!keepAdmissionPaused) {
        await killServer()
        await startStableLocalServerAndRecover()
      }
      if (!failureRecorded && localServerReady) {
        try {
          await recordProfileActivationFailure(
            String(plan.activationId),
            stage,
            error,
            keepAdmissionPaused,
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
      ...(typed.message === 'PROFILE_DURABLE_DRAIN_FAILED' || !allowRendererRollback
        ? { admissionPaused: true, requiresApplicationRestart: true }
        : {}),
    }
  }
}

async function selectAndActivateRollback(
  target: 'previous-stable' | 'bundled-base',
  allowRendererRollback = true,
): Promise<JsonObject> {
  const selected = await profileApiRequest('/api/content-profile/rollback', {
    method: 'POST',
    json: { target },
  })
  const targetHash = selected.targetProfileHash
    ?? selected.state?.candidate?.resolvedProfileHash
  if (typeof targetHash !== 'string') throw new Error('PROFILE_ROLLBACK_TARGET_MISSING')
  return activateProfileHash(targetHash, allowRendererRollback)
}

async function recoverProfileOnStartup(expectedGeneration?: number): Promise<void> {
  localProfileIdentity = null
  if (!localServerReady) throw new Error('PROFILE_SERVER_NOT_READY')
  let recovered = await profileApiRequest('/api/content-profile/recovery', { method: 'POST' })
  if (recovered.requiresProcessRestart === true) {
    await killServer(false, false)
    if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
    await startLocalServer(stableProfileBinding(), expectedGeneration)
    if (!localServerReady) throw new Error('PROFILE_STARTUP_RECOVERY_RESTART_FAILED')
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
  localProfileIdentity = gameProfileIdentityFromReference(report.server.profile as DesktopProfileReference)
}

function assertLocalGameOpeningCurrent(expectedGeneration: number): void {
  localGameLifecycle.assertOpeningCurrent(expectedGeneration)
}

async function startStableLocalServerAndRecover(expectedGeneration?: number): Promise<void> {
  await startStableProfileServerAndRecover(expectedGeneration)
  if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
  await startLocalGameAuthority(stableProfileBinding())
  if (expectedGeneration !== undefined) assertLocalGameOpeningCurrent(expectedGeneration)
}

async function startStableProfileServerAndRecover(expectedGeneration?: number): Promise<void> {
  await startLocalServer(stableProfileBinding(), expectedGeneration)
  await recoverProfileOnStartup(expectedGeneration)
}

// ─── 资源包管理（Electron IPC，替代 Android 端的 Service Worker 方案）────────

async function serveClientProtocolRequest(
  request: GlobalRequest,
  fixedActivePackRoot?: string | null,
  smokeServerUrl?: string,
): Promise<Response> {
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
    if (relativePath === '__profile-smoke__.html' && smokeServerUrl) {
      const serverLiteral = JSON.stringify(smokeServerUrl)
      return new Response(
        `<script>localStorage.setItem('rvb_server_url', ${serverLiteral});location.replace('${CLIENT_SCHEME}://app/index.html?profile-smoke=1')</script>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }
    const activePackRoot = fixedActivePackRoot === undefined
      ? (isActivatableResourcePackPath(relativePath)
          ? resolveActiveResourcePackRoot(getPackRoot())
          : null)
      : fixedActivePackRoot
    const target = resolveClientProtocolFile({
      relativePath,
      htmlRoot: getHtmlRoot(),
      appRoot: getAppRoot(),
      activePackRoot,
      isPackaged: app.isPackaged,
    })
    if (!target) return new Response('Not found', { status: 404 })
    return electronNet.fetch(pathToFileURL(target).toString())
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

async function setupPackProtocol(): Promise<void> {
  await session.defaultSession.protocol.handle(CLIENT_SCHEME, request => (
    serveClientProtocolRequest(request)
  ))
}

/** IPC: import one complete archive into an isolated immutable version. */
handleTrusted('pack-import-from-path', ['game'], async (_e, zipPath: string) => {
  try {
    return await enqueueProfileMutation(async () => installProfileArchive(await readProfileArchive(zipPath)))
  } catch (e) {
    console.error('[pack-import] Failed:', e)
    return { ok: false, error: String(e) }
  }
})

handleTrusted('pack-import-data', ['game'], async (_e, base64Data: string) => {
  try {
    return await enqueueProfileMutation(() => installProfileArchive(decodeProfileArchive(base64Data)))
  } catch (e) {
    console.error('[pack-import] Failed:', e)
    return { ok: false, error: String(e) }
  }
})

handleTrusted('pack-activate', ['game', 'admin'], async (_event, targetProfileHash: string) => {
  return enqueueProfileMutation(() => activateProfileHash(targetProfileHash))
})

handleTrusted('pack-rollback', ['game', 'admin'], async (_event, target: 'previous-stable' | 'bundled-base') => {
  try {
    if (target !== 'previous-stable' && target !== 'bundled-base') {
      throw new Error('Invalid profile rollback target')
    }
    return await enqueueProfileMutation(() => selectAndActivateRollback(target))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/** IPC compatibility: clear means an explicit, verified rollback to bundled Base. */
handleTrusted('pack-clear', ['game'], async () => {
  try {
    return await enqueueProfileMutation(() => selectAndActivateRollback('bundled-base'))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/** IPC: 列出当前资源包中的所有文件路径 */
handleTrusted('pack-list', ['game'], async () => {
  try {
    const status = await profileApiRequest('/api/content-profile')
    return {
      ok: true,
      files: listActiveResourcePackFiles(getPackRoot()),
      meta: getActiveResourcePackMeta(getPackRoot()),
      ...status,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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

// Retained for the existing admin window entry point wired by packaged shells.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    if (!gameServerProcess || !localGameReady) return
    win.webContents.executeJavaScript(`
      (function() {
        var url = 'http://127.0.0.1:${actualGamePort}';
        if (window.RvBUtils && RvBUtils.saveServerConfig) {
          RvBUtils.saveServerConfig({ mode: 'local', url: url });
        } else {
          localStorage.setItem('rvb_server_url', url);
          localStorage.setItem('rvb_lobby_server_mode', 'local');
          localStorage.setItem('rvb_local_server_url', url);
          localStorage.setItem('rvb_remote_server_url', url);
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
  if (localGameLifecycle.shutdownInProgress) {
    return { ok: false, error: '本地主机正在停止，请稍后重试。' }
  }
  if (localGameOpenPromise) return await localGameOpenPromise
  const openingGeneration = localGameLifecycle.beginOpening()
  const opening = (async (): Promise<{ ok: boolean; error?: string }> => {
    clearOnlineServerUrl()
    try {
      await startStableLocalServerAndRecover(openingGeneration)
    } catch (error) {
      console.error('[client] local authority startup failed:', error)
      return { ok: false, error: localAuthorityStartupErrorMessage(error) }
    }
    if (!localGameReady) {
      const exitMsg = lastServerExitCode !== null
        ? `Colyseus/PostgreSQL authority exited with code ${lastServerExitCode}`
        : 'Colyseus/PostgreSQL authority did not become ready'
      const detail = lastServerStderr ? '\n' + lastServerStderr.slice(-500) : ''
      return { ok: false, error: exitMsg + detail }
    }
    if (connectWin && !connectWin.isDestroyed()) {
      connectWin.close()
      connectWin = null
    }
    loadLocalGame()
    return { ok: true }
  })()
  localGameOpenPromise = opening
  try {
    return await opening
  } finally {
    if (localGameOpenPromise === opening) localGameOpenPromise = null
  }
})

// 查询当前模式
handleTrusted('get-mode', ['game'], () => ({
  isLocal: localGameReady,
  localUrl: `http://127.0.0.1:${actualGamePort}`,
  profileRuntimeUrl: `http://127.0.0.1:${actualLocalPort}`,
  profileIdentity: localProfileIdentity,
  localAuthorityProfileIdentity,
  ready: localGameReady,
}))

// 重启本地服务器
handleTrusted('restart-server', ['admin'], async () => {
  await killServer()
  await new Promise(resolve => setTimeout(resolve, 1000))
  await startStableLocalServerAndRecover()
  return { ok: localGameReady }
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
  return { port: actualGamePort, ips, running: gameServerProcess !== null && localGameReady, ready: localGameReady }
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
  const port = actualGamePort

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
    return await profileApiRequest('/api/content-profile')
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
})

// 资源包上传（文件路径）
handleTrusted('upload-resource-pack', ['admin'], async (_event, filePath: string) => {
  try {
    const result = await enqueueProfileMutation(async () => installProfileArchive(await readProfileArchive(filePath)))
    return { success: result.ok === true, message: result.ok === true ? 'Profile installed as candidate' : result.error, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message, error: message }
  }
})

// 资源包上传（base64 数据）
handleTrusted('upload-resource-pack-data', ['admin'], async (_event, base64: string, filename: string) => {
  try {
    void filename
    const result = await enqueueProfileMutation(() => installProfileArchive(decodeProfileArchive(base64)))
    return { success: result.ok === true, message: result.ok === true ? 'Profile installed as candidate' : result.error, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message, error: message }
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
process.on('exit', () => { try { forceKillServer() } catch {} })
process.on('SIGINT', requestApplicationExit)
process.on('SIGTERM', requestApplicationExit)

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

  try {
    // Remote joiners only need the lightweight Profile service. The bundled
    // PostgreSQL/Colyseus authority starts lazily when the player chooses LAN host.
    await startStableProfileServerAndRecover()
  } catch (error) {
    console.error('[profile] startup recovery failed; admission remains closed:', error)
    return
  }
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
  if (process.platform !== 'darwin') {
    requestApplicationExit()
  }
})

app.on('before-quit', event => {
  if (allowAppExit) return
  event.preventDefault()
  requestApplicationExit()
})

// 关键兜底：所有窗口都关闭、quit 完成后强制退出主进程，
// 杜绝 Electron GPU/renderer/utility 子进程残留。
app.on('quit', () => { try { process.exit(0) } catch {} })

app.on('activate', () => {
  if (!mainWin || mainWin.isDestroyed()) loadLocalGame()
})
