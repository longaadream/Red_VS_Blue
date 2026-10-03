import { describe, expect, it } from 'vitest'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { createAdventureState } from '@/lib/pve/roguelike/session'
import {
  createFixedRoute,
  createFixedRouteBattleContent,
  loadFixedRouteMap,
} from '@/lib/pve/fixed-route/content'

describe('fixed route content', () => {
  it('selects three different ordinary encounters and keeps the seven-node chapter shape', () => {
    const route = createFixedRoute(0x235)
    expect(route.chapters).toHaveLength(3)

    for (const chapter of route.chapters) {
      expect(chapter.nodes.map(node => node.type)).toEqual([
        'battle', 'event', 'battle', 'shop', 'event', 'battle', 'boss',
      ])
      const ordinary = chapter.nodes.filter(node => node.type === 'battle')
      expect(new Set(ordinary.map(node => node.encounterId)).size).toBe(3)
      expect(new Set(ordinary.map(node => chapter.battles[node.encounterId!]!.mapId)).size).toBe(3)
      expect(chapter.nodes.at(-1)?.encounterId).toBe(`fixed-${chapter.id}-boss`)
      expect(chapter.battles[chapter.nodes.at(-1)!.encounterId!]!.boss).toBe(true)
    }
  })

  it('builds schema content from every native map while preserving native cover and hole semantics', async () => {
    const route = createFixedRoute(0x235)
    const maps = new Map<string, Awaited<ReturnType<typeof loadFixedRouteMap>>>()

    for (let chapterIndex = 0; chapterIndex < route.chapters.length; chapterIndex += 1) {
      const chapter = route.chapters[chapterIndex]!
      for (const node of chapter.nodes.filter(item => item.type === 'battle' || item.type === 'boss')) {
        const mapId = chapter.battles[node.encounterId!]!.mapId
        const map = maps.get(mapId) ?? await loadFixedRouteMap(mapId)
        maps.set(mapId, map)
        const content = createFixedRouteBattleContent(route, chapterIndex, node, map)
        const zone = content.zones[0]!

        expect(content.map.layout).not.toContainEqual(expect.stringContaining('T'))
        expect(content.map.layout).toHaveLength(map.height)
        expect(content.map.layout.every(row => row.length === map.width)).toBe(true)
        expect(content.sites).toEqual([])
        expect(zone).toMatchObject({
          x: 0, y: 0, width: map.width, height: map.height,
          reward: 0, optional: false, elite: false,
        })
        expect(zone.enemyIds).toEqual(content.enemyLineup.map(enemy => enemy.id))
        expect(Object.values(content.startingPositions)).toHaveLength(2 + content.enemyLineup.length)
        expect(new Set(Object.values(content.startingPositions).map(position => `${position.x},${position.y}`)).size)
          .toBe(Object.values(content.startingPositions).length)
        expect(content.enemyLineup.every(enemy => enemy.templateId.startsWith('pve-'))).toBe(true)
        if (node.type === 'boss') {
          expect(content.enemyLineup[0]!.tier).toBe('boss')
          expect(content.enemyLineup.slice(1).every(enemy => enemy.tier === 'minion')).toBe(true)
          expect(content.enemyLineup.map(enemy => enemy.core)).toEqual([true, false, false])
        } else {
          expect(content.enemyLineup.every(enemy => enemy.core)).toBe(true)
        }
      }
    }

    const boss = route.chapters[2]!.nodes.at(-1)!
    const map = maps.get('large-hole-arena') ?? await loadFixedRouteMap('large-hole-arena')
    const content = createFixedRouteBattleContent(route, 2, boss, map)
    const profile = getServerGameProfileIdentityV1()
    const state = await createAdventureState(profile, content, map)
    const cover = map.tiles.find(tile => tile.props.type === 'cover')!
    const hole = map.tiles.find(tile => tile.props.type === 'hole')!

    expect(cover).toBeDefined()
    expect(hole).toBeDefined()
    expect(state.map.tiles.find(tile => tile.x === cover.x && tile.y === cover.y)?.props).toMatchObject({
      type: 'cover', walkable: true, bulletPassable: false,
    })
    expect(state.map.tiles.find(tile => tile.x === hole.x && tile.y === hole.y)?.props).toMatchObject({
      type: 'hole', walkable: false, bulletPassable: true,
    })
    expect(content.map.layout[hole.y]![hole.x]).toBe('O')
  }, 30_000)
})
