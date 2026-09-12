import { generateTerrain } from './terrain'
import { deriveStreamSeed, mulberry32 } from '../../game/rule-runtime'
import { insideZone } from '../../game/adventure-boundary'
import { RoguelikeAdventureV1Schema, type RoguelikeAdventureV1 } from '../contracts/roguelike-content-v1'

type Cell = { x: number; y: number }
type Area = Cell & { width: number; height: number }
const key = (p: Cell) => `${p.x},${p.y}`
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const overlaps = (a: Area, b: Area, gap = 1) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
  && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y

/** One recorded seed; separate streams keep scenery changes from rerolling recruitment. */
export function generateAdventureContent(source: RoguelikeAdventureV1, seed: number): RoguelikeAdventureV1 {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('地图种子须为 0～4294967295 的整数')
  const authored = RoguelikeAdventureV1Schema.parse(source)
  if (!authored.generation) { authored.party.seed = seed; return authored }
  const random = mulberry32(deriveStreamSeed(seed, 'adventure-map-v1'))
  // Bounded attempts support crowded community layouts without hanging or silently loading a fixed map.
  for (let attempt = 0; attempt < 32; attempt++) {
    const generated = placeLandmarks(authored, seed, random)
    if (generated) return RoguelikeAdventureV1Schema.parse(generated)
  }
  throw new Error(`地图生成失败（种子 ${seed}）：请为地标与道路预留更多空间`)
}

