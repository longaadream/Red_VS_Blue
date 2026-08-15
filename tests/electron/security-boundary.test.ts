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
    ['electron-client/main.ts', 3],
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
  })

  test('server resource import no longer performs direct ZIP extraction', () => {
    const main = read('electron/main.ts')
    const store = read('electron/resource-pack-store.ts')
    const resourcePack = read('lib/resource-pack.ts')

    expect(main).not.toContain('extractAllTo(')
    expect(store).toContain("path.join(packRoot, 'versions', version)")
    expect(store).toContain("path.join(packRoot, 'active.json')")
    expect(resourcePack).toContain("path.join(PACK_ROOT, 'versions', pointer.version)")
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

  test('client generates tracked pages and exposes only allowlisted offline data', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
    const config = JSON.parse(read('electron-builder.client.json')) as {
      extraResources?: { from?: string; to?: string; filter?: string[] }[]
    }
    expect(packageJson.scripts?.['build:electron:client']).toContain('npm run sync:pages')
    expect(config.extraResources).toContainEqual({
      from: 'android-client/www',
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
})
