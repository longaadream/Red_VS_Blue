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
    expect(source).toContain(".webContents.setWindowOpenHandler(() => ({ action: 'deny' }))")
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

  test('editor portable excludes unrelated app dependencies but keeps its resource-pack builder runtime', () => {
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

    expect(config.files).toContain('!node_modules/**')
    for (const moduleName of requiredModules) {
      expect(config.extraResources).toContainEqual({
        from: `node_modules/${moduleName}`,
        to: `app/node_modules/${moduleName}`,
      })
    }
  })

  test('client packages its source HTML pages instead of relying on ignored generated files', () => {
    const config = JSON.parse(read('electron-builder.client.json')) as {
      extraResources?: { from?: string; to?: string; filter?: string[] }[]
    }
    expect(config.extraResources).toContainEqual({
      from: 'data/pages',
      to: 'app/www',
      filter: ['**/*.html'],
    })
    expect(config.extraResources).toContainEqual({
      from: 'android-client/www/js',
      to: 'app/www/js',
    })
    expect(config.extraResources).toContainEqual({
      from: 'public',
      to: 'app/www/images',
    })
    expect(config.extraResources).toContainEqual({
      from: 'data',
      to: 'app/www/data',
    })
  })
})