function placeLandmarks(source: RoguelikeAdventureV1, seed: number, random: () => number): RoguelikeAdventureV1 | undefined {
  const result = copy(source), settings = source.generation!, width = source.map.layout[0].length, height = source.map.layout.length
  result.party.seed = seed
  const interior = (p: Cell) => p.x > 0 && p.y > 0 && p.x < width - 1 && p.y < height - 1
  const pick = <T>(items: T[]) => items.length ? items[Math.floor(random() * items.length)] : undefined
  const nearby = (point: Cell, valid: (p: Cell) => boolean): Cell[] => {
    const cells: Cell[] = []
    for (let y = point.y - settings.placementShift; y <= point.y + settings.placementShift; y++)
      for (let x = point.x - settings.placementShift; x <= point.x + settings.placementShift; x++) if (valid({ x, y })) cells.push({ x, y })
    return cells
  }
  const camp = result.sites.find(site => site.kind === 'camp')!, oldCamp = { ...camp }
  const partyIds = source.party.pieceIds.map((_, i) => `${source.party.humanId}-${i + 1}`)
  const partyPositions = partyIds.map(id => source.startingPositions[id])
  const landing = pick(nearby(camp, p => interior(p) && partyPositions.every(start => interior({ x: start.x + p.x - camp.x, y: start.y + p.y - camp.y }))))
  if (!landing) return
  Object.assign(camp, landing)
  for (const id of partyIds) {
    result.startingPositions[id].x += camp.x - oldCamp.x
    result.startingPositions[id].y += camp.y - oldCamp.y
  }
  const safeCamp = [camp, ...partyIds.map(id => result.startingPositions[id])]
  const placed: Area[] = []
  for (const [index, zone] of result.zones.entries()) {
    const old = source.zones[index]
    const origin = pick(nearby(old, p => {
      const area = { ...zone, ...p }
      return interior(p) && interior({ x: p.x + zone.width - 1, y: p.y + zone.height - 1 })
        && !placed.some(other => overlaps(area, other))
        && safeCamp.every(cell => !overlaps(area, { ...cell, width: 1, height: 1 }, 2))
    }))
    if (!origin) return
    Object.assign(zone, origin); placed.push(zone)
    for (const enemy of result.enemyLineup.filter(piece => piece.zone === zone.id)) {
      enemy.x += zone.x - old.x; enemy.y += zone.y - old.y
      result.startingPositions[enemy.id] = { x: enemy.x, y: enemy.y }
    }
    const marker = result.sites.find(site => site.kind === 'encounter' && site.id === zone.id)
    if (!marker) return
    marker.x += zone.x - old.x; marker.y += zone.y - old.y
  }
  const outside = (p: Cell) => interior(p) && !result.zones.some(zone => insideZone(zone, p.x, p.y))
  const used = new Set([...Object.values(result.startingPositions), camp, ...result.sites.filter(s => s.kind === 'encounter')].map(key))
  for (const site of result.sites.filter(s => s.kind !== 'camp' && s.kind !== 'encounter')) {
    // The first supply and recruitment facility stay close to the landing camp.
    const nearCamp = Math.abs(site.x - oldCamp.x) + Math.abs(site.y - oldCamp.y) <= 7
    const desired = nearCamp ? { x: site.x + camp.x - oldCamp.x, y: site.y + camp.y - oldCamp.y } : site
    const cell = pick(nearby(desired, p => outside(p) && !used.has(key(p))
      && (!nearCamp || Math.abs(p.x - camp.x) + Math.abs(p.y - camp.y) <= 7)))
    if (!cell) return
    Object.assign(site, cell); used.add(key(cell))
  }
  const roaming = result.enemyLineup.filter(enemy => result.roaming?.enemyIds.includes(enemy.id))
  for (const enemy of roaming) {
    used.delete(key(enemy))
    const cell = pick(nearby(enemy, p => outside(p) && !used.has(key(p))
      && [...result.sites, ...safeCamp].every(site => Math.abs(site.x - p.x) + Math.abs(site.y - p.y) >= 6)))
    if (!cell) return
    Object.assign(enemy, cell)
    result.startingPositions[enemy.id] = { ...cell }; used.add(key(cell))
  }

  const grid: string[][] = settings.algorithm === 'terrain-regions-v1' ? generateTerrain(width,height,seed,source.terrainProfile??'streets') : Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => interior({ x, y }) ? '.' : '#'))
  if(settings.algorithm === 'landmark-routes-v1') {
  // Encounter rooms retain authored cover/walls relative to their own formations.
  for (const [i, zone] of result.zones.entries()) for (let dy = 0; dy < zone.height; dy++) for (let dx = 0; dx < zone.width; dx++) {
    grid[zone.y + dy][zone.x + dx] = source.map.layout[source.zones[i].y + dy][source.zones[i].x + dx]
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (!outside({ x, y }) || random() >= settings.sceneryDensity / 2) continue
    const terrain = pick(['#', '#', 'C', 'O'])!
    const horizontal = random() < .5, length = 1 + Math.floor(random() * 3)
    for (let n = 0; n < length; n++) {
      const cell = { x: x + (horizontal ? n : 0), y: y + (horizontal ? 0 : n) }
      if (outside(cell)) grid[cell.y][cell.x] = terrain
    }
  }
  }
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (random() < .5) directions.reverse()
  const connect = (from: Cell, to: Cell, permitted: (p: Cell) => boolean): boolean => {
    const parents = new Map<string, Cell | null>([[key(from), null]]), queue = [from]
    for (let i = 0; i < queue.length && !parents.has(key(to)); i++) for (const [dx, dy] of directions) {
      const next = { x: queue[i].x + dx, y: queue[i].y + dy }
      if (permitted(next) && !parents.has(key(next))) { parents.set(key(next), queue[i]); queue.push(next) }
    }
    if (!parents.has(key(to))) return false
    for (let cell: Cell | null = to; cell; cell = parents.get(key(cell)) ?? null) {
      grid[cell.y][cell.x] = '.'
      // A two-cell shoulder prevents one pawn from blocking the entire travel corridor.
      const shoulder = { x: cell.x + 1, y: cell.y }
      if (permitted(shoulder)) grid[shoulder.y][shoulder.x] = '.'
    }
    return true
  }
  for (const site of result.sites) {
    const zone = site.kind === 'encounter' ? result.zones.find(z => z.id === site.id) : undefined
    if (!connect(camp, site, p => outside(p) || !!zone && insideZone(zone, p.x, p.y))) return
    if (zone) for (const enemy of result.enemyLineup.filter(e => e.zone === zone.id))
      if (!connect(site, enemy, p => insideZone(zone, p.x, p.y))) return
  }
  for (const id of partyIds) if (!connect(camp, result.startingPositions[id], outside)) return
  for (const enemy of roaming) if (!connect(camp, enemy, outside)) return
  // Keep each facility usable from an adjacent floor as well as from its own cell.
  for (const site of result.sites.filter(s => s.kind !== 'encounter')) for (const [dx, dy] of directions) {
    const cell = { x: site.x + dx, y: site.y + dy }; if (outside(cell)) grid[cell.y][cell.x] = '.'
  }
  if(settings.algorithm === 'terrain-regions-v1') {
    // Isolated courtyard pockets must not become legal multiplayer arrival cells.
    const closePockets=(origin:Cell,permitted:(p:Cell)=>boolean)=>{
      const queue=[origin],seen=new Set([key(origin)])
      for(let i=0;i<queue.length;i++)for(const [dx,dy] of directions){
        const next={x:queue[i].x+dx,y:queue[i].y+dy}
        if(permitted(next)&&grid[next.y][next.x]==='.'&&!seen.has(key(next))){seen.add(key(next));queue.push(next)}
      }
      for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++)
        if(permitted({x,y})&&grid[y][x]==='.'&&!seen.has(key({x,y})))grid[y][x]='C'
    }
    closePockets(camp,outside)
    for(const zone of result.zones)closePockets(result.sites.find(site=>site.id===zone.id)!,p=>insideZone(zone,p.x,p.y))
  }
  if (settings.mirror && random() < .5) {
    grid.forEach(row => row.reverse())
    for (const p of [...result.sites, ...result.enemyLineup, ...Object.values(result.startingPositions)]) p.x = width - 1 - p.x
    for (const zone of result.zones) zone.x = width - zone.x - zone.width
  }
  result.map.layout = grid.map(row => row.join(''))
  return result
}
