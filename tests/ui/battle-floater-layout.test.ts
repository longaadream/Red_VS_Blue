import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

type Entry = { x: number; y: number; width: number; height: number }
type Position = { x: number; y: number; crowded: boolean; box: { left: number; right: number; top: number; bottom: number } }
const scope = { window: {} as { BattleFloaterLayout?: { arrange(entries: Entry[], bounds: { width: number; height: number }, obstacles?: Position['box'][]): Position[] } } }
runInNewContext(readFileSync(resolve('data/pages/js/battle-ui/battle-floater-layout.js'), 'utf8'), scope)
const arrange = scope.window.BattleFloaterLayout!.arrange

function expectReadable(positions: Position[], width: number, height: number) {
  positions.forEach((position, index) => {
    expect(position.crowded).toBe(false)
    expect(position.box.left).toBeGreaterThanOrEqual(0)
    expect(position.box.top).toBeGreaterThanOrEqual(0)
    expect(position.box.right).toBeLessThanOrEqual(width)
    expect(position.box.bottom).toBeLessThanOrEqual(height)
    positions.slice(index + 1).forEach(other => {
      const separated = position.box.right <= other.box.left || other.box.right <= position.box.left
        || position.box.bottom <= other.box.top || other.box.bottom <= position.box.top
      expect(separated).toBe(true)
    })
  })
}

describe('shared floating result layout', () => {
  it('keeps newest text at its anchor and pushes older results upward', () => {
    const positions = arrange(Array.from({ length: 3 }, () => ({ x: 600, y: 500, width: 64, height: 40 })), { width: 1280, height: 720 })
    expect(positions[2]).toMatchObject({ x: 600, y: 500 })
    expect(positions[0].y).toBeLessThan(positions[1].y)
    expect(positions[1].y).toBeLessThan(positions[2].y)
    expectReadable(positions, 1280, 720)
  })

  it.each([[8, 8], [838, 8], [8, 385], [838, 385]])('uses nearby space instead of clipping at edge %s,%s', (x, y) => {
    const positions = arrange(Array.from({ length: 4 }, (_, i) => ({ x: x + i * 20, y, width: i === 0 ? 170 : 70, height: 42 })), { width: 844, height: 390 })
    expectReadable(positions, 844, 390)
  })

  it('separates differently sized results from nearby pieces', () => {
    const positions = arrange([
      { x: 350, y: 280, width: 110, height: 42 },
      { x: 385, y: 270, width: 70, height: 40 },
      { x: 420, y: 280, width: 155, height: 48 },
    ], { width: 844, height: 390 })
    expectReadable(positions, 844, 390)
  })

  it('keeps every result and reports crowding when finite screen space is exhausted', () => {
    const entries = Array.from({ length: 30 }, () => ({ x: 70, y: 70, width: 60, height: 35 }))
    const positions = arrange(entries, { width: 180, height: 180 })
    expect(positions).toHaveLength(entries.length)
    expect(positions.some(position => position.crowded)).toBe(true)
    expect(positions.every(position => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true)
  })

  it('keeps result text clear of a nearby visible HUD prompt', () => {
    const obstacle = { left: 270, right: 470, top: 220, bottom: 270 }
    const positions = arrange([{ x: 370, y: 230, width: 70, height: 40 }], { width: 844, height: 390 }, [obstacle])
    expectReadable(positions, 844, 390)
    const box = positions[0].box
    expect(box.right <= obstacle.left || obstacle.right <= box.left || box.bottom <= obstacle.top || obstacle.bottom <= box.top).toBe(true)
  })
})
