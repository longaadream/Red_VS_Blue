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
    expect(ready).toContain('startStableProfileServerAndRecover(generation)')
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
        startupInProgress, initialLocalStartupPromise: null, startupCancelled: false, startupCompletedStages: 3, mainWin: null, officialUpdateApplying: false,
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
      startupInProgress: true, initialLocalStartupPromise: null, startupCancelled: false, startupCompletedStages: 4, mainWin: null, officialUpdateApplying: false,
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
      startupInProgress: true, initialLocalStartupPromise: null, startupCancelled: false, startupCompletedStages: 5, officialUpdateApplying: false,
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
    startupCancelled: false, localGameReady: true, initialLocalStartupPromise: null, resourceUpdates: null,
    showStartupWindow: async () => { events.push('visible'); return win },
    localGameLifecycle: { beginOpening: () => 7 },
    assertLocalGameOpeningCurrent: () => {},
    reportStartupProgress: (step: number, _message: string, failed = false) => events.push(failed ? 'failed' : `stage:${step}`),
    setupPackProtocol: async () => { events.push('protocol') },
    session: { defaultSession: { clearStorageData: async () => { events.push('cache') } } },
    startStableProfileServerAndRecover: async () => { events.push('profile') },
    startLocalGameAuthority: async () => { events.push('services') },
    stableProfileBinding: () => ({}),
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
  it('keeps the menu behind profile recovery, but not database startup', async () => {
    const profile = deferred()
    const started = deferred()
    const run = boot({ startStableProfileServerAndRecover: async () => { started.resolve(); await profile.promise } })
    await started.promise
    expect(run.events).not.toContain('menu')
    profile.resolve()
    await run.done
    expect(run.events.indexOf('menu')).toBeLessThan(run.events.indexOf('services'))
  })

  it('intercepts closing an early menu while services are still starting', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('async function showStartupWindow()'), main.indexOf('function getApplicationIconPath()'))
    const listeners: Record<string, (event: { preventDefault: () => void }) => void> = {}
    let prevented = false, exiting = false
    await vm.runInNewContext(ts.transpile(source) + '; showStartupWindow()', {
      createGameWindow: () => ({ on: (name: string, callback: typeof listeners[string]) => { listeners[name] = callback }, loadURL: async () => {}, webContents: { executeJavaScript: async () => {} } }),
      startupPageUrl: () => 'file:///startup/index.html', setTimeout, startupInProgress: false,
      initialLocalStartupPromise: Promise.resolve(), allowAppExit: false,
      requestApplicationExit: () => { exiting = true },
    })
    listeners.close({ preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(exiting).toBe(true)
  })

  it('does not start the database if the menu closes before loading completes', async () => {
    const menu = deferred()
    const opening = deferred()
    const run = boot({
      loadLocalGame: async () => { opening.resolve(); await menu.promise },
      assertLocalGameOpeningCurrent: () => { if (run.context.startupCancelled) throw new Error('cancelled') },
    })
    await opening.promise
    run.context.startupCancelled = true
    menu.resolve()
    await run.done
    expect(run.events).not.toContain('services')
    expect(run.context.initialLocalStartupPromise).toBeNull()
  })

  it('has already shown the window and stage while services are still pending', async () => {
    const service = deferred()
    const started = deferred()
    const run = boot({ startLocalGameAuthority: async () => {
      started.resolve(); await service.promise
    } })
    await started.promise
    expect(run.events).toContain('menu')
    service.resolve()
    await run.done
    expect(run.events.filter(event => event === 'menu')).toHaveLength(1)
  })

  it('does not reopen the game after cancellation during startup', async () => {
    const service = deferred()
    const started = deferred()
    const run = boot({ startStableProfileServerAndRecover: async () => { started.resolve(); await service.promise },
      assertLocalGameOpeningCurrent: () => { if (run.context.startupCancelled) throw new Error('cancelled') },
    })
    await started.promise
    run.context.startupCancelled = true
    service.resolve()
    await run.done
    expect(run.events).not.toContain('menu')
  })

  it('preserves the manual recovery menu when service startup fails', async () => {
    const run = boot({ localGameReady: false, startLocalGameAuthority: async () => { throw new Error('timeout') } })
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

describe('menu actions during background startup', () => {
  it('does not announce ready before the authority identity is verified', () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf("handleTrusted('get-mode'"), main.indexOf('// 重启本地服务器'))
    let mode!: () => { ready: boolean; isLocal: boolean }
    const context = {
      handleTrusted: (_name: string, _roles: string[], callback: typeof mode) => { mode = callback },
      localGameReady: true, localAuthorityProfileIdentity: null as unknown,
      actualGamePort: 38621, actualLocalPort: 38521, localProfileIdentity: {},
      localAuthorityNotice: null, localAuthorityRecoveryStatus: 'starting',
      localAuthorityRecoveryBudget: { snapshot: () => ({}) },
    }
    vm.runInNewContext(ts.transpile(source), context)
    expect(mode()).toMatchObject({ ready: false, isLocal: false })
    context.localAuthorityProfileIdentity = {}
    expect(mode()).toMatchObject({ ready: true, isLocal: true })
  })

  function ensureContext() {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf("handleTrusted('ensure-local-authority'"), main.indexOf('// 查询当前模式'))
    let handler!: () => Promise<{ ok: boolean }>
    let recoveries = 0
    const pending = deferred()
    const context = {
      handleTrusted: (_name: string, _roles: string[], callback: typeof handler) => { handler = callback },
      initialLocalStartupPromise: pending.promise, startupCancelled: false,
      localGameLifecycle: { shutdownInProgress: false }, localGameReady: false, gameServerProcess: {},
      localAuthorityNotice: '请稍后重试',
      recoverUnexpectedLocalAuthorityExit: async () => { recoveries++ },
    }
    vm.runInNewContext(ts.transpile(source), context)
    return { handler, context, pending, recoveries: () => recoveries }
  }

  it('joins one pending startup for concurrent clicks without starting crash recovery', async () => {
    const run = ensureContext()
    const first = run.handler(), second = run.handler()
    run.context.localGameReady = true
    run.pending.resolve()
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
    expect(run.recoveries()).toBe(0)
  })

  it('fails a waiting action when startup fails or the app closes', async () => {
    for (const cancelled of [false, true]) {
      const run = ensureContext()
      const action = run.handler()
      run.context.startupCancelled = cancelled
      run.context.localGameReady = cancelled
      run.pending.resolve()
      expect(await action).toMatchObject({ ok: false })
      expect(run.recoveries()).toBe(0)
    }
  })

  it('blocks an update while initial startup owns the services', async () => {
    const main = readFileSync('electron-client/main.ts', 'utf8')
    const source = main.slice(main.indexOf('async function canApplyOfficialUpdate()'), main.indexOf('function updateAuthorityAdmission('))
    expect(await vm.runInNewContext(ts.transpile(source) + '; canApplyOfficialUpdate()', {
      initialLocalStartupPromise: Promise.resolve(),
    })).toBe(false)
  })
})
