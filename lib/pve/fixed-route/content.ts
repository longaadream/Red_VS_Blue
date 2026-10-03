import { getMapById, loadMaps } from '../../game/map-repository'
import type { BoardMap } from '../../game/map'
import { deriveStreamSeed, mulberry32 } from '../../game/rule-runtime'
import { adventureContent } from '../roguelike/content'
import { RoguelikeAdventureV1Schema, type RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'

export type FixedRouteNodeType = 'battle' | 'event' | 'shop' | 'boss'

export interface FixedRouteNode {
  id: string
  type: FixedRouteNodeType
  name: string
  encounterId?: string
}

export interface FixedRouteBattleSpec {
  encounterId: string
  name: string
  mapId: string
  enemyTemplateIds: string[]
  boss: boolean
}

export interface FixedRouteChapter {
  id: string
  name: string
  nodes: FixedRouteNode[]
  battles: Record<string, FixedRouteBattleSpec>
}

export interface FixedRouteDefinition {
  seed: number
  chapters: FixedRouteChapter[]
}

type ChapterTable = {
  id: string
  name: string
  ordinary: Array<{ name: string; mapId: string; enemyTemplateIds: string[] }>
  boss: { name: string; mapId: string; enemyTemplateIds: string[] }
}

const CHAPTER_TABLE: ChapterTable[] = [
  {
    id: 'old-town-border',
    name: '旧城边境',
    ordinary: [
      { name: '旧城 · 开阔哨线', mapId: 'open-expanse', enemyTemplateIds: ['pve-zombie', 'pve-zombie', 'pve-skeleton'] },
      { name: '旧城 · 回风墓道', mapId: 'winding-pass', enemyTemplateIds: ['pve-ghoul', 'pve-zombie', 'pve-zombie'] },
      { name: '旧城 · 狭廊封锁', mapId: 'narrow-corridors', enemyTemplateIds: ['pve-skeleton', 'pve-skeleton', 'pve-zombie'] },
      { name: '旧城 · 洞窟残垣', mapId: 'large-hole-arena', enemyTemplateIds: ['pve-ghoul', 'pve-skeleton', 'pve-zombie'] },
    ],
    boss: { name: '旧城 · 憎恶巢穴', mapId: 'open-expanse', enemyTemplateIds: ['pve-abomination', 'pve-zombie', 'pve-zombie'] },
  },
  {
    id: 'ash-blockade',
    name: '灰烬封锁区',
    ordinary: [
      { name: '灰烬 · 开阔火线', mapId: 'open-expanse', enemyTemplateIds: ['pve-stormtrooper', 'pve-stormtrooper', 'pve-ghoul'] },
      { name: '灰烬 · 狭廊伏兵', mapId: 'narrow-corridors', enemyTemplateIds: ['pve-stormtrooper', 'pve-wither-skeleton', 'pve-zombie'] },
      { name: '灰烬 · 回风裂隙', mapId: 'winding-pass', enemyTemplateIds: ['pve-wither-skeleton', 'pve-ghoul', 'pve-ghoul'] },
      { name: '灰烬 · 洞窟火墙', mapId: 'large-hole-arena', enemyTemplateIds: ['pve-stormtrooper', 'pve-stormtrooper', 'pve-wither-skeleton'] },
    ],
    boss: { name: '灰烬 · 死神封锁线', mapId: 'narrow-corridors', enemyTemplateIds: ['pve-reaper', 'pve-stormtrooper', 'pve-stormtrooper'] },
  },
  {
    id: 'throne-fortress',
    name: '王座要塞',
    ordinary: [
      { name: '王座 · 狭廊前哨', mapId: 'narrow-corridors', enemyTemplateIds: ['pve-abomination', 'pve-skeleton', 'pve-skeleton'] },
      { name: '王座 · 开阔王道', mapId: 'open-expanse', enemyTemplateIds: ['pve-reaper', 'pve-stormtrooper', 'pve-stormtrooper'] },
      { name: '王座 · 回风墓门', mapId: 'winding-pass', enemyTemplateIds: ['pve-wither-skeleton', 'pve-wither-skeleton', 'pve-ghoul'] },
      { name: '王座 · 洞窟侧厅', mapId: 'large-hole-arena', enemyTemplateIds: ['pve-abomination', 'pve-wither-skeleton', 'pve-stormtrooper'] },
    ],
    boss: { name: '王座 · 阿尔萨斯王庭', mapId: 'large-hole-arena', enemyTemplateIds: ['pve-arthas', 'pve-skeleton', 'pve-ghoul'] },
  },
]

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const cellKey = (cell: Cell) => `${cell.x},${cell.y}`
type Cell = { x: number; y: number }

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function nativeSchemaLayout(map: BoardMap): string[] {
  const byPosition = new Map(map.tiles.map(tile => [`${tile.x},${tile.y}`, tile]))
  return Array.from({ length: map.height }, (_, y) => Array.from({ length: map.width }, (_, x) => {
    const tile = byPosition.get(`${x},${y}`)
    if (!tile) throw new Error(`原生地图缺少格子 ${map.id}:${x},${y}`)
    if (tile.props.type === 'wall' || !tile.props.walkable && tile.props.type !== 'hole') return '#'
    if (tile.props.type === 'cover') return 'C'
    if (tile.props.type === 'hole') return 'O'
    return '.'
  }).join(''))
}

function floorComponent(map: BoardMap): Cell[] {
  const floor = new Set(map.tiles
    .filter(tile => tile.props.walkable && tile.props.type === 'floor')
    .map(tile => cellKey(tile)))
  const components: Cell[][] = []
  while (floor.size) {
    const originKey = floor.values().next().value as string
    floor.delete(originKey)
    const [originX, originY] = originKey.split(',').map(Number)
    const component = [{ x: originX, y: originY }]
    for (let index = 0; index < component.length; index += 1) {
      const current = component[index]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = { x: current.x + dx, y: current.y + dy }
        const key = cellKey(next)
        if (!floor.has(key)) continue
        floor.delete(key)
        component.push(next)
      }
    }
    components.push(component)
  }
  const component = components.sort((left, right) => right.length - left.length)[0]
  if (!component || component.length < 5) throw new Error(`原生地图 ${map.id} 没有足够连通的普通地板`)
  return component
}

