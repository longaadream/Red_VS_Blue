import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { findClientPackageIssues } from '../../scripts/verify-electron-client-package.js'

const temporaryRoots: string[] = []

function writeFile(root: string, relative: string, content = 'fixture') {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-client-package-'))
  temporaryRoots.push(root)

  const packageRoot = path.join(root, 'package')
  const pageSourceRoot = path.join(root, 'pages')
  const dataSourceRoot = path.join(root, 'data')
  const publicSourceRoot = path.join(root, 'public')

  for (const directory of [pageSourceRoot, dataSourceRoot, publicSourceRoot]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  for (const relative of [
    'resources/app/electron-client/dist/main.js',
    'resources/app/standalone/server.js',
    'resources/app/www/index.html',
    'resources/app/init-db.js',
    'resources/node.exe',
  ]) {
    writeFile(packageRoot, relative)
  }
  for (const relative of [
    'resources/app/public',
    'resources/app/data',
    'resources/app/prisma',
  ]) {
    fs.mkdirSync(path.join(packageRoot, relative), { recursive: true })
  }

  return { packageRoot, pageSourceRoot, dataSourceRoot, publicSourceRoot }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Electron client package verifier', () => {
  it('reports missing standalone Next.js and WebSocket runtime modules', () => {
    const fixture = createFixture()
    const issues = findClientPackageIssues(
      fixture.packageRoot,
      fixture.pageSourceRoot,
      fixture.dataSourceRoot,
      fixture.publicSourceRoot,
    )

    expect(issues).toContain(
      'missing required file: resources/app/standalone/node_modules/next/package.json',
    )
    expect(issues).toContain(
      'missing required file: resources/app/standalone/node_modules/ws/package.json',
    )
  })
})
