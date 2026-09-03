import { execFile, execFileSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomBytes } from 'crypto'

const POSTGRES_USER = 'rvb'
const POSTGRES_DATABASE = 'rvb_colyseus'
const STARTUP_TIMEOUT_MS = 30_000
const INITIALIZATION_TIMEOUT_MS = 90_000
const HEALTH_PROBE_INTERVAL_MS = 2_000
const POSTGRES_VERSION = '16.15-2'
const POSTGRES_SOURCE_URL = 'https://get.enterprisedb.com/postgresql/postgresql-16.15-2-windows-x64-binaries.zip'
const POSTGRES_ARCHIVE_SHA256 = '840b9d265f6ab6c0a971c1d8e9096de564950d38dc2a5ccd98c8820179ecf115'
const POSTGRES_MANIFEST_SHA256 = '2cf0c900925debf9ec04a38ab26266a60ffd25f37190498e288a98fa4a863313'
const POSTGRES_INVENTORY_COUNT = 1618
const ALLOWED_RUNTIME_PREFIXES = ['pgsql/bin/', 'pgsql/lib/', 'pgsql/share/']
const ALLOWED_RUNTIME_FILES = new Set([
  'licenses/server_license.txt',
  'licenses/commandlinetools_3rd_party_licenses.txt',
])

type RuntimeManifestFile = { path: string; size: number; sha256: string }
type RuntimeManifest = {
  formatVersion: number
  product: string
  version: string
  platform: string
  sourceUrl: string
  archiveSha256: string
  files: RuntimeManifestFile[]
}

export type EmbeddedPostgresOptions = {
  runtimeRoot: string
  stateRoot: string
  findFreePort: (hint: number) => Promise<number>
  protectSecret: (plaintext: string) => Buffer
  unprotectSecret: (encrypted: Buffer) => string
  removeFile?: (filePath: string) => void
  portHint?: number
  onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onHealthStateChange?: (state: EmbeddedPostgresHealthState) => void
}

export type EmbeddedPostgresConnection = {
  url: string
  port: number
}

export type EmbeddedPostgresHealthState = {
  state: 'healthy' | 'degraded' | 'lost'
  consecutiveFailures: number
  detail?: string
}

export type EmbeddedPostgresHealthMonitorOptions = {
  intervalMs: number
  failureThreshold: number
  probe: () => Promise<void>
  confirmProcessRunning: () => Promise<boolean>
  onStateChange?: (state: EmbeddedPostgresHealthState) => void
  onConfirmedLoss: () => void
}

/**
 * Schedules the next readiness probe only after the previous probe and any
 * liveness confirmation have completed. Readiness degradation alone is not
 * authority loss: the owning postgres process must independently be gone.
 */
export class EmbeddedPostgresHealthMonitor {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private failures = 0
  private lastState: EmbeddedPostgresHealthState['state'] | null = null

  constructor(private readonly options: EmbeddedPostgresHealthMonitorOptions) {}

  start(): void {
    this.stop()
    this.stopped = false
    this.failures = 0
    this.lastState = null
    this.emit('healthy')
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private emit(state: EmbeddedPostgresHealthState['state'], detail?: string): void {
    if (this.lastState === state && !detail) return
    this.lastState = state
    this.options.onStateChange?.({
      state,
      consecutiveFailures: this.failures,
      ...(detail ? { detail } : {}),
    })
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runProbe()
    }, this.options.intervalMs)
    this.timer.unref?.()
  }

  private async runProbe(): Promise<void> {
    if (this.stopped) return
    try {
      await this.options.probe()
      this.failures = 0
      this.emit('healthy')
    } catch (error) {
      this.failures += 1
      const detail = error instanceof Error ? error.message : String(error)
      this.emit('degraded', detail)
      if (this.failures >= this.options.failureThreshold) {
        let processRunning = true
        try {
          processRunning = await this.options.confirmProcessRunning()
        } catch (confirmationError) {
          // An inconclusive confirmation must not terminate a healthy authority.
          this.emit(
            'degraded',
            `readiness failed; process check inconclusive: ${confirmationError instanceof Error ? confirmationError.message : String(confirmationError)}`,
          )
        }
        if (!processRunning) {
          this.emit('lost', detail)
          this.stop()
          this.options.onConfirmedLoss()
          return
        }
        this.failures = 0
      }
    }
    this.schedule()
  }
}