function distance(left: Cell, right: Cell): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
}

function placeStartingPositions(map: BoardMap, enemyCount: number, seed: number, encounterId: string): Record<string, Cell> {
  const component = floorComponent(map)
  const random = mulberry32(deriveStreamSeed(seed, `fixed-route-positions/${encounterId}`))
  const centerY = (map.height - 1) / 2
  const leftLimit = Math.max(2, Math.floor(map.width * 0.3))
  const left = shuffle(component.filter(cell => cell.x <= leftLimit), random)
    .sort((a, b) => Math.abs(a.y - centerY) - Math.abs(b.y - centerY) || a.x - b.x || a.y - b.y)
  const human: Cell[] = []
  const first = left[0] ?? component.slice().sort((a, b) => a.x - b.x || a.y - b.y)[0]
  if (!first) throw new Error(`原生地图 ${map.id} 没有安全队伍起点`)
  human.push(first)
  const second = left.find(cell => distance(cell, first) >= 2) ?? left.find(cell => cellKey(cell) !== cellKey(first))
    ?? component.find(cell => cellKey(cell) !== cellKey(first))
  if (!second) throw new Error(`原生地图 ${map.id} 没有足够队伍起点`)
  human.push(second)

  const occupied = new Set(human.map(cellKey))
  const rightLimit = Math.floor(map.width * 0.55)
  const right = shuffle(component.filter(cell => cell.x >= rightLimit && !occupied.has(cellKey(cell))), random)
    .sort((a, b) => b.x - a.x || Math.abs(a.y - centerY) - Math.abs(b.y - centerY) || a.y - b.y)
  const enemies: Cell[] = []
  for (const separation of [3, 2, 1, 0]) {
    for (const cell of right) {
      if (enemies.length >= enemyCount) break
      if (occupied.has(cellKey(cell))) continue
      if (human.some(ally => distance(ally, cell) < 4)) continue
      if (enemies.some(enemy => distance(enemy, cell) < separation)) continue
      enemies.push(cell)
      occupied.add(cellKey(cell))
    }
    if (enemies.length >= enemyCount) break
  }
  if (enemies.length < enemyCount) {
    for (const cell of component) {
      if (enemies.length >= enemyCount) break
      if (occupied.has(cellKey(cell))) continue
      enemies.push(cell)
      occupied.add(cellKey(cell))
    }
  }
  if (enemies.length < enemyCount) throw new Error(`原生地图 ${map.id} 没有足够敌方起点`)

  const positions: Record<string, Cell> = {}
  const humanId = adventureContent.party.humanId
  const enemyId = adventureContent.party.enemyId
  human.forEach((cell, index) => { positions[`${humanId}-${index + 1}`] = cell })
  enemies.forEach((cell, index) => { positions[`${enemyId}-${index + 1}`] = cell })
  return positions
}

