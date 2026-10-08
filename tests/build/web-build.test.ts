import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { prepareWebStandalone } from '../../scripts/prepare-web-standalone.mjs'
import { runStep } from '../../scripts/build-web.mjs'
import {
  configureWebEnvironment,
  standaloneServerPath,
  startWebServer,
} from '../../scripts/start-web.mjs'

const temporaryRoots: string[] = []

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-web-build-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('source web build pipeline', () => {
  it('copies static and public assets into a flat standalone output', () => {
    const root = createRoot()
    fs.mkdirSync(path.join(root, '.next', 'standalone'), { recursive: true })
    fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true })
    fs.mkdirSync(path.join(root, 'public'), { recursive: true })
    fs.writeFileSync(path.join(root, '.next', 'standalone', 'server.js'), 'server')
    fs.writeFileSync(path.join(root, '.next', 'static', 'chunk.js'), 'chunk')
    fs.writeFileSync(path.join(root, 'public', 'asset.txt'), 'asset')

    const output = prepareWebStandalone(root)

    expect(output.serverPath).toBe(standaloneServerPath(root))
    expect(fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunk.js'), 'utf8')).toBe('chunk')
    expect(fs.readFileSync(path.join(root, '.next', 'standalone', 'public', 'asset.txt'), 'utf8')).toBe('asset')
  })

  it('rejects a nested standalone server instead of accepting a non-runnable build', () => {
    const root = createRoot()
    fs.mkdirSync(path.join(root, '.next', 'standalone', 'Red_VS_Blue'), { recursive: true })
    fs.writeFileSync(path.join(root, '.next', 'standalone', 'Red_VS_Blue', 'server.js'), 'nested')
    fs.mkdirSync(path.join(root, '.next', 'static'), { recursive: true })
    fs.mkdirSync(path.join(root, 'public'), { recursive: true })

    expect(() => prepareWebStandalone(root)).toThrow(/flat Next standalone server/)
  })

  it('preserves a child failure status and identifies the failed build step', async () => {
    const root = createRoot()
    const failureScript = path.join(root, 'fail.mjs')
    fs.writeFileSync(failureScript, 'process.exit(17)')

    await expect(runStep({
      name: 'fixture runner',
      command: process.execPath,
      args: [failureScript],
      cwd: root,
      stdio: 'ignore',
    })).rejects.toMatchObject({ step: 'fixture runner', exitCode: 17 })
  })

  it('reports a clear error when start is attempted without a flat build', async () => {
    const root = createRoot()
    await expect(startWebServer(root)).rejects.toThrow(
      new RegExp(`expected standalone server at ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
  })

  it('defaults source and writable roots to the checkout while preserving overrides', () => {
    const root = createRoot()
    const environment: Record<string, string | undefined> = {}
    configureWebEnvironment(root, environment)
    expect(environment.APP_ROOT_DIR).toBe(root)
    expect(environment.USER_DATA_DIR).toBe(root)

    expect(configureWebEnvironment(root, { APP_ROOT_DIR: 'app', USER_DATA_DIR: 'state' })).toMatchObject({
      APP_ROOT_DIR: path.join(root, 'app'),
      USER_DATA_DIR: path.join(root, 'state'),
    })
  })
})
