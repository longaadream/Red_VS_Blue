import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { describe, expect, test } from 'vitest'

const root = path.resolve(__dirname, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function applicationExitHarness(shutdown: () => Promise<void>) {
  const main = read('electron-client/main.ts').replace(/\r/g, '')
  const start = main.indexOf('function requestApplicationExit(')
  const end = main.indexOf('\n\n// ─── 本地服务器管理', start)
  if (start < 0 || end < 0) throw new Error('application exit function boundary missing')
  const errors: unknown[][] = []
  const exits: number[] = []
  const context = vm.createContext({
    officialUpdateApplying: false,
    allowAppExit: false,
    startupInProgress: false,
    startupCompletedStages: 0,
    initialLocalStartupPromise: null,
    mainWin: null,
    appExitPromise: null,
    app: { exit: (code: number) => exits.push(code) },
    dialog: { showErrorBox: (...args: unknown[]) => errors.push(args) },
    killServer: shutdown,
    reportStartupProgress: () => {},
    console,
  })
  vm.runInContext(transformSync(main.slice(start, end), { loader: 'ts' }).code, context)
  const request = vm.runInContext('requestApplicationExit', context) as () => Promise<void>
  return { context, request, errors, exits }
}

describe('RED-250 desktop application exit', () => {
  test('registers an exit request only for the trusted game renderer and keeps the graceful quit path', () => {
    const main = read('electron-client/main.ts')
    const registration = "handleTrusted('request-application-exit', ['game']"
    const registrationStart = main.indexOf(registration)
    const registrationEnd = main.indexOf('// 读取已保存的远程服务器地址', registrationStart)

    expect(registrationStart).toBeGreaterThanOrEqual(0)
    expect(main.slice(registrationStart, registrationEnd)).toContain('requestApplicationExit()')
    expect(main.slice(registrationStart, registrationEnd)).not.toContain('app.exit')
    expect(main.slice(registrationStart, registrationEnd)).not.toContain('process.exit')
    expect(main.slice(registrationStart, registrationEnd)).toContain('return requestApplicationExit()')
    expect(main).toContain("app.on('before-quit', event =>")
    expect(main.slice(main.indexOf("app.on('before-quit', event =>"))).toContain('requestApplicationExit()')
    expect(main).toContain('void requestApplicationExit().catch(() => {})')
  })

  test('exposes the trusted exit request through the preload bridge', () => {
    const preload = read('electron-client/preload.ts')

    expect(preload).toContain("requestApplicationExit: () => ipcRenderer.invoke('request-application-exit')")
    expect(preload).not.toContain('BrowserWindow')
  })

  test('makes the main menu exit control desktop-only and failure-visible', () => {
    const menu = read('data/pages/index.html')

    expect(menu).toContain('data-application-exit-control')
    expect(menu).toContain('data-application-exit')
    expect(menu).toContain('data-application-exit-error')
    expect(menu).toContain('requestApplicationExit')
    expect(menu).toContain('button.disabled = true')
    expect(menu).toContain('control.hidden = true')
    expect(menu).toContain('position: fixed !important')
    expect(menu).toContain('.official-update-panel .application-exit-button')
    expect(menu).toContain('new MutationObserver(syncExitLayer)')
  })

  test('makes the battle settings exit control failure-visible and one-shot', () => {
    const settings = read('data/pages/js/battle-settings.js')

    expect(settings).toContain('data-application-exit')
    expect(settings).toContain('data-application-exit-error')
    expect(settings).toContain('requestApplicationExit')
    expect(settings).toContain('exit.disabled=true')
    expect(settings).toContain('exitRequested')
  })

  test('propagates durable shutdown failure so the renderer can retry', async () => {
    let attempts = 0
    const harness = applicationExitHarness(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('PROFILE_DURABLE_DRAIN_FAILED')
    })

    await expect(harness.request()).rejects.toThrow('PROFILE_DURABLE_DRAIN_FAILED')
    expect(attempts).toBe(1)
    expect(harness.context.appExitPromise).toBeNull()
    expect(harness.context.allowAppExit).toBe(false)
    expect(harness.errors).toHaveLength(1)

    await expect(harness.request()).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(harness.context.allowAppExit).toBe(true)
    expect(harness.exits).toEqual([0])
  })
})
