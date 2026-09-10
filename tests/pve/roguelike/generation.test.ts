import { describe, expect, it } from 'vitest'
import { adventureContent } from '@/lib/pve/roguelike/content'
import { generateAdventureContent } from '@/lib/pve/roguelike/generation'
import { recruitmentOffers } from '@/lib/pve/roguelike/recruitment'
import { insideZone } from '@/lib/game/adventure-boundary'
import { RoguelikeAdventureV1Schema, type RoguelikeAdventureV1 } from '@/lib/pve/contracts/roguelike-content-v1'

function reachable(content: RoguelikeAdventureV1, blocked: typeof content.zones) {
  const start = content.startingPositions[`${content.party.humanId}-1`], queue = [start], seen = new Set([`${start.x},${start.y}`])
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const p = { x: queue[i].x + dx, y: queue[i].y + dy }, key = `${p.x},${p.y}`
    if (content.map.layout[p.y]?.[p.x] === '.' && !blocked.some(zone => insideZone(zone, p.x, p.y)) && !seen.has(key)) {
      seen.add(key); queue.push(p)
    }
  }
  return seen
}
describe('landmark map generation', () => {
  it('reproduces the same seed, varies landmarks and terrain across seeds, never mutates the pack', () => {
    const original = JSON.stringify(adventureContent)
    const first = generateAdventureContent(adventureContent, 42)
    expect(generateAdventureContent(adventureContent, 42)).toEqual(first)
    const second = generateAdventureContent(adventureContent, 43)
    expect(second.map.layout).not.toEqual(first.map.layout)
    expect(second.sites).not.toEqual(first.sites)
    expect(second.zones).not.toEqual(first.zones)
    expect(JSON.stringify(adventureContent)).toBe(original)
  })
  it('guarantees safe arrivals, useful nearby facilities and reachable encounters across 128 seeds', () => {
    for (let seed = 0; seed < 128; seed++) {
      const content = generateAdventureContent(adventureContent, seed)
      expect(RoguelikeAdventureV1Schema.safeParse(content).success).toBe(true)
      const outside = reachable(content, content.zones)
      for (const site of content.sites.filter(s => s.kind !== 'encounter')) expect(outside.has(`${site.x},${site.y}`), `seed ${seed}, ${site.id}`).toBe(true)
      const camp = content.sites.find(s => s.kind === 'camp')!
      for (const kind of ['loot','recruit']) expect(content.sites.some(s => s.kind === kind && Math.abs(s.x-camp.x)+Math.abs(s.y-camp.y) <= 7)).toBe(true)
      for (const [i, zone] of content.zones.entries()) {
        const available = reachable(content, content.zones.slice(i + 1))
        for (const enemy of content.enemyLineup.filter(e => e.zone === zone.id)) expect(available.has(`${enemy.x},${enemy.y}`)).toBe(true)
        for (const other of content.zones.slice(i + 1)) expect(zone.x + zone.width <= other.x || other.x + other.width <= zone.x || zone.y + zone.height <= other.y || other.y + other.height <= zone.y).toBe(true)
      }
    }
  })
  it('keeps authored maps for packs without a generator and rejects malformed seeds', () => {
    const legacy = structuredClone(adventureContent); delete legacy.generation
    expect(generateAdventureContent(legacy, 99).map).toEqual(legacy.map)
    for (const seed of [-1, 1.5, NaN, Infinity, 0x100000000]) expect(() => generateAdventureContent(adventureContent, seed)).toThrow('种子')
    expect(() => generateAdventureContent(adventureContent, 0xffffffff)).not.toThrow()
  })
  it('keeps seeded candidate selection separate from map generation and validates recruitment definitions', () => {
    const world = generateAdventureContent(adventureContent, 42)
    expect(recruitmentOffers(world)).toEqual(recruitmentOffers({ ...adventureContent, party: { ...adventureContent.party, seed: 42 } }))
    for (const candidates of Object.values(recruitmentOffers(world))) {
      expect(candidates).toHaveLength(3); expect(new Set(candidates).size).toBe(3)
    }
    expect(RoguelikeAdventureV1Schema.safeParse({ ...world, recruitment: undefined }).success).toBe(false)
    expect(RoguelikeAdventureV1Schema.safeParse({ ...world, recruitment: { ...world.recruitment, candidates: 6 } }).success).toBe(false)
  })
})
