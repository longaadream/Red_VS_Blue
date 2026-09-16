import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { scheduleAdventureTick } from '../../lib/server/colyseus/adventure-tick-scheduler'

describe('adventure authority scheduling', () => {
  it('coalesces timer ticks while persistence is slow and schedules again after completion', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const state = { scheduled: false }
    const enqueue = vi.fn((operation: () => Promise<void>) => operation())
    const operation = vi.fn(() => gate)
    const onError = vi.fn()

    expect(scheduleAdventureTick(state, enqueue, operation, onError)).toBe(true)
    expect(scheduleAdventureTick(state, enqueue, operation, onError)).toBe(false)
    expect(enqueue).toHaveBeenCalledTimes(1)
    finish()
    await gate
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.scheduled).toBe(false)
    expect(scheduleAdventureTick(state, enqueue, async () => {}, onError)).toBe(true)
  })

  it('releases the coalescing guard after a failed tick', async () => {
    const state = { scheduled: false }
    const onError = vi.fn()
    scheduleAdventureTick(state, operation => operation(), async () => { throw new Error('commit failed') }, onError)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onError).toHaveBeenCalledOnce()
    expect(state.scheduled).toBe(false)
  })

  it('keeps save arrays intact and records timing before snapshot revision de-duplication', () => {
    const server = readFileSync(resolve(process.cwd(), 'lib/server/colyseus/adventure-room.ts'), 'utf8')
    const network = readFileSync(resolve(process.cwd(), 'data/pages/js/adventure/network.js'), 'utf8')
    const controller = readFileSync(resolve(process.cwd(), 'data/pages/js/adventure/battle-controller.js'), 'utf8')
    expect(server).toContain('result,timings:')
    expect(network).toContain('if (Array.isArray(value)')
    expect(controller.indexOf("console.info('[adventure] rpc timing'")).toBeLessThan(controller.indexOf('result.revision <= adventureSnapshot.revision'))
  })
})
