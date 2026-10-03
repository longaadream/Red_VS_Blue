import { describe, expect, it } from 'vitest'
import { createFixedRoute } from '@/lib/pve/fixed-route/content'

describe('fixed route generation', () => {
  it('is a pure function of the root seed and exposes stable node identities', () => {
    const first = createFixedRoute(123)
    const second = createFixedRoute(123)
    expect(second).toEqual(first)

    for (const chapter of first.chapters) {
      expect(chapter.nodes).toHaveLength(7)
      expect(new Set(chapter.nodes.map(node => node.id)).size).toBe(7)
      expect(chapter.nodes.slice(0, 6).filter(node => node.type === 'battle')).toHaveLength(3)
      expect(chapter.nodes[6]).toMatchObject({ type: 'boss', encounterId: `fixed-${chapter.id}-boss` })
      expect(chapter.nodes.slice(0, 6).every(node => node.type === 'event' || node.type === 'shop' || node.encounterId))
        .toBe(true)
    }
  })

  it('does not reuse an ordinary encounter within a chapter and always ends with its boss', () => {
    for (const seed of [0, 1, 2, 0x235, 0xffffffff]) {
      const route = createFixedRoute(seed)
      expect(route.seed).toBe(seed)
      for (const chapter of route.chapters) {
        const ordinary = chapter.nodes.filter(node => node.type === 'battle')
        expect(new Set(ordinary.map(node => chapter.battles[node.encounterId!]!.mapId)).size).toBe(3)
        const boss = chapter.nodes[chapter.nodes.length - 1]!
        expect(chapter.battles[boss.encounterId!]!.boss).toBe(true)
        expect(new Set(chapter.nodes.filter(node => node.encounterId).map(node => node.encounterId)).size)
          .toBe(4)
      }
    }
  })
})