function commandError(command: string, error: unknown, stderr = ''): Error {
  const message = error instanceof Error ? error.message : String(error)
  const detail = stderr.trim().slice(-1000)
  return new Error(`${command} failed: ${message}${detail ? `\n${detail}` : ''}`)
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listFiles(root: string, relativeRoot = ''): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(path.join(root, relativeRoot), { withFileTypes: true })) {
    const relative = path.posix.join(relativeRoot.replace(/\\/g, '/'), entry.name)
    if (entry.isDirectory()) files.push(...listFiles(root, relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function isAllowedRuntimePath(relative: string): boolean {
  return ALLOWED_RUNTIME_FILES.has(relative)
    || ALLOWED_RUNTIME_PREFIXES.some(prefix => relative.startsWith(prefix))
}

function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = STARTUP_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      env,
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(commandError(path.basename(executable), error, stderr))
      else resolve(stdout)
    })
  })
}

function runQuietCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = STARTUP_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`${path.basename(executable)} timed out after ${timeout}ms`))
    }, timeout)
    timer.unref?.()
    child.once('error', error => {
      clearTimeout(timer)
      reject(commandError(path.basename(executable), error))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(executable)} exited with code ${code ?? 'null'}`))
    })
  })
}

export class EmbeddedPostgresController {
  private readonly binRoot: string
  private readonly dataRoot: string
  private readonly dataDir: string
  private readonly credentialPath: string
  private stopping = false
  private connection: EmbeddedPostgresConnection | null = null
  private startPromise: Promise<EmbeddedPostgresConnection> | null = null
  private healthMonitor: EmbeddedPostgresHealthMonitor | null = null
  private runtimeVerified = false

  constructor(private readonly options: EmbeddedPostgresOptions) {
    this.binRoot = path.join(options.runtimeRoot, 'bin')
    this.dataRoot = options.stateRoot
    this.dataDir = path.join(options.stateRoot, 'data')
    this.credentialPath = path.join(options.stateRoot, 'credential.bin')
  }

  get isRunning(): boolean {
    return this.connection !== null
  }

  async start(): Promise<EmbeddedPostgresConnection> {
    if (this.connection) return this.connection
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private executable(name: string): string {
    const target = path.join(this.binRoot, process.platform === 'win32' ? `${name}.exe` : name)
    if (!fs.existsSync(target)) throw new Error(`Embedded PostgreSQL runtime is missing ${target}`)
    return target
  }

  private verifyRuntime(): void {
    if (this.runtimeVerified) return
    const packageRoot = path.dirname(this.options.runtimeRoot)
    const manifestPath = path.join(packageRoot, 'runtime-manifest.json')
    if (!fs.existsSync(manifestPath) || sha256File(manifestPath) !== POSTGRES_MANIFEST_SHA256) {
      throw new Error('Embedded PostgreSQL runtime manifest SHA-256 mismatch')
    }
    let manifest: RuntimeManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest
    } catch (error) {
      throw commandError('Embedded PostgreSQL runtime manifest verification', error)
    }
    if (
      manifest.formatVersion !== 1
      || manifest.product !== 'PostgreSQL'
      || manifest.version !== POSTGRES_VERSION
      || manifest.platform !== 'win32-x64'
      || manifest.sourceUrl !== POSTGRES_SOURCE_URL
      || manifest.archiveSha256 !== POSTGRES_ARCHIVE_SHA256
      || !Array.isArray(manifest.files)
      || manifest.files.length !== POSTGRES_INVENTORY_COUNT
    ) {
      throw new Error('Embedded PostgreSQL runtime manifest is unsupported or incomplete')
    }
    const issues: string[] = []
    const declared = new Set<string>()
    for (const file of manifest.files) {
      const relative = String(file.path)
      if (
        relative.includes('..')
        || relative.includes('\\')
        || path.isAbsolute(relative)
        || !isAllowedRuntimePath(relative)
      ) {
        issues.push(`unsafe path ${relative}`)
        continue
      }
      if (declared.has(relative)) {
        issues.push(`duplicate path ${relative}`)
        continue
      }
      declared.add(relative)
      const target = path.join(packageRoot, ...relative.split('/'))
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        issues.push(`missing ${relative}`)
        continue
      }
      const stat = fs.statSync(target)
      if (stat.size !== file.size) issues.push(`size mismatch ${relative}`)
      else if (sha256File(target) !== file.sha256) issues.push(`SHA-256 mismatch ${relative}`)
    }
    for (const relative of listFiles(packageRoot)) {
      if (relative !== 'runtime-manifest.json' && !declared.has(relative)) {
        issues.push(`unexpected file ${relative}`)
      }
    }
    if (issues.length > 0) {
      throw new Error(`Embedded PostgreSQL runtime verification failed: ${issues.slice(0, 10).join('; ')}`)
    }
    this.runtimeVerified = true
  }

  private commandEnv(password?: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${this.binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      ...(password ? { PGPASSWORD: password } : {}),
    }
  }

  private removeFile(filePath: string): void {
    (this.options.removeFile ?? fs.unlinkSync)(filePath)
  }

  private loadOrCreatePassword(clusterExists: boolean): string {
    if (fs.existsSync(this.credentialPath)) {
      const encrypted = fs.readFileSync(this.credentialPath)
      return this.options.unprotectSecret(encrypted)
    }
    if (clusterExists) {
      throw new Error('Embedded PostgreSQL credentials are missing for the existing data cluster')
    }
    const password = randomBytes(32).toString('base64url')
    const encrypted = this.options.protectSecret(password)
    fs.mkdirSync(this.dataRoot, { recursive: true })
    fs.writeFileSync(this.credentialPath, encrypted, { mode: 0o600 })
    return password
  }

  private async initializeCluster(password: string): Promise<void> {
    const passwordFile = path.join(this.dataRoot, `.init-password-${process.pid}-${Date.now()}`)
    fs.mkdirSync(this.dataRoot, { recursive: true })
    for (const entry of fs.readdirSync(this.dataRoot)) {
      if (!entry.startsWith('.init-password-')) continue
      const stalePath = path.join(this.dataRoot, entry)
      this.removeFile(stalePath)
    }
    fs.writeFileSync(passwordFile, password, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    let initializationError: unknown = null
    try {
      await runCommand(this.executable('initdb'), [
        '-D', this.dataDir,
        '--username', POSTGRES_USER,
        '--pwfile', passwordFile,
        '--encoding', 'UTF8',
        // Windows legacy code-page locales (for example zh-CN CP936) do not
        // always map to a PostgreSQL text search configuration. Keep the
        // private cluster deterministic and UTF-8 on every Windows locale.
        '--no-locale',
        '--auth-host', 'scram-sha-256',
        '--auth-local', 'scram-sha-256',
      ], this.commandEnv(), INITIALIZATION_TIMEOUT_MS)
    } catch (error) {
      initializationError = error
    } finally {
      try {
        this.removeFile(passwordFile)
      } catch (cleanupError) {
        throw commandError('Temporary PostgreSQL credential cleanup', cleanupError)
      }
    }
    if (initializationError) throw initializationError
  }

  private async waitUntilReady(port: number, password: string): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError: unknown = null
    while (Date.now() < deadline) {
      try {
        await runCommand(this.executable('pg_isready'), [
          '-h', '127.0.0.1', '-p', String(port), '-U', POSTGRES_USER, '-d', 'postgres', '-q',
        ], this.commandEnv(password), 2_000)
        return
      } catch (error) {
        lastError = error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw commandError('pg_isready', lastError ?? new Error('startup timeout'))
  }

  private async ensureDatabase(port: number, password: string): Promise<void> {
    const connectionArgs = ['-h', '127.0.0.1', '-p', String(port), '-U', POSTGRES_USER]
    const existing = await runCommand(this.executable('psql'), [
      ...connectionArgs,
      '-d', 'postgres',
      '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DATABASE}'`,
    ], this.commandEnv(password))
    if (existing.trim() === '1') return
    await runCommand(this.executable('createdb'), [
      ...connectionArgs,
      '--encoding', 'UTF8',
      POSTGRES_DATABASE,
    ], this.commandEnv(password))
  }

  private async startInternal(): Promise<EmbeddedPostgresConnection> {
    this.verifyRuntime()
    const clusterExists = fs.existsSync(path.join(this.dataDir, 'PG_VERSION'))
    const password = this.loadOrCreatePassword(clusterExists)
    if (!clusterExists) await this.initializeCluster(password)
    let priorServerRunning = false
    try {
      await runQuietCommand(this.executable('pg_ctl'), ['status', '-D', this.dataDir], this.commandEnv(), 5_000)
      priorServerRunning = true
    } catch {
      // pg_ctl status exits non-zero when no previous server owns this cluster.
    }
    if (priorServerRunning) {
      await runQuietCommand(this.executable('pg_ctl'), [
        'stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '15',
      ], this.commandEnv(), 20_000)
    }
    const port = await this.options.findFreePort(this.options.portHint ?? 38721)
    this.stopping = false
    const logPath = path.join(this.dataRoot, 'postgres.log')
    try {
      // On Windows pg_ctl deliberately creates the server with a restricted
      // token, allowing safe startup even when the Electron parent is elevated.
      await runQuietCommand(this.executable('pg_ctl'), [
        'start', '-D', this.dataDir,
        '-l', logPath,
        '-o', `-h 127.0.0.1 -p ${port} -c password_encryption=scram-sha-256`,
        '-w', '-t', '30',
      ], this.commandEnv(), STARTUP_TIMEOUT_MS + 5_000)
      await this.waitUntilReady(port, password)
      await this.ensureDatabase(port, password)
    } catch (error) {
      try {
        await runQuietCommand(this.executable('pg_ctl'), [
          'stop', '-D', this.dataDir, '-m', 'immediate', '-w', '-t', '5',
        ], this.commandEnv(), 8_000)
      } catch {}
      const logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : ''
      throw new Error(`${error instanceof Error ? error.message : String(error)}${logTail ? `\n${logTail}` : ''}`)
    }
    const encodedPassword = encodeURIComponent(password)
    this.connection = {
      port,
      url: `postgresql://${POSTGRES_USER}:${encodedPassword}@127.0.0.1:${port}/${POSTGRES_DATABASE}?sslmode=disable`,
    }
    this.startHealthMonitor()
    return this.connection
  }

  private startHealthMonitor(): void {
    this.healthMonitor?.stop()
    this.healthMonitor = new EmbeddedPostgresHealthMonitor({
      // Runtime pg_isready subprocesses produced false failures on a busy
      // Windows host and killed probe connections mid-handshake. Startup still
      // performs a real readiness check; runtime ownership can be monitored
      // without spawning a process or opening another database connection.
      intervalMs: HEALTH_PROBE_INTERVAL_MS,
      failureThreshold: 1,
      probe: async () => {
        if (this.stopping || !this.connection) return
        if (!await this.queryPostgresProcessRunning()) {
          throw new Error('Bundled PostgreSQL owner process is not running')
        }
      },
      confirmProcessRunning: async () => this.queryPostgresProcessRunning(),
      onStateChange: state => this.options.onHealthStateChange?.(state),
      onConfirmedLoss: () => {
        if (this.stopping || !this.connection) return
        this.connection = null
        this.options.onUnexpectedExit?.(null, null)
      },
    })
    this.healthMonitor.start()
  }

  private queryPostgresProcessRunning(): Promise<boolean> {
    const pidPath = path.join(this.dataDir, 'postmaster.pid')
    let pidText: string
    try {
      pidText = fs.readFileSync(pidPath, 'utf8').split(/\r?\n/, 1)[0] ?? ''
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Promise.resolve(false)
      return Promise.reject(commandError('PostgreSQL owner PID read', error))
    }
    const pid = Number.parseInt(pidText.trim(), 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return Promise.reject(new Error('Bundled PostgreSQL owner PID is invalid'))
    }
    try {
      process.kill(pid, 0)
      return Promise.resolve(true)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return Promise.resolve(false)
      // A protected but existing process still owns the cluster. Treat access
      // denial as alive and fail safe on any other inconclusive OS error.
      if (code === 'EPERM') return Promise.resolve(true)
      return Promise.reject(commandError('PostgreSQL owner process check', error))
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.healthMonitor?.stop()
    this.healthMonitor = null
    try {
      if (fs.existsSync(path.join(this.dataDir, 'postmaster.pid'))) {
        console.info('[postgres] Stopping bundled PostgreSQL with fast shutdown')
        await runQuietCommand(this.executable('pg_ctl'), [
          'stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '15',
        ], this.commandEnv(), 20_000)
        console.info('[postgres] Bundled PostgreSQL stopped')
      }
    } finally {
      this.connection = null
      this.stopping = false
    }
  }

  forceStop(): void {
    this.healthMonitor?.stop()
    this.healthMonitor = null
    this.connection = null
    this.stopping = true
    try {
      if (fs.existsSync(path.join(this.dataDir, 'postmaster.pid'))) {
        console.warn('[postgres] Forcing bundled PostgreSQL immediate shutdown during process exit')
        execFileSync(this.executable('pg_ctl'), [
          'stop', '-D', this.dataDir, '-m', 'immediate', '-w', '-t', '5',
        ], { env: this.commandEnv(), windowsHide: true, timeout: 8_000, stdio: 'ignore' })
      }
    } catch {}
  }
}
