import { readFileSync } from 'fs'
import { join } from 'path'
import { getDataRoot } from '../../app-paths'
import { createMapFromAscii } from '../../game/map'
import { RoguelikeAdventureV1Schema, RoguelikeSuppliesV1Schema, RoguelikeBuildsV1Schema, resolveRoguelikeMaps } from '../contracts/roguelike-content-v1'

// Read the current Profile (the worker's primed VFS in browser), never a compiled JSON import.
export function loadAdventureContent(read = (relative: string) => JSON.parse(readFileSync(join(getDataRoot(), relative), 'utf8'))) {
  return RoguelikeAdventureV1Schema.parse(resolveRoguelikeMaps(read('pve/roguelike/adventure.json'),path=>read(path.replace(/^data\//,''))))
}
export const adventureContent = loadAdventureContent()
export const adventureBuilds = RoguelikeBuildsV1Schema.parse(JSON.parse(readFileSync(join(getDataRoot(), adventureContent.resources.buildsPath.replace(/^data\//, '')), 'utf8')))
export const adventureSupplies = adventureContent.resources.suppliesPath
  ? RoguelikeSuppliesV1Schema.parse(JSON.parse(readFileSync(join(getDataRoot(), adventureContent.resources.suppliesPath.replace(/^data\//, '')), 'utf8')))
  : undefined
export const HUMAN = adventureContent.party.humanId
export const ENEMY = adventureContent.party.enemyId
export const SEED = adventureContent.party.seed
export const zones = adventureContent.zones
export const sites = adventureContent.sites
export const startingPositions = adventureContent.startingPositions
export function createAdventureMap(content = adventureContent) {
  return createMapFromAscii({ ...content.map, legend: [
    { char: '.', type: 'floor', walkable: true, bulletPassable: true },
    { char: '#', type: 'wall', walkable: false, bulletPassable: false },
    { char: 'C', type: 'cover', walkable: false, bulletPassable: true },
    { char: 'O', type: 'hole', walkable: false, bulletPassable: true },
  ] })
}
