import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const sourceScript = path.resolve('scripts/check-worktree-environment.mjs')
const temporaryRoots: string[] = []

const dependencyPackages = ['next', 'typescript', 'electron']

function writeFile(root: string, relative: string, content = 'fixture') {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function createFixture(options: {
  dependencies?: string[]
  standalone?: boolean
  parentNext?: boolean
} = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb worktree preflight '))
  temporaryRoots.push(parent)
  const root = path.join(parent, 'issue worktree with spaces')
  fs.mkdirSync(root, { recursive: true })

  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture' }))
  writeFile(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }))
  writeFile(root, 'scripts/check-worktree-environment.mjs', fs.readFileSync(sourceScript, 'utf8'))

  for (const packageName of options.dependencies ?? dependencyPackages) {
    writeFile(
      root,
      path.join('node_modules', packageName, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0' }),
    )
  }
  if (options.standalone !== false) writeFile(root, '.next/standalone/server.js')
  if (options.parentNext) {
    writeFile(
      parent,
      'node_modules/next/package.json',
      JSON.stringify({ name: 'next', version: '99.0.0-parent' }),
    )
  }
  return { parent, root }
}

function runPreflight(root: string, mode: string, cwd = root) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts/check-worktree-environment.mjs'), mode],
    { cwd, encoding: 'utf8' },
  )
}

function fingerprint(root: string): string {
  const entries: string[] = []
  function visit(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute)
      if (entry.isDirectory()) {
        entries.push(`directory:${relative}`)
        visit(absolute)
      } else {
        entries.push(`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`)
      }
    }
  }
  visit(root)
  return entries.join('\n')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('worktree environment preflight', () => {
  it('passes a healthy Electron Client fixture without modifying it', () => {
    const { root } = createFixture()
    const before = fingerprint(root)

    const result = runPreflight(root, 'electron-client')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[worktree-preflight] OK')
    expect(result.stdout).toContain(path.resolve(root))
    expect(fingerprint(root)).toBe(before)
  })

  it('rejects a missing local Next package even when the parent has another Next', () => {
    const { root } = createFixture({
      dependencies: dependencyPackages.filter((packageName) => packageName !== 'next'),
      parentNext: true,
    })

    const result = runPreflight(root, 'electron-client')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(path.resolve(root))
    expect(result.stderr).toContain(path.join('node_modules', 'next', 'package.json'))
    expect(result.stderr).toContain('npm.cmd ci --foreground-scripts')
    expect(result.stderr).not.toContain('npm.cmd run build')
  })

  it('reports the Electron Client standalone recovery', () => {
    const { root } = createFixture({ standalone: false })

    const result = runPreflight(root, 'electron-client')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(path.join('.next', 'standalone', 'server.js'))
    expect(result.stderr).toContain('npm.cmd run build')
    expect(result.stderr).not.toContain('npm.cmd ci --foreground-scripts')
  })

  it('rejects the removed Electron Server mode', () => {
    const { root } = createFixture()

    const result = runPreflight(root, 'electron-server')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unsupported mode: electron-server')
    expect(result.stderr).toContain('Expected one of: electron-client, electron-editor')
  })

  it('allows Electron Editor without a Next standalone build', () => {
    const { root } = createFixture({
      dependencies: ['typescript', 'electron'],
      standalone: false,
    })

    const result = runPreflight(root, 'electron-editor')

    expect(result.status).toBe(0)
  })

  it('rejects execution outside the project root with both paths in the error', () => {
    const { root } = createFixture()
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)

    const result = runPreflight(root, 'electron-client', nested)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(path.resolve(root))
    expect(result.stderr).toContain(path.resolve(nested))
  })

  it('runs the preflight before compilation in all Electron development scripts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    for (const role of ['client', 'editor']) {
      const command = String(packageJson.scripts[`dev:electron:${role}`] || '')
      expect(command).toContain(`npm run preflight:electron:${role}`)
      expect(command.indexOf(`npm run preflight:electron:${role}`)).toBeLessThan(command.indexOf('tsc'))
    }
  })

  it('does not require Vitest or project dependencies to execute the CLI', () => {
    const { root } = createFixture({ dependencies: [] })

    expect(() => {
      execFileSync(process.execPath, [path.join(root, 'scripts/check-worktree-environment.mjs'), 'electron-editor'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    }).toThrow()
    const result = runPreflight(root, 'electron-editor')
    expect(result.stderr).toContain(path.join('node_modules', 'typescript', 'package.json'))
  })
})
