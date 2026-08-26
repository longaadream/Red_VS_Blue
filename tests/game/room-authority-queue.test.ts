import { describe, expect, it } from 'vitest'

import {
  RoomAuthorityQueue,
  RoomAuthorityQueueError,
} from '@/lib/game/room-authority-queue'

describe('RED-109 per-room authority queue', () => {
  it('runs one room strictly FIFO while allowing different rooms to overlap', async () => {
    const queue = new RoomAuthorityQueue({ maxPendingPerRoom: 8 })
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })

    const first = queue.enqueue('room-a', { kind: 'player', actionId: 'a-1' }, async () => {
      events.push('a-1:start')
      await firstGate
      events.push('a-1:end')
      return 1
    })
    const second = queue.enqueue('room-a', { kind: 'timer', actionId: 'a-2' }, async () => {
      events.push('a-2:start')
      events.push('a-2:end')
      return 2
    })
    const otherRoom = queue.enqueue('room-b', { kind: 'player', actionId: 'b-1' }, async () => {
      events.push('b-1:start')
      events.push('b-1:end')
      return 3
    })

    await otherRoom
    expect(events).toEqual(['a-1:start', 'b-1:start', 'b-1:end'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(events).toEqual([
      'a-1:start', 'b-1:start', 'b-1:end',
      'a-1:end', 'a-2:start', 'a-2:end',
    ])
  })

  it('continues after a rejected event and exposes bounded backpressure', async () => {
    const queue = new RoomAuthorityQueue({ maxPendingPerRoom: 1 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const running = queue.enqueue('room-a', { kind: 'player', actionId: 'first' }, () => gate)
    const queued = queue.enqueue('room-a', { kind: 'timer', actionId: 'second' }, async () => {
      throw new Error('expected failure')
    })
    await expect(queue.enqueue('room-a', { kind: 'player', actionId: 'third' }, async () => 3))
      .rejects.toMatchObject({ code: 'ROOM_AUTHORITY_BACKPRESSURE' })

    release()
    await running
    await expect(queued).rejects.toThrow('expected failure')
    await expect(queue.enqueue('room-a', { kind: 'player', actionId: 'fourth' }, async () => 4))
      .resolves.toBe(4)
  })

  it('rejects events after an explicit room close with diagnostic context', async () => {
    const queue = new RoomAuthorityQueue()
    queue.closeRoom('room-a', 'terminal')

    await expect(queue.enqueue('room-a', { kind: 'disconnect', actionId: 'late' }, async () => 1))
      .rejects.toEqual(expect.objectContaining<Partial<RoomAuthorityQueueError>>({
        code: 'ROOM_AUTHORITY_QUEUE_CLOSED',
        context: expect.objectContaining({ roomId: 'room-a', reason: 'terminal', actionId: 'late' }),
      }))
  })
})
