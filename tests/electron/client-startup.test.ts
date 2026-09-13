import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

describe('Windows visible startup', () => {
  it('loads a startup window before preparing services and reuses it for the game', () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const ready = main.slice(main.indexOf('app.whenReady().then'), main.indexOf("app.on('window-all-closed'"))
    expect(ready).toContain('await showStartupWindow()')
    expect(ready.indexOf('await showStartupWindow()')).toBeLessThan(ready.indexOf('await setupPackProtocol()'))
    expect(ready).toContain('loadLocalGame(win)')
    expect(ready).toContain('startStableLocalServerAndRecover(generation)')
    const config = JSON.parse(readFileSync('config/electron-builder.client.json', 'utf8'))
    expect(config.files).toContain('electron-client/startup/**')
  })

  it('does not wait indefinitely for animation frames in a minimized window', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('async function showStartupWindow()'), main.indexOf('function getApplicationIconPath()'))
    const win = { on() {}, loadURL: async () => {}, webContents: { executeJavaScript: () => new Promise(() => {}) } }
    const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022 })
    const result = vm.runInNewContext(`${js}; showStartupWindow()`, {
      createGameWindow: () => win, startupPageUrl: () => 'file:///startup/index.html',
      setTimeout, startupInProgress: true, requestApplicationExit() {},
    })
    expect(await result).toBe(win)
  })

  it('requires durable shutdown even while the startup window is visible', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('function requestApplicationExit()'), main.indexOf('// ─── 本地服务器管理'))
    for (const startupInProgress of [false, true]) {
      const drains: boolean[] = []
      const context = {
        startupInProgress, startupCancelled: false, startupCompletedStages: 3, mainWin: null, officialUpdateApplying: false,
        reportStartupProgress() {},
        allowAppExit: false, appExitPromise: null as unknown,
        killServer: async (durable: boolean) => { drains.push(durable) },
        app: { exit() {} }, console, dialog: { showErrorBox() {} },
      }
      vm.runInNewContext(ts.transpile(source) + '; requestApplicationExit()', context)
      await context.appExitPromise
      expect(context.startupCancelled).toBe(startupInProgress)
      expect(drains).toEqual([true])
    }
  })

  it('keeps the startup window open when durable exit needs a retry', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const show = main.slice(main.indexOf('async function showStartupWindow()'), main.indexOf('function getApplicationIconPath()'))
    const exit = main.slice(main.indexOf('function requestApplicationExit()'), main.indexOf('// ─── 本地服务器管理'))
    const listeners: Record<string, (event: { preventDefault: () => void }) => void> = {}
    let prevented = false
    let exited = false
    const messages: string[] = []
    const context = {
      createGameWindow: () => ({ on: (name: string, cb: typeof listeners[string]) => { listeners[name] = cb }, loadURL: async () => {}, webContents: { executeJavaScript: async () => {} } }),
      startupPageUrl: () => 'file:///startup/index.html', setTimeout,
      startupInProgress: true, startupCancelled: false, startupCompletedStages: 4, mainWin: null, officialUpdateApplying: false,
      allowAppExit: false, appExitPromise: null as unknown,
      killServer: async () => { throw new Error('PROFILE_DURABLE_DRAIN_FAILED') },
      app: { exit: () => { exited = true } }, console: { error() {} }, dialog: { showErrorBox() {} },
      reportStartupProgress: (_step: number, message: string) => messages.push(message),
    }
    await vm.runInNewContext(ts.transpile(exit + show) + '; showStartupWindow()', context)
    listeners.close({ preventDefault: () => { prevented = true } })
    await context.appExitPromise
    expect(prevented).toBe(true)
    expect(exited).toBe(false)
    expect(context.appExitPromise).toBeNull()
    expect(messages.at(-1)).toContain('重试退出')
  })

  it('does not revive a cancelled startup when the in-flight menu finishes late', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('function loadLocalGame('), main.indexOf('function loadOnlineGame('))
    let loaded!: () => void
    let injected = false
    const win = {
      loadURL: async () => {},
      webContents: {
        once: (_name: string, listener: () => void) => { loaded = listener },
        getURL: () => 'rvb-client://app/index.html',
        executeJavaScript: () => { injected = true },
      },
    }
    const context = { startupCancelled: false, startupInProgress: true, CLIENT_SCHEME: 'rvb-client',
      isGameClientUrl: () => true, gameServerProcess: {}, localGameReady: true, actualGamePort: 38621, win }
    vm.runInNewContext(ts.transpile(source) + '; loadLocalGame(win)', context)
    context.startupCancelled = true
    loaded()
    expect(context.startupInProgress).toBe(true)
    expect(injected).toBe(false)
  })

  it('cancels a menu navigation even before its URL commits', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('function requestApplicationExit()'), main.indexOf('// ─── 本地服务器管理'))
    const actions: string[] = []
    const context = {
      startupInProgress: true, startupCancelled: false, startupCompletedStages: 5, officialUpdateApplying: false,
      startupPageUrl: () => 'file:///startup/index.html',
      mainWin: { isDestroyed: () => false, webContents: {
        getURL: () => 'file:///startup/index.html', isLoadingMainFrame: () => true,
        stop: () => actions.push('stop'),
      }, loadURL: async (url: string) => { actions.push(url) } },
      reportStartupProgress() {}, allowAppExit: false, appExitPromise: null as unknown,
      killServer: async () => {}, app: { exit() {} }, console, dialog: { showErrorBox() {} },
    }
    vm.runInNewContext(ts.transpile(source) + '; requestApplicationExit()', context)
    await context.appExitPromise
    expect(actions).toEqual(['stop', 'file:///startup/index.html'])
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function boot(overrides: Record<string, unknown> = {}) {
  const events: string[] = []
  const win = { isDestroyed: () => false }
  const context = {
    app: { whenReady: () => Promise.resolve() }, process: { platform: 'linux' },
    console: { log() {}, info() {}, warn() {}, error() {} },
    startupCancelled: false, localGameReady: true,
    showStartupWindow: async () => { events.push('visible'); return win },
    localGameLifecycle: { beginOpening: () => 7 },
    assertLocalGameOpeningCurrent: () => {},
    reportStartupProgress: (step: number, _message: string, failed = false) => events.push(failed ? 'failed' : `stage:${step}`),
    setupPackProtocol: async () => { events.push('protocol') },
    session: { defaultSession: { clearStorageData: async () => { events.push('cache') } } },
    startStableLocalServerAndRecover: async () => { events.push('services') },
    localAuthorityRecoveryBudget: { recordSuccess: () => {} },
    localAuthorityRecoveryStatus: '', localAuthorityNotice: '',
    localAuthorityStartupErrorMessage: () => '服务未就绪，请重试',
    loadLocalGame: (existing: unknown) => { expect(existing).toBe(win); events.push('menu') },
    setupOfficialUpdates() {},
    ...overrides,
  }
  const main = readFileSync('electron-client/main.ts', 'utf8')
  const handler = main.slice(main.indexOf('app.whenReady().then'), main.indexOf("app.on('window-all-closed'"))
  const done = vm.runInNewContext(handler, context) as Promise<void>
  return { done, context, events }
}