function buildBattleSpec(chapterId: string, index: number, source: { name: string; mapId: string; enemyTemplateIds: string[] }, boss: boolean): FixedRouteBattleSpec {
  return { encounterId: `fixed-${chapterId}-${boss ? 'boss' : `battle-${index + 1}`}`, ...copy(source), boss }
}

function makeNodes(chapter: ChapterTable, ordinary: FixedRouteBattleSpec[], boss: FixedRouteBattleSpec): FixedRouteNode[] {
  const battleNode = (spec: FixedRouteBattleSpec, type: 'battle' | 'boss', index: number): FixedRouteNode => ({
    id: `${chapter.id}-${type}-${index + 1}`,
    type,
    name: spec.name,
    encounterId: spec.encounterId,
  })
  return [
    battleNode(ordinary[0]!, 'battle', 0),
    { id: `${chapter.id}-event-1`, type: 'event', name: '路上的抉择' },
    battleNode(ordinary[1]!, 'battle', 1),
    { id: `${chapter.id}-shop-1`, type: 'shop', name: '流动补给商' },
    { id: `${chapter.id}-event-2`, type: 'event', name: '战地手记' },
    battleNode(ordinary[2]!, 'battle', 2),
    battleNode(boss, 'boss', 0),
  ]
}

/** Build the route once from the root seed; callers retain the returned value. */
export function createFixedRoute(seed: number): FixedRouteDefinition {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('固定路线种子须为 0～4294967295 的整数')
  const random = mulberry32(deriveStreamSeed(seed, 'fixed-route-v1'))
  const chapters = CHAPTER_TABLE.map(chapter => {
    const choices = chapter.ordinary.map((_, index) => index)
    for (let index = choices.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1))
      ;[choices[index], choices[other]] = [choices[other], choices[index]]
    }
    const ordinary = choices.slice(0, 3).map((choice, index) => buildBattleSpec(chapter.id, index, chapter.ordinary[choice]!, false))
    const boss = buildBattleSpec(chapter.id, 0, chapter.boss, true)
    return { id: chapter.id, name: chapter.name, nodes: makeNodes(chapter, ordinary, boss), battles: Object.fromEntries([...ordinary, boss].map(spec => [spec.encounterId, spec])) }
  })
  return { seed, chapters }
}

/**
 * Construct the parsed native adventure document used by one route battle.
 * The returned schema layout deliberately treats native hole/T cells as O;
 * the original BoardMap is passed separately to createAdventureState so its
 * cover walkability and bullet blocking remain authoritative.
 */
export function createFixedRouteBattleContent(route: FixedRouteDefinition, chapterIndex: number, node: FixedRouteNode, map: BoardMap): RoguelikeAdventureV1 {
  if (!node.encounterId) throw new Error('固定路线节点缺少战斗 ID')
  const spec = route.chapters[chapterIndex]?.battles[node.encounterId]
  if (!spec) throw new Error(`固定路线战斗不存在: ${node.encounterId}`)
  const positions = placeStartingPositions(map, spec.enemyTemplateIds.length, route.seed, spec.encounterId)
  const enemyId = adventureContent.party.enemyId
  const enemyLineup = spec.enemyTemplateIds.map((templateId, index) => {
    const id = `${enemyId}-${index + 1}`
    const position = positions[id]!
    return { id, templateId, zone: spec.encounterId, tier: spec.boss && index === 0 ? 'boss' as const : 'minion' as const,
      role: templateId.replace(/^pve-/, ''), ip: 'PVE', core: spec.boss ? index === 0 : true, x: position.x, y: position.y }
  })
  const width = map.width
  const height = map.height
  const content = {
    schemaVersion: 'rvb-pve-roguelike-adventure/v1' as const,
    id: `fixed-route-${spec.encounterId}`,
    version: adventureContent.version,
    name: spec.name,
    map: { id: map.id, name: map.name, layout: nativeSchemaLayout(map) },
    party: { ...copy(adventureContent.party), seed: route.seed },
    zones: [{ id: spec.encounterId, name: spec.name, x: 0, y: 0, width, height,
      enemyIds: enemyLineup.map(enemy => enemy.id), coreIds: enemyLineup.filter(enemy => enemy.core).map(enemy => enemy.id), reward: 0, optional: false, elite: false }],
    sites: [],
    startingPositions: positions,
    enemyLineup,
    resources: copy(adventureContent.resources),
  }
  return RoguelikeAdventureV1Schema.parse(content)
}

export async function loadFixedRouteMap(mapId: string): Promise<BoardMap> {
  await loadMaps()
  const map = getMapById(mapId)
  if (!map) throw new Error(`固定路线地图不存在: ${mapId}`)
  return copy(map)
}
