import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

function loadContextLayout() {
  const window: Record<string, unknown> = {}
  const context = createContext({ window, globalThis: window })
  const source = readFileSync(
    resolve(process.cwd(), 'data/pages/js/battle-ui/battle-context-layout.js'),
    'utf8',
  )
  new Script(source, { filename: 'battle-context-layout.js' }).runInContext(context)
  return window.BattleContextLayout as {
    handArc(index: number, count: number): { angle: number; lift: number; zIndex: number }
    placeMenu(
      anchor: { left: number; top: number },
      menu: { width: number; height: number },
      bounds: { width: number; height: number },
    ): { left: number; top: number; side: string; originX: number; originY: number }
  }
}

describe('battle contextual layout', () => {
  it('fans the existing hand symmetrically without creating a second hand source', () => {
    const layout = loadContextLayout()
    const left = layout.handArc(0, 8)
    const right = layout.handArc(7, 8)
    const inner = layout.handArc(3, 8)
    const single = layout.handArc(0, 1)

    expect(left.angle).toBe(-right.angle)
    expect(left.lift).toBe(right.lift)
    expect(Math.abs(left.angle)).toBeLessThanOrEqual(20)
    expect(left.lift).toBeGreaterThanOrEqual(-10)
    expect(inner.zIndex).toBeGreaterThan(left.zIndex)
    expect(single).toEqual({ angle: 0, lift: 0, zIndex: 1 })
  })

  it('places the piece menu beside its board anchor and clamps it inside the stage', () => {
    const layout = loadContextLayout()
    const fromLeft = layout.placeMenu(
      { left: 28, top: 24 },
      { width: 164, height: 112 },
      { width: 390, height: 300 },
    )
    const fromRight = layout.placeMenu(
      { left: 372, top: 292 },
      { width: 164, height: 112 },
      { width: 390, height: 300 },
    )

    expect(fromLeft.side).toBe('right')
    expect(fromRight.side).toBe('left')
    for (const placed of [fromLeft, fromRight]) {
      expect(placed.left).toBeGreaterThanOrEqual(8)
      expect(placed.top).toBeGreaterThanOrEqual(8)
      expect(placed.left + 164).toBeLessThanOrEqual(382)
      expect(placed.top + 112).toBeLessThanOrEqual(292)
      expect(placed.originX).toBeGreaterThanOrEqual(0)
      expect(placed.originY).toBeGreaterThanOrEqual(0)
    }
  })
})
