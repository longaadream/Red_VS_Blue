import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { shouldReportServerStartupFailure } from '../../electron/server-process-lifecycle'

const root = path.resolve(__dirname, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function browserWindowPreferences(relativePath: string): Map<string, ts.Expression>[] {
  const source = ts.createSourceFile(
    relativePath,
    read(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const results: Map<string, ts.Expression>[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'BrowserWindow'
    ) {
      const options = node.arguments?.[0]
      if (!options || !ts.isObjectLiteralExpression(options)) {
        throw new Error(`${relativePath} creates BrowserWindow without options`)
      }
      const webPreferences = options.properties.find((property) => (
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === 'webPreferences'
      ))
      if (!webPreferences || !ts.isPropertyAssignment(webPreferences) || !ts.isObjectLiteralExpression(webPreferences.initializer)) {
        throw new Error(`${relativePath} creates BrowserWindow without inline webPreferences`)
      }
      results.push(new Map(webPreferences.initializer.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return []
        return [[property.name.text, property.initializer] as const]
      })))
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return results
}

describe('Electron desktop security boundary', () => {
  test('does not report an intentional server stop as a startup failure', () => {
    expect(shouldReportServerStartupFailure(1, true)).toBe(false)
    expect(shouldReportServerStartupFailure(1, false)).toBe(true)
    expect(shouldReportServerStartupFailure(0, false)).toBe(false)
  })

  test('pins the remediated Electron runtime without the vulnerable extract-zip chain', () => {
    const packageJson = JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>
    }

    expect(packageJson.devDependencies.electron).toBe('43.4.0')
    expect(lock.packages['node_modules/electron']?.version).toBe('43.4.0')
    expect(lock.packages['node_modules/electron']?.dependencies).toHaveProperty('@electron-internal/extract-zip')
    expect(lock.packages).not.toHaveProperty('node_modules/extract-zip')
  })

  test.each([
    ['electron/main.ts', 1],
    ['electron-client/main.ts', 4],
    ['electron-editor/main.ts', 1],
  ])('%s applies the secure renderer preferences to every window', (relativePath, expectedWindows) => {
    const preferences = browserWindowPreferences(relativePath)

    expect(preferences).toHaveLength(expectedWindows)
    for (const preference of preferences) {
      expect(preference.get('contextIsolation')?.getText()).toBe('true')
      expect(preference.get('nodeIntegration')?.getText()).toBe('false')
      expect(preference.get('sandbox')?.getText()).toBe('true')
      expect(preference.get('webSecurity')?.getText()).toBe('true')
      expect(preference.has('preload')).toBe(true)
    }
  })

  test('applies an explicit candidate user-data directory before the Electron singleton lock', () => {
    for (const relativePath of ['electron/main.ts', 'electron-client/main.ts']) {
      const source = read(relativePath)
      const applyIndex = source.lastIndexOf('applyExplicitUserDataOverride()')
      const lockIndex = source.indexOf('app.requestSingleInstanceLock()')
      expect(source).toContain("const prefix = '--rvb-user-data-dir='")
      expect(source).toContain('process.env.RVB_ELECTRON_USER_DATA_DIR')
      expect(source).toContain("path.dirname(resolvedPath) === resolvedPath")
      expect(source).toContain("app.setPath('userData', resolvedPath)")
      expect(source).toContain("app.setPath('sessionData', resolvedPath)")
      expect(applyIndex).toBeGreaterThan(-1)
      expect(lockIndex).toBeGreaterThan(applyIndex)
    }
  })

  test.each([
    'electron/main.ts',
    'electron-client/main.ts',
    'electron-editor/main.ts',
  ])('%s blocks out-of-scope navigation and child windows', (relativePath) => {
    const source = read(relativePath)
    expect(source).toContain(".webContents.on('will-navigate'")
    expect(source).toContain(".webContents.on('will-frame-navigate'")
    expect(source).toContain('!details.isMainFrame')
    expect(source).toContain(".webContents.setWindowOpenHandler(() => ({ action: 'deny' }))")
  })

  test('client routes game, admin, and connect windows through the shared popup denial', () => {
    const source = read('electron-client/main.ts')

    expect(source.match(/restrictWindowNavigation\(win,/g)).toHaveLength(3)
    expect(source).toContain('restrictWindowNavigation(win, isGameClientUrl)')
    expect(source).toContain('restrictWindowNavigation(win, (url) => isFileUrlWithinRoot(url, getAdminRoot()))')
    expect(source).toContain('restrictWindowNavigation(win, (url) => isFileUrlWithinRoot(url, getConnectRoot()))')
    expect(source.match(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/g)).toHaveLength(1)
  })

  test('client homepage omits the unsupported multi-window PVP debugger', () => {
    const page = read('data/pages/index.html')

    expect(page).not.toContain('本机 PVP 调试')
    expect(page).not.toContain('debug-pvp')
    expect(page).not.toContain('startLocalPvpDebug')
    expect(page).not.toContain('_detectLocalDebugServerUrl')
    expect(page).not.toContain('debugPvpBtn')
    expect(page).not.toContain('debugPvpDesc')
    expect(page).not.toContain('debugPvpArrow')
    expect(page).not.toContain('debugPvpStatus')
    expect(page).not.toContain('rvb-debug-red')
    expect(page).not.toContain('rvb-debug-blue')
    expect(page).not.toContain('/api/debug/battle')
    expect(page).not.toContain('window.open(')
    expect(page).not.toContain('target="_blank">先手窗口</a>')
    expect(page).not.toContain('target="_blank">后手窗口</a>')
  })

  test('keeps the RED-19 adm-zip dependency contract unchanged', () => {
    const packageJson = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>
    }

    expect(packageJson.dependencies['adm-zip']).toBe('^0.5.16')
    expect(lock.packages['node_modules/adm-zip']?.version).toBe('0.5.16')
  })

  test.each([
    'electron/main.ts',
    'electron-client/main.ts',
    'electron-editor/main.ts',
  ])('%s registers IPC only through the trusted sender wrapper', (relativePath) => {
    const source = read(relativePath)
    expect(source.match(/ipcMain\.handle\(/g)).toHaveLength(1)
    expect(source).toContain('assertTrustedIpcSender(event, channel,')
  })

  test('client resource packs are isolated from the bundled executable root', () => {
    const main = read('electron-client/main.ts')
    const preload = read('electron-client/preload.ts')
    const packPage = read('data/pages/pack.html')

    expect(main).toContain("return path.join(getUserData(), 'resource-pack')")
    expect(main).toContain('session.defaultSession.protocol.handle(CLIENT_SCHEME')
    expect(main).toContain('isActivatableResourcePackPath(relativePath)')
    expect(main).not.toContain('extractAllTo(')
    expect(main).not.toContain('extractEntryTo(')
    expect(main).not.toContain("'pack-write-files'")
    expect(preload).toContain("ipcRenderer.invoke('pack-import-data'")
    expect(preload).not.toContain("ipcRenderer.invoke('pack-write-files'")
    expect(packPage).toContain('window.electronAPI.packImportData(base64')
    expect(packPage).toContain('const PROFILE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024')
    expect(packPage).toContain('if (blob.size > PROFILE_ARCHIVE_MAX_BYTES)')
    expect(packPage).toContain('if (loaded > PROFILE_ARCHIVE_MAX_BYTES)')
    expect(packPage).toContain("await reader.cancel('PROFILE_ARCHIVE_TOO_LARGE')")
    const statusFunction = packPage.slice(packPage.indexOf('async function refreshPackStatus()'))
    expect(statusFunction.indexOf('if (isElectron)')).toBeLessThan(statusFunction.indexOf("localStorage.getItem('rvb_pack_meta')"))
    expect(statusFunction).toContain('const stable = res.state && res.state.stable')
  })

  test('server resource import no longer performs direct ZIP extraction', () => {
    const main = read('electron/main.ts')
    const store = read('electron/resource-pack-store.ts')
    const resourcePack = read('lib/resource-pack.ts')

    expect(main).not.toContain('extractAllTo(')
    expect(main).toContain("'/api/content-profile/install'")
    expect(main).toContain("'/api/content-profile/activation/commit'")
    expect(store).toContain("path.join(packRoot, 'profiles', reference.resolvedProfileHash)")
    expect(store).toContain("path.join(packRoot, 'active.json')")
    expect(store).not.toContain('AdmZip')
    expect(resourcePack).toContain('installProfileArchiveV1')
    expect(resourcePack).not.toContain("path.join(PACK_ROOT, 'versions'")
  })

  test('recovers an uncertain Profile commit from the current atomic stable pointer', () => {
    for (const relativePath of ['electron-client/main.ts', 'electron/main.ts']) {
      const source = read(relativePath)
      expect(source).toContain('observeCommittedProfileAfterRecovery')
      expect(source).toContain("stage === 'activation-commit'")
      expect(source).toContain('commitRecovered: true')
      expect(source).toContain('stableProfileBinding()')
      expect(source).not.toContain('reference: plan.stable as')
    }
    const client = read('electron-client/main.ts')
    const clientStore = read('electron-client/resource-pack-store.ts')
    const serverStore = read('electron/resource-pack-store.ts')
    expect(client).toContain("stage = 'renderer-commit-recovery-reload'")
    expect(client).toContain("'/api/content-profile/recovery?keepAdmissionPaused=1'")
    expect(client).toContain("'/api/content-profile/activation/release'")
    expect(client).toContain("'renderer-already-active-reload'")
    expect(client).toContain('return await reconcileMainRendererAfterCommit(')
    expect(client).not.toContain('mainWin.webContents.reloadIgnoringCache()\n            return { ok: true, commitRecovered: true')
    for (const store of [clientStore, serverStore]) {
      expect(store).toContain('activationId === null')
      expect(store).toContain('await restartStable()')
    }
  })

  test('lets the central Store recover an invalid stable binding before Electron starts the server', () => {
    for (const relativePath of ['electron-client/main.ts', 'electron/main.ts']) {
      const source = read(relativePath)
      const binding = source.slice(
        source.indexOf('function stableProfileBinding()'),
        source.indexOf('function stableProfileBinding()') + 900,
      )
      expect(binding).toContain('catch (error)')
      expect(binding).toContain('server will recover through Bundled Base')
      expect(binding).toContain('return { profileRoot: getAppRoot() }')
      expect(source).toContain('RVB_PROFILE_ROOT: binding.profileRoot')
      expect(source).toContain("RVB_PROFILE_ADMISSION_PAUSED: binding?.activationId ?? 'startup-recovery'")
      expect(source).toContain('RVB_RESOLVED_PROFILE_HASH: binding.reference?.resolvedProfileHash')
      expect(source).toContain('RVB_AUTHORITY_CONTENT_HASH: binding.reference?.authorityContentHash')
      expect(source).toContain('RVB_PROFILE_ENGINE_ABI: binding.reference?.compatibility.engineAbi')
      expect(source).toContain('RVB_PROFILE_CONTENT_ABI: binding.reference?.compatibility.contentAbi')
      expect(source).toContain('RVB_PROFILE_ACTIVATION_ID: binding.activationId')
      expect(source).toContain('if (recovered.requiresProcessRestart === true)')
      expect(source).toContain("throw new Error('PROFILE_STARTUP_RECOVERY_HEALTH_MISMATCH')")
    }
    const runtime = read('lib/content-pipeline/runtime/profile-runtime.ts')
    expect(runtime).not.toContain("import { getRoomStore } from '@/lib/game/room-store'")
    expect(runtime).not.toContain("import { createDebugDuel } from '@/lib/game/debug-battle'")
    expect(runtime).toContain("await import('@/lib/game/room-store')")
    expect(runtime).toContain("await import('@/lib/game/debug-battle')")
    expect(runtime).toContain('admissionPaused: requiresProcessRestart || options.keepAdmissionPaused')
  })

  test('fails Profile activation closed when durable journal drain is not acknowledged', () => {
    const client = read('electron-client/main.ts')
    const standalone = read('electron/main.ts')
    for (const source of [client, standalone]) {
      expect(source).toContain("throw new Error('PROFILE_DURABLE_DRAIN_FAILED')")
      expect(source).toContain("error.message === 'PROFILE_DURABLE_DRAIN_FAILED'")
      expect(source).toMatch(/if \(!(?:durableDrainFailed|keepAdmissionPaused)\)/)
      expect(source).toContain('keepAdmissionPaused')
      expect(source).toContain('requiresApplicationRestart: true')
      expect(source).toContain('activation failure evidence write failed')
    }
    const failureRoute = read('app/api/content-profile/activation/failure/route.ts')
    expect(failureRoute).toContain('body.keepAdmissionPaused === true')
    expect(failureRoute).toContain('process.env.RVB_PROFILE_ADMISSION_PAUSED = body.activationId')
    expect(client).toContain('await killServer(true)')
    expect(standalone).toContain('}, true)')
  })

  test('runs an isolated real renderer smoke before committing stable', () => {
    const source = read('electron-client/main.ts')
    const requiredProfileResources = [
      'data/pieces/manifest.json',
      'data/skills/manifest.json',
      'data/cards/manifest.json',
      'data/cards/lucky-coin.json',
      'data/skills/basic-attack.json',
    ]
    for (const relativePath of requiredProfileResources) {
      expect(source).toContain(`'${relativePath}'`)
      expect(fs.existsSync(path.join(root, relativePath))).toBe(true)
    }
    expect(source).not.toContain("'data/effects/effect-lucky-coin.json'")
    const activation = source.slice(
      source.indexOf("stage = 'candidate-renderer-preflight'"),
      source.indexOf("stage = 'activation-commit'") + 100,
    )
    expect(source).toContain('session.fromPartition(`rvb-profile-smoke-${activationId}`')
    expect(source).toContain("smokeWindow.webContents.on('did-fail-load'")
    expect(source).toContain("smokeWindow.webContents.once('render-process-gone'")
    expect(source).toContain("smokeWindow.once('unresponsive'")
    expect(source).toContain("current.pathname !== '/index.html'")
    expect(source).toContain("fetch('${CLIENT_SCHEME}://app/' + relativePath")
    expect(source).toContain('parsedProfileResources: parsed.length')
    expect(source).toContain("serverLiteral} + '/api/ping'")
    expect(activation.indexOf('await verifyRendererCandidate('))
      .toBeLessThan(activation.indexOf("stage = 'activation-commit'"))
    expect(source).toContain('reloadAndVerify: reloadMainRendererAndWait')
    expect(source).toContain('keepAdmissionPaused: true')
    const commitRoute = read('app/api/content-profile/activation/commit/route.ts')
    const releaseRoute = read('app/api/content-profile/activation/release/route.ts')
    expect(commitRoute).toContain('body.keepAdmissionPaused === true')
    expect(commitRoute).toContain('postcommit:')
    expect(releaseRoute).toContain("state.activation !== null")
    expect(releaseRoute).toContain('report.activationId !== null')
    expect(releaseRoute).toContain('bindStableRuntimeProfileV1()')
    expect(source).toContain("typeof bridge.packList !== 'function'")
    expect(source).toContain('ready?.stableProfileHash !== expectedProfileHash')
    expect(source).toContain('ready?.serverProfileHash !== expectedProfileHash')
    expect(source).toContain('ready?.serverHealthy !== true')
    expect(source).toContain("selectAndActivateRollback('previous-stable', false)")
    expect(source).toContain('const keepAdmissionPaused = durableDrainFailed || !allowRendererRollback')
    expect(source).toContain('if (!keepAdmissionPaused) {')
    expect(source).toContain("typed.message === 'PROFILE_DURABLE_DRAIN_FAILED' || !allowRendererRollback")
    const rendererCoordinator = read('electron-client/resource-pack-store.ts')
    expect(rendererCoordinator).toContain('await reloadAndVerify(expectedProfileHash)')
    expect(rendererCoordinator.indexOf('await reloadAndVerify(expectedProfileHash)'))
      .toBeLessThan(rendererCoordinator.indexOf('await releaseAdmission(expectedProfileHash)'))
    expect(rendererCoordinator).toContain('await recordFailureEvidence({')
    expect(rendererCoordinator).toContain('await recordRollbackEvidence({')
    expect(rendererCoordinator).toContain('rolledBack: rollbackSucceeded')
  })

  test('closes HTTP and WebSocket game admission throughout Profile activation', () => {
    const nodeProxy = read('proxy.ts')
    const webSocketPreload = read('scripts/ws-same-port-server.cjs')

    for (const source of [nodeProxy, webSocketPreload]) {
      expect(source).toContain('RVB_PROFILE_ACTIVATION_ID')
      expect(source).toContain('RVB_PROFILE_ADMISSION_PAUSED')
    }
    expect(nodeProxy).toContain("pathname.startsWith('/api/content-profile/')")
    expect(nodeProxy).toContain("pathname === '/api/ping'")
    expect(nodeProxy).toContain('PROFILE_ACTIVATION_IN_PROGRESS')
    expect(webSocketPreload).toContain("'/ws/rooms/__profile-health__'")
    expect(webSocketPreload).toContain('acceptProfileHealthUpgrade(request, socket)')
    expect(webSocketPreload).toContain('never reaches the game')
    expect(webSocketPreload).toContain("rejectUpgrade(socket, '503 Profile Activation In Progress')")
    expect(webSocketPreload).toContain("server.prependListener('request'")
    expect(webSocketPreload).toContain('waitForDrain:')
    const runtime = read('lib/content-pipeline/runtime/profile-runtime.ts')
    expect(runtime).toContain('globalThis.__rvbProfileHttpIngressV1?.waitForDrain() ?? true')
    expect(runtime).toContain('getProfileWsIngressTrackerV1().waitForDrain()')
    expect(runtime).toContain('activation planning fence lost')
    const webSocketServer = read('lib/ws-server.ts')
    expect(webSocketServer).toContain('getProfileWsIngressTrackerV1().tryEnter()')
    expect(webSocketServer).toContain('.finally(finishIngress)')
  })

  test('standalone dashboard keeps install, activation, and rollback explicit', () => {
    const dashboard = read('electron/dashboard/index.html')
    const upload = dashboard.slice(
      dashboard.indexOf('async function uploadPack()'),
      dashboard.indexOf("api.onServerStatus"),
    )

    expect(dashboard).toContain('api.activateResourcePack(candidate.resolvedProfileHash)')
    expect(dashboard).toContain("api.rollbackResourcePack(target)")
    expect(dashboard).toContain("rollbackProfile('previous-stable')")
    expect(dashboard).toContain("rollbackProfile('bundled-base')")
    expect(dashboard).toContain('data.state')
    expect(dashboard).toContain('state.previousStable')
    expect(dashboard).toContain('state.lastFailure')
    expect(dashboard).toContain('if (file.size > 32 * 1024 * 1024)')
    expect(upload).toContain('等待显式激活')
    expect(upload).not.toContain('restart()')
    const rollbackRoute = read('app/api/content-profile/rollback/route.ts')
    expect(rollbackRoute).toContain('alreadyStable: state.candidate === null')
    for (const source of [read('electron-client/main.ts'), read('electron/main.ts')]) {
      expect(source).toContain('before.server?.healthy !== true')
      expect(source).toContain('before.server?.activationId !== null')
      expect(source).toContain('selected.targetProfileHash')
    }
  })

  test('client does not bypass Chromium origin or certificate validation', () => {
    const source = read('electron-client/main.ts')
    expect(source).not.toContain('webSecurity: false')
    expect(source).not.toContain('ignore-certificate-errors')
    expect(source).not.toContain("app.on('certificate-error'")
  })

  test('all three desktop entry points have Windows package configurations', () => {
    const configs = [
      ['electron-builder.server.json', 'electron/dist/main.js'],
      ['electron-builder.client.json', 'electron-client/dist/main.js'],
      ['electron-builder.editor.json', 'electron-editor/dist/main.js'],
    ] as const

    for (const [relativePath, main] of configs) {
      const config = JSON.parse(read(relativePath)) as {
        extraMetadata?: { main?: string }
        win?: { target?: string | string[] }
      }
      expect(config.extraMetadata?.main).toBe(main)
      expect(config.win?.target).toBeTruthy()
    }
  })

  test('editor packages exclude unrelated app dependencies but keep the resource-pack runtime', () => {
    const config = JSON.parse(read('electron-builder.editor.json')) as {
      files?: string[]
      extraResources?: { from?: string; to?: string }[]
    }
    const requiredModules = [
      'jszip',
      'lie',
      'immediate',
      'pako',
      'core-util-is',
      'inherits',
      'isarray',
      'process-nextick-args',
      'setimmediate',
      'util-deprecate',
    ]

    expect(config.files).toContain('!**/node_modules/**')
    for (const moduleName of requiredModules) {
      expect(config.extraResources).toContainEqual({
        from: `node_modules/${moduleName}`,
        to: `app/node_modules/${moduleName}`,
      })
    }
  })

  test('client packages canonical pages directly and exposes only allowlisted offline data', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    const config = JSON.parse(read('electron-builder.client.json')) as {
      extraResources?: { from?: string; to?: string; filter?: string[] }[]
    }
    expect(packageJson.scripts?.['build:electron:client']).not.toContain('npm run sync:pages')
    expect(config.extraResources).toContainEqual({
      from: 'data/pages',
      to: 'app/www',
    })
    expect(config.extraResources).toContainEqual({
      from: 'public',
      to: 'app/www/images',
      filter: ['*.jpg', 'card-art/**'],
    })
    expect(config.extraResources).toContainEqual({
      from: 'data',
      to: 'app/www/data',
      filter: [
        'cards/**',
        'effects/**',
        'maps/**',
        'pieces/**',
        'pve/**',
        'rules/**',
        'skills/**',
        'status-effects/**',
        'tiles/**',
        'skill-keywords.json',
      ],
    })
    expect(config.extraResources).not.toContainEqual({
      from: 'data',
      to: 'app/www/data',
    })
  })

  test('client explicitly packages the standalone runtime dependencies', () => {
    const config = JSON.parse(read('electron-builder.client.json')) as {
      extraResources?: { from?: string; to?: string }[]
    }

    expect(config.extraResources).toContainEqual({
      from: '_client-stage/node_modules',
      to: 'app/standalone/node_modules',
    })
  })
})