describe('actual startup handler under delayed service responses', () => {
  it('has already shown the window and stage while services are still pending', async () => {
    const service = deferred()
    const started = deferred()
    const run = boot({ startStableLocalServerAndRecover: async (generation: number) => {
      expect(generation).toBe(7); started.resolve(); await service.promise
    } })
    await started.promise
    expect(run.events).toEqual(['visible', 'stage:0', 'protocol', 'stage:1', 'cache', 'stage:2'])
    service.resolve()
    await run.done
    expect(run.events.slice(-2)).toEqual(['stage:5', 'menu'])
  })

  it('does not reopen the game after cancellation during startup', async () => {
    const service = deferred()
    const started = deferred()
    const run = boot({ startStableLocalServerAndRecover: async () => { started.resolve(); await service.promise } })
    await started.promise
    run.context.startupCancelled = true
    service.resolve()
    await run.done
    expect(run.events).not.toContain('menu')
  })

  it('preserves the manual recovery menu when service startup fails', async () => {
    const run = boot({ startStableLocalServerAndRecover: async () => { throw new Error('timeout') } })
    await run.done
    expect(run.context.localAuthorityRecoveryStatus).toBe('manual-required')
    expect(run.context.localAuthorityNotice).toContain('重试')
    expect(run.events.at(-1)).toBe('menu')
  })

  it('shows a failure instead of hanging on a fatal resource error', async () => {
    const run = boot({ setupPackProtocol: async () => { throw new Error('protocol unavailable') } })
    await run.done
    expect(run.events).toEqual(['visible', 'stage:0', 'failed'])
    expect(run.events).not.toContain('menu')
  })
})
