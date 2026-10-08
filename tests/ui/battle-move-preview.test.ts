import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('debounced route effect preview', () => {
  afterEach(() => vi.useRealTimers())
  it('executes only the latest exact path and never publishes after cancellation', () => {
    vi.useFakeTimers()
    const root = { BattleMovePreview: undefined as unknown as { create(options: unknown): { request(...args: unknown[]): void; clear(): void } } }
    runInNewContext(readFileSync('data/pages/js/battle-ui/battle-move-preview.js', 'utf8'), { window: root, setTimeout, clearTimeout })
    const previewBattleAction = vi.fn(() => ({ status: 'ready' }))
    const coordinator = root.BattleMovePreview.create({ engine: { previewBattleAction } })
    const snapshot = {}
    const accept = vi.fn()
    const first = { type: 'move', path: [{ x: 1, y: 0 }] }
    const second = { type: 'move', path: [{ x: 1, y: 0 }, { x: 1, y: 1 }] }
    coordinator.request(snapshot, first, 'me', accept)
    vi.advanceTimersByTime(50)
    coordinator.request(snapshot, second, 'me', accept)
    vi.advanceTimersByTime(90)
    expect(previewBattleAction).toHaveBeenCalledExactlyOnceWith(snapshot, second, 'me')
    expect(accept).toHaveBeenCalledTimes(1)
    coordinator.request(snapshot, second, 'me', accept)
    vi.advanceTimersByTime(90)
    expect(previewBattleAction).toHaveBeenCalledTimes(1)
    coordinator.request(snapshot, first, 'me', accept)
    coordinator.clear()
    vi.advanceTimersByTime(90)
    expect(previewBattleAction).toHaveBeenCalledTimes(1)
  })
})
