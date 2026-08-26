import { describe, expect, it, vi } from 'vitest'
import { BattleAuthorityAsyncJournal } from '@/lib/server/battle-authority-async-journal'

describe('battle authority async journal', () => {
  it('accepts a transition without waiting for durable storage', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const journal = new BattleAuthorityAsyncJournal({ retryDelaysMs: [] })
    const persist = vi.fn(async () => blocked)

    expect(journal.enqueue({
      roomId: 'room-a',
      kind: 'transition',
      authorityVersion: 1,
      clientActionId: 'action-1',
      persist,
    })).toBe(true)
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'pending',
      durableAuthorityVersion: 0,
      pending: 1,
    })
    expect(persist).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))

    release()
    await journal.drain('room-a')
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'durable',
      durableAuthorityVersion: 1,
      pending: 0,
    })
  })

  it('uses one storage writer while preserving each room order', async () => {
    const journal = new BattleAuthorityAsyncJournal({ retryDelaysMs: [] })
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const job = (label: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      order.push(label)
      active -= 1
    }

    journal.enqueue({ roomId: 'room-a', kind: 'transition', authorityVersion: 1, persist: job('a1') })
    journal.enqueue({ roomId: 'room-a', kind: 'transition', authorityVersion: 2, persist: job('a2') })
    journal.enqueue({ roomId: 'room-b', kind: 'transition', authorityVersion: 1, persist: job('b1') })
    await journal.drain()

    expect(maxActive).toBe(1)
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'))
    expect(journal.inspect('room-a').durableAuthorityVersion).toBe(2)
    expect(journal.inspect('room-b').durableAuthorityVersion).toBe(1)
  })

  it('retries a failed write only within the configured bound and degrades the room', async () => {
    const onStateChange = vi.fn()
    const journal = new BattleAuthorityAsyncJournal({
      retryDelaysMs: [0, 0],
      onStateChange,
    })
    const persist = vi.fn(async () => { throw new Error('database locked') })

    journal.enqueue({
      roomId: 'room-a',
      kind: 'transition',
      authorityVersion: 1,
      clientActionId: 'action-1',
      persist,
    })
    await expect(journal.drain('room-a')).rejects.toThrow('database locked')

    expect(persist).toHaveBeenCalledTimes(3)
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'degraded',
      durableAuthorityVersion: 0,
      pending: 0,
      lastError: 'database locked',
    })
    expect(onStateChange).toHaveBeenCalled()
    expect(journal.enqueue({
      roomId: 'room-a',
      kind: 'receipt',
      persist: vi.fn(),
    })).toBe(false)
  })

  it('fails closed when a room exceeds the bounded pending journal', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const journal = new BattleAuthorityAsyncJournal({
      maxPendingPerRoom: 1,
      retryDelaysMs: [],
    })

    expect(journal.enqueue({ roomId: 'room-a', kind: 'receipt', persist: () => blocked })).toBe(true)
    expect(journal.enqueue({ roomId: 'room-a', kind: 'receipt', persist: vi.fn() })).toBe(false)
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'degraded',
      pending: 1,
    })

    release()
    await expect(journal.drain('room-a')).rejects.toThrow('pending limit')
  })

  it('aborts a cooperative stuck write before continuing the global writer', async () => {
    let active = 0
    let maxActive = 0
    const journal = new BattleAuthorityAsyncJournal({
      retryDelaysMs: [0, 0],
      persistTimeoutMs: 20,
    })
    const roomAPersist = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const abort = () => {
        active -= 1
        reject(new Error('write aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
    }))
    const roomBPersist = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      active -= 1
    })

    journal.enqueue({ roomId: 'room-a', kind: 'transition', authorityVersion: 1, persist: roomAPersist })
    journal.enqueue({ roomId: 'room-b', kind: 'transition', authorityVersion: 1, persist: roomBPersist })

    await expect(journal.drain()).rejects.toThrow('persist timed out after 20ms in room-a')
    expect(maxActive).toBe(1)
    expect(roomBPersist).toHaveBeenCalledTimes(1)
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'degraded',
      pending: 0,
      durableAuthorityVersion: 0,
    })
    expect(journal.inspect('room-b')).toMatchObject({
      status: 'durable',
      pending: 0,
      durableAuthorityVersion: 1,
    })
  })

  it('never overlaps another durable write when an adapter ignores cancellation', async () => {
    let release!: () => void
    let active = 0
    let maxActive = 0
    const stuck = new Promise<void>(resolve => { release = resolve })
    const journal = new BattleAuthorityAsyncJournal({
      retryDelaysMs: [],
      persistTimeoutMs: 20,
    })
    const roomBPersist = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      active -= 1
    })

    journal.enqueue({
      roomId: 'room-a',
      kind: 'transition',
      authorityVersion: 1,
      persist: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await stuck
        active -= 1
      },
    })
    journal.enqueue({ roomId: 'room-b', kind: 'transition', authorityVersion: 1, persist: roomBPersist })

    await vi.waitFor(() => expect(journal.inspect('room-a').status).toBe('degraded'))
    expect(roomBPersist).not.toHaveBeenCalled()
    expect(maxActive).toBe(1)

    release()
    await expect(journal.drain()).rejects.toThrow('persist timed out after 20ms in room-a')
    expect(roomBPersist).toHaveBeenCalledTimes(1)
    expect(maxActive).toBe(1)
  })

  it('closes ingress before a graceful drain without degrading durable rooms', async () => {
    const journal = new BattleAuthorityAsyncJournal({ retryDelaysMs: [] })
    journal.closeIngress()

    expect(journal.isAccepting()).toBe(false)
    expect(journal.enqueue({
      roomId: 'room-a',
      kind: 'transition',
      authorityVersion: 1,
      persist: vi.fn(),
    })).toBe(false)
    await expect(journal.drain()).resolves.toBeUndefined()
    expect(journal.inspect('room-a')).toMatchObject({ status: 'durable', pending: 0 })
  })

  it('requires a room to drain before its journal state can be forgotten', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const journal = new BattleAuthorityAsyncJournal({ retryDelaysMs: [] })

    journal.enqueue({
      roomId: 'room-a',
      kind: 'transition',
      authorityVersion: 1,
      persist: () => blocked,
    })
    expect(() => journal.forgetRoom('room-a')).toThrow('cannot forget')
    expect(journal.inspect('room-a')).toMatchObject({
      status: 'pending',
      pending: 1,
    })

    release()
    await journal.drain('room-a')
    journal.forgetRoom('room-a')
    expect(journal.inspect('room-a')).toEqual({
      status: 'durable',
      durableAuthorityVersion: 0,
      pending: 0,
    })
  })
})
