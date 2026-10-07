/* eslint-disable @typescript-eslint/no-explicit-any -- Browser module is exercised in a VM. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

type PreviewRequest = {
  snapshot: Record<string, unknown>
  action: Record<string, unknown>
  viewerId: string
  key: string
  revision: number
}

type PreviewController = {
  request: (request: PreviewRequest) => unknown
  clear: () => void
  dispose: () => void
  getDiagnostics: () => any
}

type PreviewModule = {
  create: (options: Record<string, unknown>) => PreviewController
}

function loadPreview() {
  const window: Record<string, any> = {}
  const context = createContext({ window, globalThis: window, console, Date, performance: { now: () => 0 } })
  const source = readFileSync(resolve('data/pages/js/battle-ui/battle-skill-preview.js'), 'utf8')
  new Script(source, { filename: 'battle-skill-preview.js' }).runInContext(context)
  return window.BattleSkillPreview as PreviewModule
}

function makeRequest(overrides: Partial<PreviewRequest> = {}): PreviewRequest {
  return {
    snapshot: {},
    action: { type: 'useBasicSkill', skillId: 'skill-a' },
    viewerId: 'player-a',
    key: 'piece-a:skill-a:target-a',
    revision: 1,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe('RED-224 skill preview coordinator', () => {
  it('calls synchronous compute immediately and shows a ready result', () => {
    const BattleSkillPreview = loadPreview()
    const request = makeRequest()
    const result = { status: 'ready', damage: 4 }
    const compute = vi.fn(() => result)
    const show = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show })

    expect(controller.request(request)).toBe(result)
    expect(compute).toHaveBeenCalledWith(request)
    expect(show).toHaveBeenCalledWith(result, request)
    expect(controller.getDiagnostics()).toMatchObject({
      requestCount: 1,
      requests: [expect.objectContaining({ key: request.key, revision: 1, status: 'ready', displayed: true })],
    })
  })

  it('does not show an async result after a newer target supersedes it', async () => {
    const BattleSkillPreview = loadPreview()
    const first = deferred<{ status: 'ready'; damage: number }>()
    const requestA = makeRequest()
    const requestB = makeRequest({ key: 'piece-a:skill-a:target-b' })
    const compute = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce({ status: 'ready', damage: 2 })
    const show = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show, restore })

    controller.request(requestA)
    controller.request(requestB)
    first.resolve({ status: 'ready', damage: 4 })
    await first.promise
    await Promise.resolve()

    expect(restore).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenLastCalledWith({ status: 'ready', damage: 2 }, requestB)
  })

  it('clears a pending preview and prevents the cancelled promise from showing', async () => {
    const BattleSkillPreview = loadPreview()
    const pending = deferred<{ status: 'ready'; damage: number }>()
    const request = makeRequest()
    const show = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute: () => pending.promise, show, restore })

    controller.request(request)
    controller.clear()
    pending.resolve({ status: 'ready', damage: 4 })
    await pending.promise
    await Promise.resolve()

    expect(restore).toHaveBeenCalledTimes(1)
    expect(show).not.toHaveBeenCalled()
  })

  it('notices unavailable results without showing them', () => {
    const BattleSkillPreview = loadPreview()
    const result = { status: 'unavailable', reason: 'out-of-range' }
    const show = vi.fn()
    const notice = vi.fn()
    const controller = BattleSkillPreview.create({ compute: () => result, show, notice })

    controller.request(makeRequest())

    expect(show).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith(result)
  })

  it('keeps needs-input results on the notice path', () => {
    const BattleSkillPreview = loadPreview()
    const result = { status: 'needs-input', input: 'secondary-target' }
    const show = vi.fn()
    const notice = vi.fn()
    const controller = BattleSkillPreview.create({ compute: () => result, show, notice })

    controller.request(makeRequest())

    expect(show).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith(result)
  })

  it('reuses the same key, revision, and snapshot reference without recomputing or replaying', () => {
    const BattleSkillPreview = loadPreview()
    const request = makeRequest()
    const result = { status: 'ready', damage: 4 }
    const compute = vi.fn(() => result)
    const show = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show })

    controller.request(request)
    controller.request({ ...request, action: { ...request.action } })

    expect(compute).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('keeps cached previews isolated between viewer identities', () => {
    const BattleSkillPreview = loadPreview()
    const snapshot = {}
    const requestA = makeRequest({ snapshot, viewerId: 'player-a' })
    const requestB = makeRequest({ snapshot, viewerId: 'player-b' })
    const resultA = { status: 'ready', viewerId: 'player-a' }
    const resultB = { status: 'ready', viewerId: 'player-b' }
    const compute = vi.fn()
      .mockReturnValueOnce(resultA)
      .mockReturnValueOnce(resultB)
    const show = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show, restore })

    controller.request(requestA)
    controller.clear()
    expect(controller.request(requestB)).toBe(resultB)

    expect(compute).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenNthCalledWith(1, resultA, requestA)
    expect(show).toHaveBeenNthCalledWith(2, resultB, requestB)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('replays a cached ready result after clear without recomputing', () => {
    const BattleSkillPreview = loadPreview()
    const request = makeRequest()
    const result = { status: 'ready', damage: 4 }
    const compute = vi.fn(() => result)
    const show = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show, restore })

    controller.request(request)
    controller.clear()
    expect(controller.request(request)).toBe(result)

    expect(compute).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(2)
    expect(show).toHaveBeenLastCalledWith(result, request)
  })

  it('restores an unavailable notice when the preview is cleared', () => {
    const BattleSkillPreview = loadPreview()
    const result = { status: 'unavailable', reason: 'out-of-range' }
    const notice = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute: () => result, notice, restore })

    controller.request(makeRequest())
    controller.clear()

    expect(notice).toHaveBeenCalledWith(result)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('invalidates the cached preview when revision or snapshot changes', () => {
    const BattleSkillPreview = loadPreview()
    const snapshot = {}
    const compute = vi.fn((request: PreviewRequest) => ({ status: 'ready', revision: request.revision }))
    const show = vi.fn()
    const restore = vi.fn()
    const controller = BattleSkillPreview.create({ compute, show, restore })

    controller.request(makeRequest({ snapshot, revision: 1 }))
    controller.request(makeRequest({ snapshot, revision: 2 }))
    controller.request(makeRequest({ snapshot: {}, revision: 2 }))

    expect(compute).toHaveBeenCalledTimes(3)
    expect(show).toHaveBeenCalledTimes(3)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('bounds the result cache to sixteen entries', () => {
    const BattleSkillPreview = loadPreview()
    const controller = BattleSkillPreview.create({ compute: () => ({ status: 'ready' }) })

    for (let index = 0; index < 17; index += 1) {
      controller.request(makeRequest({ key: 'target-' + index }))
    }

    expect(controller.getDiagnostics().cacheSize).toBe(16)
  })

  it('bounds diagnostics to sixty-four lightweight entries while retaining the total count', () => {
    const BattleSkillPreview = loadPreview()
    const controller = BattleSkillPreview.create({ compute: () => ({ status: 'ready' }) })

    for (let index = 0; index < 65; index += 1) {
      controller.request(makeRequest({ key: 'diagnostic-target-' + index }))
    }

    const diagnostics = controller.getDiagnostics()
    expect(diagnostics.requestCount).toBe(65)
    expect(diagnostics.requests).toHaveLength(64)
    expect(diagnostics.requests[0].id).toBe(2)
    expect(diagnostics.requests.every((entry: any) => (
      !('request' in entry) && !('snapshot' in entry) && !('action' in entry)
    ))).toBe(true)
  })

  it('reports compute errors, notices unavailable, and leaves selection control to the caller', () => {
    const BattleSkillPreview = loadPreview()
    const error = new Error('preview failed')
    const request = makeRequest()
    const onError = vi.fn()
    const notice = vi.fn()
    const controller = BattleSkillPreview.create({ compute: () => { throw error }, onError, notice })

    expect(() => controller.request(request)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(error, request)
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' }))
  })

  it('rejects future requests after disposal and releases cached diagnostics', () => {
    const BattleSkillPreview = loadPreview()
    const compute = vi.fn(() => ({ status: 'ready' }))
    const controller = BattleSkillPreview.create({ compute })

    controller.dispose()
    controller.request(makeRequest())

    expect(compute).not.toHaveBeenCalled()
    expect(controller.getDiagnostics()).toEqual({
      disposed: true,
      active: null,
      cacheSize: 0,
      requestCount: 0,
      requests: [],
    })
  })

  it('does not repopulate cache or diagnostics when a disposed request settles', async () => {
    const BattleSkillPreview = loadPreview()
    const pending = deferred<{ status: 'ready'; damage: number }>()
    const controller = BattleSkillPreview.create({ compute: () => pending.promise })

    controller.request(makeRequest())
    controller.dispose()
    pending.resolve({ status: 'ready', damage: 4 })
    await pending.promise
    await Promise.resolve()

    expect(controller.getDiagnostics()).toEqual({
      disposed: true,
      active: null,
      cacheSize: 0,
      requestCount: 0,
      requests: [],
    })
  })
})
