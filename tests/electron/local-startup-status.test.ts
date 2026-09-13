import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_STARTUP_STATUS_SCRIPT } from '../../electron-client/local-startup-status'

describe('built-in startup status on installed menus', () => {
  function render(selectedMode: string, ready = true) {
    const box = { id: '', textContent: '', style: { cssText: '' }, setAttribute() {}, remove: vi.fn(), appendChild: vi.fn() }
    const storage = new Map([['rvb_lobby_server_mode', selectedMode]])
    const save = vi.fn(), timer = vi.fn()
    const mode = { ready, localUrl: 'http://127.0.0.1:39999', localAuthorityRecovery: { status: 'starting' } }
    const api = { getMode: async () => mode }
    const utils = { saveServerConfig: save }
    vm.runInNewContext(LOCAL_STARTUP_STATUS_SCRIPT, {
      document: { getElementById: () => null, createElement: () => box, body: { appendChild() {} } },
      localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
      window: { electronAPI: api, RvBUtils: utils }, RvBUtils: utils, setTimeout: timer,
    })
    return { box, storage, save, timer }
  }

  it.each(['lan', 'remote'])('does not replace a selected %s server when local startup finishes', async selected => {
    const run = render(selected)
    await new Promise(resolve => setImmediate(resolve))
    expect(run.save).not.toHaveBeenCalled()
    expect(run.storage.get('rvb_local_server_url')).toBe('http://127.0.0.1:39999')
    expect(run.box.remove).toHaveBeenCalledOnce()
  })

  it('sets the actual ready port for a local selection', async () => {
    const run = render('local')
    await new Promise(resolve => setImmediate(resolve))
    expect(run.save).toHaveBeenCalledWith({ mode: 'local', url: 'http://127.0.0.1:39999' })
  })

  it('shows a nonblocking progress message while services are pending', async () => {
    const run = render('local', false)
    await new Promise(resolve => setImmediate(resolve))
    expect(run.box.textContent).toContain('可以先浏览菜单')
    expect(run.timer).toHaveBeenCalledWith(expect.any(Function), 300)
    expect(run.save).not.toHaveBeenCalled()
  })
})
