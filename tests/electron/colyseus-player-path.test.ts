import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const PLAYER_PAGES = ['index.html', 'lobby.html', 'room.html', 'piece-selection.html', 'battle.html']

describe('RED-161 default player transport', () => {
  it('loads the Colyseus SDK before the compatibility client on every player page', async () => {
    for (const page of PLAYER_PAGES) {
      const source = await readFile(path.join(ROOT, 'data', 'pages', page), 'utf8')
      const sdk = source.indexOf('js/colyseus-sdk.js')
      const adapter = source.indexOf('js/ws-client.js')
      expect(sdk, `${page} SDK tag`).toBeGreaterThan(0)
      expect(adapter, `${page} adapter tag`).toBeGreaterThan(sdk)
    }
  })

  it('routes room and battle traffic through Colyseus without the legacy websocket endpoint', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'js', 'ws-client.js'), 'utf8')
    expect(source).toContain('new Colyseus.Client(base)')
    expect(source).toContain("_client.joinById(_roomId")
    expect(source).toContain("_room.send('battleCommand', message)")
    expect(source).toContain("_room.send('battleResync', {})")
    expect(source).not.toContain('/ws/rooms/')
    expect(source).not.toContain('new WebSocket(')
  })

  it('routes authoritative rejections through the existing action-error interaction flow', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'js', 'ws-client.js'), 'utf8')
    expect(source).toContain("message && message.kind === 'rejected' ? 'actionError' : 'battleReceipt'")
  })

  it('keeps the turn timer enabled in the manual Colyseus acceptance server', async () => {
    const source = await readFile(path.join(ROOT, 'scripts', 'run-colyseus-qa-server.mjs'), 'utf8')
    expect(source).toContain("process.env.RVB_TURN_TIMER_ENABLED = '1'")
    expect(source).not.toContain("process.env.RVB_TURN_TIMER_ENABLED = '0'")
  })

  it('preserves the opaque case-sensitive Colyseus room id at battle admission', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'battle.html'), 'utf8')
    expect(source).toContain("const roomId = (params.get('roomId') || '').trim()")
    expect(source).not.toContain("params.get('roomId') || '').trim().toLowerCase()")
  })

  it('starts and publishes the packaged Colyseus authority as the Electron local game endpoint', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const colyseusBuild = await readFile(path.join(ROOT, 'scripts', 'build-colyseus-server.mjs'), 'utf8')
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
    const builder = JSON.parse(await readFile(path.join(ROOT, 'electron-builder.client.json'), 'utf8'))
    expect(main).toContain("findColyseusEntry(appRoot)")
    expect(main).toContain("RVB_POSTGRES_URL: databaseUrl")
    expect(main).toContain('await resolveAuthorityDatabaseUrl()')
    expect(main).toContain("path.join(process.resourcesPath, 'postgres', 'pgsql')")
    expect(main).toContain('safeStorage.encryptString(plaintext)')
    expect(main).toContain('await embeddedPostgres.stop()')
    expect(main).toContain("localUrl: `http://127.0.0.1:${actualGamePort}`")
    expect(main).toContain("var url = 'http://127.0.0.1:${actualGamePort}';")
    expect(packageJson.scripts['build:electron:client']).toContain('npm run build:colyseus')
    expect(packageJson.scripts['build:electron:client']).toContain('npm run prepare:embedded-postgres')
    expect(colyseusBuild).toContain("'@prisma/client'")
    expect(colyseusBuild).toContain("'new PrismaClient'")
    expect(colyseusBuild).toContain("'PRAGMA '")
    // Root dependencies are excluded from the Electron app. The Next runtime and
    // Node-targeted Colyseus authority are staged separately, so rebuilding every
    // optional root native addon against Electron would be both unnecessary and
    // would make a clean package require Visual Studio Build Tools.
    expect(builder.npmRebuild).toBe(false)
    expect(builder.extraResources).toContainEqual({ from: '_client-colyseus', to: 'app/standalone/colyseus' })
    expect(builder.extraResources).toContainEqual({ from: '_client-postgres', to: 'postgres' })
  })

  it('keeps legacy raw player WebSocket authority out of default dev/start and candidate startup', async () => {
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
    const instrumentation = await readFile(path.join(ROOT, 'instrumentation.ts'), 'utf8')
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')

    expect(packageJson.scripts.dev).toBe('next dev')
    expect(packageJson.scripts.start).toBe('next start')
    expect(instrumentation).toContain("process.env.ENABLE_LEGACY_PLAYER_WS === '1'")
    expect(main).toContain("DISABLE_WS: '1'")
  })

  it('bounds authority recovery to three attempts and keeps non-match recovery silent', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    expect(main).toContain('if (!expectedExit) void recoverUnexpectedLocalAuthorityExit(code)')
    expect(main).toContain('const LOCAL_AUTHORITY_AUTO_RECOVERY_MAX_ATTEMPTS = 3')
    expect(main).toContain('localAuthorityRecoveryBudget.claimAttempt()')
    expect(main).toContain('localAuthorityRecoveryBudget.recordFailure()')
    expect(main).toContain('localAuthorityRecoveryBudget.recordSuccess()')
    expect(main).toContain('localAuthorityRecoveryBudget.rearm()')
    expect(main).toContain("'manual-required'")
    const recovery = main.slice(
      main.indexOf('function recoverUnexpectedLocalAuthorityExit('),
      main.indexOf('async function startLocalGameAuthority(', main.indexOf('function recoverUnexpectedLocalAuthorityExit(')),
    )
    expect(recovery).not.toContain('loadLocalGame()')
    expect(main).not.toContain('setInterval(recoverUnexpectedLocalAuthorityExit')
  })

  it('prepares the local authority automatically and opens the main menu without the connection gate', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const index = await readFile(path.join(ROOT, 'data', 'pages', 'index.html'), 'utf8')
    const readyHandler = main.slice(main.indexOf('app.whenReady().then'), main.indexOf("app.on('window-all-closed'"))

    expect(readyHandler).toContain('await startStableLocalServerAndRecover()')
    expect(readyHandler).toContain('loadLocalGame()')
    expect(readyHandler).not.toContain('openConnectWindow()')
    expect(main).toContain("handleTrusted('ensure-local-authority', ['game']")
    expect(main).toContain("path.join(logDir, 'authority.log')")
    expect(main).toContain("'postgresql://<redacted>@'")
    expect(index).toContain('async function retryHostService()')
    expect(index).toContain('await showHostSheet(true)')
    expect(index).toContain("forceRetry === true")
  })

  it('shows a stable fail-closed diagnostic when the bundled authority cannot start', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const connect = await readFile(path.join(ROOT, 'electron-client', 'connect', 'index.html'), 'utf8')
    const openLocalHandler = main.slice(main.indexOf("handleTrusted('open-local-game'"), main.indexOf("handleTrusted('get-mode'"))

    expect(openLocalHandler).toContain('try {')
    expect(openLocalHandler).toContain('localAuthorityStartupErrorMessage(error)')
    expect(connect).toContain('const result = await api.openLocalGame()')
    expect(connect).toContain('客户端通信异常，请查看日志')
  })

  it('single-flights repeated local host startup requests', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const wrapperStart = main.indexOf('async function startLocalGameAuthority(')
    const wrapperEnd = main.indexOf('function findServerEntry(', wrapperStart)
    const wrapper = main.slice(wrapperStart, wrapperEnd)
    const openLocalHandler = main.slice(main.indexOf("handleTrusted('open-local-game'"), main.indexOf("handleTrusted('get-mode'"))

    expect(main).toContain('let localGameStartupPromise: Promise<void> | null = null')
    expect(main).toContain('let localGameOpenPromise: Promise<{ ok: boolean; error?: string }> | null = null')
    expect(main).toContain('const localGameLifecycle = new LocalGameLifecycleGate()')
    expect(main).toContain('async function startLocalGameAuthorityOnce(')
    expect(main).toContain('await killServer(false, false)')
    expect(main).toContain('assertLocalGameOpeningCurrent(expectedGeneration)')
    expect(main).toMatch(/actualLocalPort = await findFreePort\(LOCAL_PORT_HINT\)\s+if \(expectedGeneration !== undefined\) assertLocalGameOpeningCurrent\(expectedGeneration\)/)
    expect(main).toContain('await startLocalServer(stableProfileBinding(), expectedGeneration)')
    expect(wrapper).toContain('if (localGameStartupPromise)')
    expect(wrapper).toContain('await localGameStartupPromise')
    expect(wrapper).toContain('localGameStartupPromise = startup')
    expect(wrapper).toContain('localGameStartupPromise = null')
    expect(openLocalHandler).toContain('if (localGameOpenPromise) return await localGameOpenPromise')
    expect(openLocalHandler).toContain('localGameOpenPromise = opening')
    expect(openLocalHandler).toContain('localGameOpenPromise = null')
    expect(openLocalHandler).toContain('const openingGeneration = localGameLifecycle.beginOpening()')
    expect(openLocalHandler).toContain('startStableLocalServerAndRecover(openingGeneration)')
  })

  it('requires a durable authority acknowledgement before normal application exit', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const exitHandler = main.slice(main.indexOf('function requestApplicationExit()'), main.indexOf('// ─── 本地服务器管理'))
    const stopHandler = main.slice(main.indexOf('async function killServer('), main.indexOf('function forceKillServer()'))
    const runner = await readFile(path.join(ROOT, 'scripts', 'run-colyseus-server.mjs'), 'utf8')

    expect(exitHandler).toContain('killServer(true)')
    expect(exitHandler).toContain('processes remain fail-closed')
    expect(stopHandler).toContain('await stopChildProcessGracefully(gameProc, requireDurable)')
    expect(stopHandler).toContain('killProcessTree(profileProc)')
    expect(stopHandler).not.toContain('stopChildProcessGracefully(profileProc')
    expect(runner.indexOf('await journal.close()')).toBeLessThan(runner.indexOf('await server.gracefullyShutdown(false)'))
    expect(runner.indexOf('await server.gracefullyShutdown(false)')).toBeLessThan(runner.indexOf('ok: true'))
  })

  it('publishes the recovered local Profile identity through trusted Electron IPC', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const index = await readFile(path.join(ROOT, 'data', 'pages', 'index.html'), 'utf8')
    const lobby = await readFile(path.join(ROOT, 'data', 'pages', 'lobby.html'), 'utf8')

    expect(main).toContain('profileIdentity: localProfileIdentity')
    expect(main).toContain('localAuthorityProfileIdentity,')
    expect(main).toContain('await fetchAuthorityProfileIdentity(actualGamePort)')
    expect(main).toContain('refreshLocalProfileIdentity(targetProfileHash)')
    expect(main).toContain("runnerRevision: 'rvb-battle-runner/v1'")
    for (const source of [index, lobby]) {
      const start = source.indexOf('async function getLocalGameProfileIdentity')
      const end = source.indexOf(
        source === index ? 'async function checkProfileAndGo' : 'function summarizeGameProfileIdentity',
        start,
      )
      const getter = source.slice(start, end)
      expect(getter).toContain('mode.localAuthorityProfileIdentity')
      expect(getter).toContain('mode.profileIdentity')
      expect(getter).not.toContain('mode.profileRuntimeUrl')
    }
    const lobbyGetter = lobby.slice(
      lobby.indexOf('async function getLocalGameProfileIdentity'),
      lobby.indexOf('function summarizeGameProfileIdentity'),
    )
    expect(lobbyGetter.indexOf('window.electronAPI.getMode'))
      .toBeLessThan(lobbyGetter.indexOf('readStoredGameProfileIdentity()'))
  })

  it('keeps SQLite and Prisma out of the new Colyseus authority modules', async () => {
    const modules = [
      'battle-room.ts',
      'candidate-battle-store.ts',
      'create-colyseus-server.ts',
      'product-battle-store.ts',
    ]
    for (const moduleFile of modules) {
      const source = await readFile(path.join(ROOT, 'lib', 'server', 'colyseus', moduleFile), 'utf8')
      expect(source.toLowerCase(), moduleFile).not.toContain('sqlite')
      expect(source.toLowerCase(), moduleFile).not.toContain('prisma')
      expect(source, moduleFile).not.toMatch(/import(?!\s+type)[^\n]+room-store/)
    }
  })

  it('keeps the parallel Profile runtime fenced off from every legacy player authority ingress', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const legacyWs = await readFile(path.join(ROOT, 'lib', 'ws-server.ts'), 'utf8')
    const profileServer = await readFile(path.join(ROOT, 'scripts', 'ws-same-port-server.cjs'), 'utf8')
    const profileHealth = await readFile(path.join(ROOT, 'lib', 'content-pipeline', 'runtime', 'profile-runtime.ts'), 'utf8')
    const profileRuntime = main.slice(
      main.indexOf('async function startLocalServer('),
      main.indexOf('type JsonObject ='),
    )
    const gameAuthority = main.slice(
      main.indexOf('async function startLocalGameAuthorityOnce('),
      main.indexOf('function findServerEntry('),
    )

    expect(profileRuntime).toContain("DISABLE_WS: '1'")
    expect(profileRuntime).toContain("RVB_PROFILE_EXPECT_WEBSOCKET: '0'")
    expect(profileRuntime).toContain("RVB_BATTLE_AUTHORITY_V2: '0'")
    expect(profileRuntime).toContain("RVB_BATTLE_ASYNC_JOURNAL: '0'")
    expect(profileRuntime).toContain("RVB_TURN_TIMER_ENABLED: '0'")
    expect(profileHealth).toContain("process.env.RVB_PROFILE_EXPECT_WEBSOCKET !== '0'")
    expect(profileHealth).toContain('webSocketExpected ? webSocketRunning : !webSocketRunning')
    expect(gameAuthority).toContain("RVB_BATTLE_AUTHORITY_V2: '1'")
    expect(gameAuthority).toContain("RVB_BATTLE_ASYNC_JOURNAL: '1'")
    expect(gameAuthority).toContain("RVB_TURN_TIMER_ENABLED: '1'")
    expect(legacyWs).toMatch(/await quiesceWsServer\(\)\s+if \(process\.env\.DISABLE_WS === '1'\) \{[\s\S]*?return\s+\}/)
    expect(profileServer).toMatch(/if \(typeof handler !== 'function'\) \{\s+rejectUpgrade\(socket, '503 WebSocket Service Unavailable'\)/)
  })

  it('opens locally predictable skill targeting without a preparatory network round trip', async () => {
    const source = await readFile(path.join(ROOT, 'data', 'pages', 'battle.html'), 'utf8')
    expect(source).toContain('BattleLegalActions.probeSkillTarget({')
    expect(source).toContain('enterActionTargetMode(draftAction, localTargetProbe.preparation)')
  })

  it('installs the native server SHA-256 provider on the Colyseus hot path', async () => {
    const source = await readFile(path.join(ROOT, 'lib', 'server', 'colyseus', 'create-colyseus-server.ts'), 'utf8')
    expect(source).toContain("import { installNativeBattleSha256 } from '@/lib/server/battle-hash'")
    expect(source).toContain('installNativeBattleSha256()')
  })
})
