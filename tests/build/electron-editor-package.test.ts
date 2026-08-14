import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'

import {
  EDITOR_RUNTIME_PACKAGES,
  findEditorPackageIssues,
} from '../../scripts/verify-electron-editor-package.js'

interface EditorBuilderConfig {
  asar?: boolean
  beforeBuild?: string
  extraResources?: Array<{ from: string; to: string }>
  files?: string[]
}

function readEditorBuilderConfig(): EditorBuilderConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'electron-builder.editor.json'), 'utf8'),
  ) as EditorBuilderConfig
}

const temporaryRoots: string[] = []
const requireFromTest = createRequire(import.meta.url)

async function createPackageFixture(options: { archivedNodeModules?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-editor-package-'))
  temporaryRoots.push(root)

  const projectRoot = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const archiveSourceRoot = path.join(root, 'archive')
  const portablePath = path.join(root, 'RED vs BLUE Editor 0.1.0.exe')

  fs.mkdirSync(path.join(archiveSourceRoot, 'electron-editor', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(archiveSourceRoot, 'electron-editor', 'ui'), { recursive: true })
  fs.writeFileSync(path.join(archiveSourceRoot, 'electron-editor', 'dist', 'main.js'), 'main')
  fs.writeFileSync(path.join(archiveSourceRoot, 'electron-editor', 'dist', 'preload.js'), 'preload')
  fs.writeFileSync(path.join(archiveSourceRoot, 'electron-editor', 'ui', 'index.html'), 'editor')
  fs.writeFileSync(
    path.join(archiveSourceRoot, 'package.json'),
    JSON.stringify({ main: 'electron-editor/dist/main.js' }),
  )
  if (options.archivedNodeModules) {
    fs.mkdirSync(path.join(archiveSourceRoot, 'node_modules', 'unused'), { recursive: true })
    fs.writeFileSync(path.join(archiveSourceRoot, 'node_modules', 'unused', 'index.js'), 'unused')
  }

  fs.mkdirSync(path.join(projectRoot, 'data', 'pieces'), { recursive: true })
  fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'data', 'pieces', 'manifest.json'), '[]')
  fs.writeFileSync(path.join(projectRoot, 'scripts', 'build-resource-pack.js'), 'fixture')
  for (const packageName of EDITOR_RUNTIME_PACKAGES) {
    const source = path.join(projectRoot, 'node_modules', packageName)
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }),
    )
    fs.writeFileSync(path.join(source, 'index.js'), `module.exports = '${packageName}'`)
  }

  const resourcesRoot = path.join(packageRoot, 'resources')
  fs.mkdirSync(resourcesRoot, { recursive: true })
  await createPackage(archiveSourceRoot, path.join(resourcesRoot, 'app.asar'))
  fs.cpSync(path.join(projectRoot, 'data'), path.join(resourcesRoot, 'app', 'data'), {
    recursive: true,
  })
  fs.cpSync(path.join(projectRoot, 'scripts'), path.join(resourcesRoot, 'app', 'scripts'), {
    recursive: true,
  })
  for (const packageName of EDITOR_RUNTIME_PACKAGES) {
    fs.cpSync(
      path.join(projectRoot, 'node_modules', packageName),
      path.join(resourcesRoot, 'app', 'node_modules', packageName),
      { recursive: true },
    )
  }
  fs.writeFileSync(portablePath, 'portable')

  return { packageRoot, portablePath, projectRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron editor packaging', () => {
  it('archives application files while keeping mutable resources external', () => {
    const config = readEditorBuilderConfig()
    const extraResources = new Map(
      (config.extraResources ?? []).map(resource => [resource.from, resource.to]),
    )

    expect(config.asar).toBe(true)
    expect(config.beforeBuild).toBe('scripts/editor-before-build.js')
    expect(config.files).toContain('!**/node_modules/**')
    expect(extraResources.get('data')).toBe('app/data')
    expect(extraResources.get('scripts')).toBe('app/scripts')
    for (const packageName of EDITOR_RUNTIME_PACKAGES) {
      expect(extraResources.get(`node_modules/${packageName}`)).toBe(
        `app/node_modules/${packageName}`,
      )
    }
    for (const packageName of ['readable-stream', 'safe-buffer', 'string_decoder']) {
      expect(extraResources.get(`node_modules/jszip/node_modules/${packageName}`)).toBe(
        `app/node_modules/jszip/node_modules/${packageName}`,
      )
    }
  })

  it('tells electron-builder that editor dependencies are handled externally', async () => {
    const beforeBuild = requireFromTest('../../scripts/editor-before-build.js') as () => Promise<boolean>

    await expect(beforeBuild()).resolves.toBe(false)
  })

  it('reports a missing app archive', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture()
    fs.rmSync(path.join(packageRoot, 'resources', 'app.asar'))

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toContain(
      'missing editor archive: resources/app.asar',
    )
  })

  it('reports external editor data that is stale', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture()
    fs.writeFileSync(
      path.join(packageRoot, 'resources', 'app', 'data', 'pieces', 'manifest.json'),
      '["stale"]',
    )

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toContain(
      'stale editor data asset: resources/app/data/pieces/manifest.json',
    )
  })

  it('rejects production dependencies inside the editor archive', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture({
      archivedNodeModules: true,
    })

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toContain(
      'unexpected node_modules inside editor archive',
    )
  })

  it('reports a missing external runtime dependency', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture()
    fs.rmSync(path.join(packageRoot, 'resources', 'app', 'node_modules', 'jszip'), {
      recursive: true,
    })

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toContain(
      'missing external editor directory: resources/app/node_modules/jszip',
    )
  })

  it('reports a missing portable executable', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture()
    fs.rmSync(portablePath)

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toContain(
      'missing editor portable: RED vs BLUE Editor 0.1.0.exe',
    )
  })

  it('accepts an archived app and byte-identical external resources', async () => {
    const { packageRoot, portablePath, projectRoot } = await createPackageFixture()

    expect(findEditorPackageIssues(packageRoot, projectRoot, portablePath)).toEqual([])
  })
})
