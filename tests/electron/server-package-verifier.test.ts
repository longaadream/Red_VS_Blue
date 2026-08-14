import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  findServerPackageIssues,
  verifyServerPackage,
} from '../../scripts/verify-electron-server-package.js'

const temporaryRoots: string[] = []

function writeFile(root: string, relative: string, content: string | Buffer = 'fixture') {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-server-package-'))
  temporaryRoots.push(root)

  const projectRoot = path.join(root, 'project')
  const packageRoot = path.join(root, 'package')
  const manifestPath = path.join(root, 'evidence', 'server-candidate-manifest.json')

  writeFile(projectRoot, 'electron/dist/main.js', 'compiled main')
  writeFile(projectRoot, 'electron/dist/preload.js', 'compiled preload')
  writeFile(projectRoot, 'electron/dashboard/index.html', '<main>Server dashboard</main>')
  writeFile(projectRoot, '_client-stage/server.js', 'standalone server')
  writeFile(projectRoot, '_client-stage/.next/static/chunks/app.js', 'static chunk')
  writeFile(projectRoot, '_client-stage/node_modules/next/package.json', '{"name":"next"}')
  writeFile(projectRoot, '_client-stage/node_modules/.prisma/client/index.js', 'generated Prisma client')
  writeFile(projectRoot, 'public/banner.txt', 'public asset')
  writeFile(projectRoot, 'data/cards/red.json', '{"id":"red"}')
  writeFile(projectRoot, 'prisma/schema.prisma', 'datasource db { provider = "sqlite" }')
  writeFile(projectRoot, 'scripts/init-db.js', 'initialize database')
  writeFile(projectRoot, 'node_modules/adm-zip/adm-zip.js', 'adm zip runtime')
  writeFile(projectRoot, 'node_modules/adm-zip/package.json', '{"name":"adm-zip"}')
  writeFile(projectRoot, '_client-node/node.exe', 'node runtime')
  writeFile(
    projectRoot,
    'package.json',
    JSON.stringify({
      scripts: {
        'build:electron': 'npm run build:electron:client',
        'build:all': 'npm run build:electron:client',
        'build:electron:server':
          'electron-builder --config electron-builder.server.json && node scripts/verify-electron-server-package.js && node scripts/cleanup-client-resources.js',
      },
    }),
  )
  writeFile(
    projectRoot,
    'electron-builder.server.json',
    JSON.stringify({
      appId: 'com.redvsblue.server',
      extraResources: [
        {
          from: '_client-stage/node_modules',
          to: 'app/standalone/node_modules',
        },
      ],
      win: { target: 'dir' },
    }),
  )

  writeFile(packageRoot, 'RED vs BLUE Server.exe', 'server executable')
  writeFile(packageRoot, 'resources/app/package.json', fs.readFileSync(path.join(projectRoot, 'package.json')))
  fs.cpSync(
    path.join(projectRoot, 'electron', 'dist'),
    path.join(packageRoot, 'resources', 'app', 'electron', 'dist'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(projectRoot, 'electron', 'dashboard'),
    path.join(packageRoot, 'resources', 'app', 'electron', 'dashboard'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(projectRoot, '_client-stage'),
    path.join(packageRoot, 'resources', 'app', 'standalone'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(projectRoot, 'public'),
    path.join(packageRoot, 'resources', 'app', 'public'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(projectRoot, 'data'),
    path.join(packageRoot, 'resources', 'app', 'data'),
    { recursive: true },
  )
  fs.cpSync(
    path.join(projectRoot, 'prisma'),
    path.join(packageRoot, 'resources', 'app', 'prisma'),
    { recursive: true },
  )
  writeFile(packageRoot, 'resources/app/init-db.js', 'initialize database')
  fs.cpSync(
    path.join(projectRoot, 'node_modules', 'adm-zip'),
    path.join(packageRoot, 'resources', 'app', 'node_modules', 'adm-zip'),
    { recursive: true },
  )
  writeFile(packageRoot, 'resources/node.exe', 'node runtime')

  return { manifestPath, packageRoot, projectRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron Server candidate package verification', () => {
  it('rejects missing critical resources using their packaged paths', () => {
    const { packageRoot, projectRoot } = createFixture()
    fs.rmSync(path.join(packageRoot, 'resources', 'app', 'electron', 'dashboard'), {
      recursive: true,
      force: true,
    })
    fs.rmSync(path.join(packageRoot, 'resources', 'app', 'standalone', 'server.js'))
    fs.rmSync(path.join(packageRoot, 'resources', 'app', 'public'), {
      recursive: true,
      force: true,
    })
    fs.rmSync(path.join(packageRoot, 'resources', 'app', 'node_modules', 'adm-zip'), {
      recursive: true,
      force: true,
    })
    fs.rmSync(path.join(packageRoot, 'resources', 'node.exe'))

    const issues = findServerPackageIssues({ packageRoot, projectRoot })

    expect(issues.some((issue) => issue.includes('resources/app/electron/dashboard'))).toBe(true)
    expect(issues.some((issue) => issue.includes('resources/app/standalone/server.js'))).toBe(true)
    expect(issues.some((issue) => issue.includes('resources/app/public'))).toBe(true)
    expect(issues.some((issue) => issue.includes('resources/app/node_modules/adm-zip'))).toBe(true)
    expect(issues.some((issue) => issue.includes('resources/node.exe'))).toBe(true)
  })

  it('rejects stale packaged resources and dependencies outside adm-zip', () => {
    const { packageRoot, projectRoot } = createFixture()
    writeFile(packageRoot, 'resources/app/init-db.js', 'stale initializer')
    writeFile(packageRoot, 'resources/app/node_modules/unexpected/index.js', 'unexpected dependency')

    const issues = findServerPackageIssues({ packageRoot, projectRoot })

    expect(issues).toContain('stale init-db resource: resources/app/init-db.js')
    expect(issues).toContain(
      'unexpected top-level runtime dependency: resources/app/node_modules/unexpected',
    )
  })

  it('rejects default Server builds and public distribution configuration', () => {
    const { packageRoot, projectRoot } = createFixture()
    const packageJsonPath = path.join(projectRoot, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    packageJson.scripts['build:all'] = 'npm run build:electron:server'
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson))
    fs.writeFileSync(
      path.join(projectRoot, 'electron-builder.server.json'),
      JSON.stringify({ win: { target: 'nsis' }, publish: { provider: 'github' } }),
    )

    const issues = findServerPackageIssues({ packageRoot, projectRoot })

    expect(issues).toContain(
      'package.json build:all must remain client-only: npm run build:electron:server',
    )
    expect(issues).toContain('electron-builder.server.json win.target must be dir')
    expect(issues).toContain('electron-builder.server.json must not configure publish')
  })

  it('writes a reviewable manifest with file counts, sizes, and SHA-256 evidence', () => {
    const { manifestPath, packageRoot, projectRoot } = createFixture()

    const evidence = verifyServerPackage({ manifestPath, packageRoot, projectRoot })
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    expect(evidence.serverExecutable.absolutePath).toBe(
      path.join(packageRoot, 'RED vs BLUE Server.exe'),
    )
    expect(evidence.serverExecutable.bytes).toBeGreaterThan(0)
    expect(evidence.serverExecutable.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.nodeRuntime.bytes).toBeGreaterThan(0)
    expect(evidence.nodeRuntime.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.manifest.absolutePath).toBe(manifestPath)
    expect(evidence.manifest.bytes).toBeGreaterThan(0)
    expect(evidence.manifest.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.resources.fileCount).toBeGreaterThan(0)
    expect(manifest.resources.totalBytes).toBeGreaterThan(0)
    expect(manifest.resources.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'resources/app/electron/dist/main.js' }),
        expect.objectContaining({ path: 'resources/app/electron/dashboard/index.html' }),
        expect.objectContaining({ path: 'resources/app/standalone/server.js' }),
        expect.objectContaining({ path: 'resources/app/standalone/.next/static/chunks/app.js' }),
        expect.objectContaining({ path: 'resources/app/public/banner.txt' }),
        expect.objectContaining({ path: 'resources/app/data/cards/red.json' }),
        expect.objectContaining({ path: 'resources/app/prisma/schema.prisma' }),
        expect.objectContaining({ path: 'resources/app/init-db.js' }),
        expect.objectContaining({ path: 'resources/app/node_modules/adm-zip/adm-zip.js' }),
        expect.objectContaining({ path: 'resources/node.exe' }),
      ]),
    )
  })

  it('replays manifest verification after staging cleanup and rejects later tampering', () => {
    const { manifestPath, packageRoot, projectRoot } = createFixture()
    const initial = verifyServerPackage({ manifestPath, packageRoot, projectRoot })
    fs.rmSync(path.join(projectRoot, '_client-stage'), { recursive: true, force: true })
    fs.rmSync(path.join(projectRoot, '_client-node'), { recursive: true, force: true })

    const replay = verifyServerPackage({ manifestPath, packageRoot, projectRoot })

    expect(replay.verificationMode).toBe('manifest-replay')
    expect(replay.serverExecutable.sha256).toBe(initial.serverExecutable.sha256)
    expect(replay.nodeRuntime.sha256).toBe(initial.nodeRuntime.sha256)

    writeFile(packageRoot, 'resources/app/init-db.js', 'tampered after build')

    expect(() => verifyServerPackage({ manifestPath, packageRoot, projectRoot })).toThrow(
      /manifest mismatch.*resources\/app\/init-db\.js/,
    )
  })
})
