import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

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
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'BrowserWindow') {
      const options = node.arguments?.[0]
      if (!options || !ts.isObjectLiteralExpression(options)) {
        throw new Error(`${relativePath} creates BrowserWindow without options`)
      }
      const preference = options.properties.find(property => (
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && property.name.text === 'webPreferences'
      ))
      if (!preference || !ts.isPropertyAssignment(preference) || !ts.isObjectLiteralExpression(preference.initializer)) {
        throw new Error(`${relativePath} creates BrowserWindow without inline webPreferences`)
      }
      results.push(new Map(preference.initializer.properties.flatMap(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return []
        return [[property.name.text, property.initializer] as const]
      })))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return results
}

describe('Electron desktop security boundary after Colyseus cutover', () => {
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
    ['electron-client/main.ts', 4],
    ['electron-editor/main.ts', 1],
  ])('%s applies secure renderer preferences to every window', (relativePath, expectedWindows) => {
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

  test.each(['electron-client/main.ts', 'electron-editor/main.ts'])(
    '%s blocks out-of-scope navigation, child frames, and popup windows',
    relativePath => {
      const source = read(relativePath)
      expect(source).toContain(".webContents.on('will-navigate'")
      expect(source).toContain(".webContents.on('will-frame-navigate'")
      expect(source).toContain('!details.isMainFrame')
      expect(source).toContain(".webContents.setWindowOpenHandler(() => ({ action: 'deny' }))")
      expect(source).toContain('assertTrustedIpcSender(event, channel,')
    },
  )

  test('isolates resource packs from the bundled executable root', () => {
    const main = read('electron-client/main.ts')
    const preload = read('electron-client/preload.ts')
    expect(main).toContain("return path.join(getUserData(), 'resource-pack')")
    expect(main).toContain('isActivatableResourcePackPath(relativePath)')
    expect(main).not.toContain('extractAllTo(')
    expect(main).not.toContain('extractEntryTo(')
    expect(preload).toContain("ipcRenderer.invoke('pack-import-data'")
    expect(preload).not.toContain("ipcRenderer.invoke('pack-write-files'")
  })

  test('uses one Windows player shell and no legacy Electron Server product', () => {
    const packageJson = JSON.parse(read('package.json')) as { main?: string; scripts?: Record<string, string> }
    const clientBuilder = JSON.parse(read('electron-builder.client.json')) as {
      extraMetadata?: { main?: string }
      extraResources?: Array<{ from?: string; to?: string }>
    }
    expect(packageJson.main).toBe('electron-client/dist/main.js')
    expect(packageJson.scripts).not.toHaveProperty('build:electron:server')
    expect(packageJson.scripts).not.toHaveProperty('dev:electron:server')
    expect(fs.existsSync(path.join(root, 'electron-builder.server.json'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'electron', 'main.ts'))).toBe(false)
    expect(clientBuilder.extraMetadata?.main).toBe('electron-client/dist/main.js')
    expect(clientBuilder.extraResources).toContainEqual({ from: '_client-colyseus', to: 'app/standalone/colyseus' })
    expect(clientBuilder.extraResources).toContainEqual({ from: '_client-postgres', to: 'postgres' })
  })

  test('contains no Windows raw websocket, Prisma, SQLite, or legacy RoomStore runtime', () => {
    const forbiddenFiles = [
      'instrumentation.ts',
      'lib/ws-server.ts',
      'lib/game/room-store.ts',
      'lib/db.ts',
      'scripts/ws-same-port-server.cjs',
      'scripts/init-db.js',
      'prisma/schema.prisma',
    ]
    for (const relativePath of forbiddenFiles) {
      expect(fs.existsSync(path.join(root, relativePath)), relativePath).toBe(false)
    }
    const packageJson = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(packageJson.dependencies).not.toHaveProperty('@prisma/client')
    expect(packageJson.dependencies).not.toHaveProperty('ws')
    expect(packageJson.devDependencies).not.toHaveProperty('prisma')
    expect(packageJson.devDependencies).not.toHaveProperty('@types/ws')
    const client = read('electron-client/main.ts')
    expect(client).not.toContain('DATABASE_URL: `file:')
    expect(client).not.toContain('DISABLE_WS')
    expect(client).not.toContain('RVB_BATTLE_ASYNC_JOURNAL')
  })

  test('does not bypass Chromium origin or certificate validation', () => {
    const source = read('electron-client/main.ts')
    expect(source).not.toContain('webSecurity: false')
    expect(source).not.toContain('ignore-certificate-errors')
    expect(source).not.toContain("app.on('certificate-error'")
  })
})
