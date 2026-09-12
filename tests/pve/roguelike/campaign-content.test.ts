import { describe, expect, it } from 'vitest'
import { adventureContent } from '@/lib/pve/roguelike/content'
import { campaignAct } from '@/lib/pve/roguelike/campaign'
import { insideZone } from '@/lib/game/adventure-boundary'

describe('three-act adventure content', () => {
  it('provides five large encounters, a final boss and an exit in every act', () => {
    expect(adventureContent.nextActs).toHaveLength(2)
    for (const act of [adventureContent, ...adventureContent.nextActs!]) {
      expect(act.map.layout).toHaveLength(64)
      expect(act.map.layout.every(row => row.length === 64)).toBe(true)
      expect(act.zones).toHaveLength(5)
      for (const zone of act.zones) {
        expect(zone.width * zone.height).toBeGreaterThanOrEqual(256)
        expect(zone.enemyIds.length).toBeGreaterThanOrEqual(4)
        expect(act.sites.some(site => site.id === zone.id && site.kind === 'encounter')).toBe(true)
      }
      const boss = act.enemyLineup.find(enemy => act.zones[4].coreIds.includes(enemy.id))!
      expect(boss.tier).toBe('boss')
      expect(act.sites.filter(site => site.kind === 'exit')).toHaveLength(1)
    }
  })

  it('keeps wandering enemies safely outside encounters and connects their floors across seeds', () => {
    for (let actIndex = 0; actIndex < 3; actIndex++) for (let seed = 0; seed < 32; seed++) {
      const act = campaignAct(adventureContent, actIndex, seed)
      const start = act.startingPositions[`${act.party.humanId}-1`]
      const queue = [start], seen = new Set([`${start.x},${start.y}`])
      for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const p = { x: queue[i].x + dx, y: queue[i].y + dy }, key = `${p.x},${p.y}`
        if (act.map.layout[p.y]?.[p.x] === '.' && !act.zones.some(zone => insideZone(zone,p.x,p.y)) && !seen.has(key)) {
          seen.add(key); queue.push(p)
        }
      }
      for (const enemy of act.enemyLineup.filter(enemy => act.roaming?.enemyIds.includes(enemy.id))) {
        expect(enemy.core).toBe(false)
        expect(seen.has(`${enemy.x},${enemy.y}`), `act ${actIndex}, seed ${seed}, ${enemy.id}`).toBe(true)
        for (const site of [...act.sites, start]) expect(Math.abs(site.x-enemy.x)+Math.abs(site.y-enemy.y)).toBeGreaterThanOrEqual(6)
      }
    }
  }, 30000)
})
