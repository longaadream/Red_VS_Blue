import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dbHarness = vi.hoisted(() => ({
  room: {
    upsert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
}))

vi.mock('../relay-server/src/db/client', () => ({ db: { room: dbHarness.room } }))

let store: any

beforeAll(async () => {
  const actual = await vi.importActual<any>('../relay-server/src/store')
  store = actual.store
})

function makeRoom(id: string) {
  return {
    id,
    hostId: 'host',
    name: 'Atomic Relay Room',
    mapId: 'large-hole-arena',
    status: 'waiting' as const,
    players: [{
      id: 'host',
      name: 'Host',
      publicKey: 'host-key',
      faction: 'red' as const,
      alignment: 'light' as const,
      connected: false,
    }],
    inviteCode: 'ATOMIC',
    actionLog: [],
    createdAt: Date.now(),
  }
}

describe('standalone Relay atomic persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbHarness.room.upsert.mockResolvedValue({})
    dbHarness.room.delete.mockResolvedValue({})
  })

  it('publishes a room in memory only after the database upsert resolves', async () => {
    const room = makeRoom('atomic-create')
    let finishUpsert: ((value: object) => void) | undefined
    dbHarness.room.upsert.mockReturnValueOnce(new Promise(resolve => { finishUpsert = resolve }))

    const pending = store.persistRoom(room)
    expect(store.getRoom(room.id)).toBeUndefined()

    finishUpsert?.({})
    await pending
    expect(store.getRoom(room.id)).toEqual(room)
    expect(store.getRoom(room.id)).not.toBe(room)
  })

  it('retains the last persisted snapshot when an update fails', async () => {
    const room = makeRoom('atomic-update')
    await store.persistRoom(room)
    const replacement = { ...structuredClone(room), status: 'selecting' as const }
    dbHarness.room.upsert.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(store.persistRoom(replacement)).rejects.toThrow('database unavailable')
    expect(store.getRoom(room.id)).toEqual(room)
    expect(store.getRoom(room.id)?.status).toBe('waiting')
  })

  it('removes in-memory state only after the database delete resolves', async () => {
    const room = makeRoom('atomic-delete')
    await store.persistRoom(room)
    let finishDelete: ((value: object) => void) | undefined
    dbHarness.room.delete.mockReturnValueOnce(new Promise(resolve => { finishDelete = resolve }))

    const pending = store.deleteRoomPersisted(room.id)
    expect(store.getRoom(room.id)).toEqual(room)

    finishDelete?.({})
    await pending
    expect(store.getRoom(room.id)).toBeUndefined()
  })

  it('runs same-room operations in arrival order while allowing only one to enter', async () => {
    const order: string[] = []
    let markFirstEntered: (() => void) | undefined
    const firstEntered = new Promise<void>(resolve => {
      markFirstEntered = resolve
    })
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    const first = store.withRoomLock('lock-order', async () => {
      order.push('first-enter')
      markFirstEntered?.()
      await firstGate
      order.push('first-exit')
    })
    await firstEntered
    const second = store.withRoomLock('LOCK-ORDER', async () => {
      order.push('second-enter')
      order.push('second-exit')
    })
    await Promise.resolve()

    expect(order).toEqual(['first-enter'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter', 'second-exit'])
  })

  it('releases a same-room lock when an operation throws', async () => {
    const order: string[] = []
    const first = store.withRoomLock('lock-failure', async () => {
      order.push('first-enter')
      throw new Error('operation failed')
    })
    const second = store.withRoomLock('lock-failure', async () => {
      order.push('second-enter')
      return 'released'
    })

    await expect(first).rejects.toThrow('operation failed')
    await expect(second).resolves.toBe('released')
    expect(order).toEqual(['first-enter', 'second-enter'])
  })
})
