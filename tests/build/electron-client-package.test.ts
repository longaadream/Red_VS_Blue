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

  return { packageRoot, pageSourceRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron client package verification', () => {
  it('reports a missing packaged game entry page', () => {
    const { packageRoot, pageSourceRoot } = createFixture()

    expect(findClientPackageIssues(packageRoot, pageSourceRoot)).toContain(
      'missing required file: resources/app/www/index.html',
    )
  })

  it('accepts source pages copied byte-for-byte into the package', () => {
    const { packageRoot, pageSourceRoot } = createFixture()
    fs.cpSync(pageSourceRoot, path.join(packageRoot, 'resources', 'app', 'www'), { recursive: true })

    expect(findClientPackageIssues(packageRoot, pageSourceRoot)).toEqual([])
  })
})
