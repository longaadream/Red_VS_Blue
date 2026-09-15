import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AdventureSession as ProductionSession, createAdventureState as createProductionState } from '@/lib/pve/roguelike/session'
import { createAdventureMap as createProductionMap } from '@/lib/pve/roguelike/content'
import { RoguelikeAdventureV1Schema } from '@/lib/pve/contracts/roguelike-content-v1'
import type { GameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import type { BattleState } from '@/lib/game/turn'

// Preserve the committed two-encounter layout for coordinate-specific mechanics regressions.
// Production campaign/generation/content tests intentionally import the live content instead.
export const adventureContent = RoguelikeAdventureV1Schema.parse(JSON.parse(readFileSync(resolve(process.cwd(), 'tests/pve/roguelike/fixtures/legacy-adventure.json'), 'utf8')))
export const { zones, sites, startingPositions } = adventureContent
export { HUMAN, ENEMY, SEED, adventureSupplies } from '@/lib/pve/roguelike/content'
export const createAdventureMap = (content = adventureContent) => createProductionMap(content)
export const createAdventureState = (profile: GameProfileIdentityV1, content = adventureContent) => createProductionState(profile, content)
export class AdventureSession extends ProductionSession {
  constructor(state: BattleState, content = adventureContent, profile?: GameProfileIdentityV1) { super(state, content, profile) }
}
