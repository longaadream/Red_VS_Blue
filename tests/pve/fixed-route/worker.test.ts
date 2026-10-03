import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  snapshot: vi.fn(() => ({ revision: 0, route: { phase: 'between' } })),
  enter: vi.fn(),
  human: vi.fn(),
}))

vi.mock('@/lib/content-pipeline/runtime/profile-game-identity', () => ({
  parseGameProfileIdentityV1: (value: unknown) => value,
}))
vi.mock('@/lib/pve/fixed-route/session', () => ({ createFixedRouteSession: mocked.create }))

type WorkerScope = { onmessage: (event: { data: unknown }) => Promise<void> }
const scope = globalThis as unknown as WorkerScope
let post: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  post = vi.fn()
  vi.stubGlobal('__RVB_PRACTICE_PROFILE__', { testProfile: true })
  vi.stubGlobal('postMessage', post)
  vi.stubGlobal('onmessage', undefined)
  mocked.create.mockResolvedValue({ snapshot: mocked.snapshot, enter: mocked.enter, human: mocked.human })
  await import('@/lib/pve/fixed-route/worker')
  expect(post).toHaveBeenCalledWith({ ready: true })
  post.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

async function send(id: number, type: string, payload: unknown = {}) {
  await scope.onmessage({ data: { id, type, payload } })
  return post.mock.calls.find(call => call[0].id === id)?.[0]
}

describe('fixed route worker command boundary', () => {
  it.each([null, [], 'invalid', 4])('responds to malformed payload %j without starting a run', async payload => {
    const response = await send(1, 'start', payload)
    expect(response.error.message).toContain('参数无效')
    expect(mocked.create).not.toHaveBeenCalled()
    expect((await send(2, 'start')).result.route.phase).toBe('between')
  })

  it('refuses uploaded state, winners and extra setup fields', async () => {
    expect((await send(1, 'start', { seed: 123, winner: 'human' })).error.message).toContain('未允许字段')
    expect(mocked.create).not.toHaveBeenCalled()
    await send(2, 'start', { seed: 123 })
    expect((await send(3, 'enter', { revision: 0, state: {} })).error.message).toContain('未允许字段')
    expect((await send(4, 'human', { revision: 0, action: { type: 'endTurn' }, winner: 'human' })).error.message).toContain('未允许字段')
    expect(mocked.enter).not.toHaveBeenCalled()
    expect(mocked.human).not.toHaveBeenCalled()
  })

  it('keeps one run for repeated start commands', async () => {
    await send(1, 'start', { seed: 123 })
    expect((await send(2, 'start', { seed: 456 })).error.message).toContain('已经开始')
    expect(mocked.create).toHaveBeenCalledTimes(1)
    expect((await send(3, 'snapshot')).result.revision).toBe(0)
  })

  it('rejects overlap while asynchronous startup owns the worker', async () => {
    let resolveStart!: (value: unknown) => void
    mocked.create.mockImplementationOnce(() => new Promise(resolve => { resolveStart = resolve }))
    const starting = send(1, 'start', { seed: 123 })
    expect((await send(2, 'restart', { seed: 456 })).error.message).toContain('尚未完成')
    expect(mocked.create).toHaveBeenCalledTimes(1)
    resolveStart({ snapshot: mocked.snapshot })
    expect((await starting).result.route.phase).toBe('between')
    expect((await send(3, 'snapshot')).result.revision).toBe(0)
  })
})
