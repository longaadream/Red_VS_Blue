import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { findClientPackageIssues } from '../../scripts/verify-electron-client-package.js'

const temporaryRoots: string[] = []

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-client-package-'))
  temporaryRoots.push(root)

  const packageRoot = path.join(root, 'package')
  const pageSourceRoot = path.join(root, 'pages')
  const dataSourceRoot = path.join(root, 'data')
  const requiredFiles = [
    'resources/app/electron-client/dist/main.js',
    'resources/app/standalone/server.js',
    'resources/app/init-db.js',
    'resources/node.exe',
  ]
  const requiredDirectories = [
    'resources/app/public',
    'resources/app/data',
    'resources/app/prisma',
  ]

  for (const relative of requiredFiles) {
    const target = path.join(packageRoot, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'fixture')
  }
  for (const relative of requiredDirectories) {
    fs.mkdirSync(path.join(packageRoot, relative), { recursive: true })
  }

  fs.mkdirSync(path.join(pageSourceRoot, 'js'), { recursive: true })
  fs.writeFileSync(path.join(pageSourceRoot, 'index.html'), '<main>RED vs BLUE</main>')
  fs.writeFileSync(path.join(pageSourceRoot, 'js', 'server-utils.js'), 'window.RvBUtils = {}')
  fs.mkdirSync(path.join(dataSourceRoot, 'pieces'), { recursive: true })
  fs.writeFileSync(path.join(dataSourceRoot, 'pieces', 'manifest.json'), '["red-1"]')
  fs.writeFileSync(path.join(dataSourceRoot, 'pieces', 'red-1.json'), '{"id":"red-1"}')

  return { dataSourceRoot, packageRoot, pageSourceRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron client package verification', () => {
  it('reports a missing packaged game entry page', () => {
    const { dataSourceRoot, packageRoot, pageSourceRoot } = createFixture()

    expect(findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot)).toContain(
      'missing required file: resources/app/www/index.html',
    )
  })

  it('reports missing offline piece data even when the game pages are present', () => {
    const { dataSourceRoot, packageRoot, pageSourceRoot } = createFixture()
    fs.cpSync(pageSourceRoot, path.join(packageRoot, 'resources', 'app', 'www'), { recursive: true })

    expect(findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot)).toContain(
      'missing offline data asset: resources/app/www/data/pieces/manifest.json',
    )
  })

  it('rejects a local user database exposed in the packaged web assets', () => {
    const { dataSourceRoot, packageRoot, pageSourceRoot } = createFixture()
    fs.cpSync(pageSourceRoot, path.join(packageRoot, 'resources', 'app', 'www'), { recursive: true })
    fs.cpSync(dataSourceRoot, path.join(packageRoot, 'resources', 'app', 'www', 'data'), {
      recursive: true,
    })
    fs.writeFileSync(path.join(packageRoot, 'resources', 'app', 'www', 'data', 'users.json'), '{}')

    expect(findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot)).toContain(
      'forbidden packaged file: resources/app/www/data/users.json',
    )
  })

  it('accepts source pages and offline data copied byte-for-byte into the package', () => {
    const { dataSourceRoot, packageRoot, pageSourceRoot } = createFixture()
    fs.cpSync(pageSourceRoot, path.join(packageRoot, 'resources', 'app', 'www'), { recursive: true })
    fs.cpSync(dataSourceRoot, path.join(packageRoot, 'resources', 'app', 'www', 'data'), {
      recursive: true,
    })

    expect(findClientPackageIssues(packageRoot, pageSourceRoot, dataSourceRoot)).toEqual([])
  })
})
