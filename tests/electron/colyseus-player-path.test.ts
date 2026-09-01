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
    expect(main).toContain("localUrl: `http://localhost:${actualGamePort}`")
    expect(main).toContain("var url = 'http://localhost:${actualGamePort}';")
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

  it('starts the LAN database lazily while remote joiners only start the Profile service', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const readyHandler = main.slice(main.indexOf('app.whenReady().then'), main.indexOf("app.on('window-all-closed'"))
    const openLocalHandler = main.slice(main.indexOf("handleTrusted('open-local-game'"), main.indexOf("handleTrusted('get-mode'"))

    expect(readyHandler).toContain('await startStableProfileServerAndRecover()')
    expect(readyHandler).not.toContain('await startStableLocalServerAndRecover()')
    expect(openLocalHandler).toContain('await startStableLocalServerAndRecover()')
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

  it('requires a durable authority acknowledgement before normal application exit', async () => {
    const main = await readFile(path.join(ROOT, 'electron-client', 'main.ts'), 'utf8')
    const exitHandler = main.slice(main.indexOf('function requestApplicationExit()'), main.indexOf('// ─── 本地服务器管理'))
    const runner = await readFile(path.join(ROOT, 'scripts', 'run-colyseus-server.mjs'), 'utf8')

    expect(exitHandler).toContain('killServer(true)')
    expect(exitHandler).toContain('processes remain fail-closed')
    expect(runner.indexOf('await journal.close()')).toBeLessThan(runner.indexOf('await server.gracefullyShutdown(false)'))
    expect(runner.indexOf('await server.gracefullyShutdown(false)')).toBeLessThan(runner.indexOf('ok: true'))
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
      main.indexOf('async function startLocalGameAuthority('),
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
