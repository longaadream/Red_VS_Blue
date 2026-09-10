import type { BattleState } from './turn'

export interface AdventureHandCard {
  cardId: string
  instanceId: string
  ownerPlayerId: string
  actionPointCost: number
  name?: string
  description?: string
  icon?: string
  type?: string
  additionPrepared?: true
  contentState?: { adventure?: { lifetime: 'run' | 'encounter'; sourceId: string } }
}
export interface AdventureCardPlayer {
  relicIds: string[]
  growth: Record<string, number>
  passiveHits: Record<string, number>
  overflow: AdventureHandCard[]
}
export interface AdventureCardState {
  version: 'supply-v1'
  serial: number
  supplyRuntime: { tick: number; cursors: Record<string, number> }
  suppliedEncounters: string[]
  players: Record<string, AdventureCardPlayer>
  reward?: { encounterId: string; relicIds: string[]; cardIds: string[] }
}
export function adventureCards(state: BattleState): AdventureCardState | undefined {
  if (state.extensions?.adventureWorld?.version !== 'same-map-v1') return undefined
  const value = state.extensions?.adventureCards as AdventureCardState | undefined
  return value?.version === 'supply-v1' ? value : undefined
}
export function initializeAdventureCards(state: BattleState, playerId: string, relicIds: string[]): AdventureCardState {
  if (adventureCards(state)) return adventureCards(state)!
  const value: AdventureCardState = { version: 'supply-v1', serial: 0, supplyRuntime: { tick: 0, cursors: {} }, suppliedEncounters: [], players: {
    [playerId]: { relicIds: [...new Set(relicIds)], growth: {}, passiveHits: {}, overflow: [] },
  } }
  state.extensions ??= {}
  state.extensions.adventureCards = value
  return value
}
export function recordAdventurePassiveHit(state: BattleState, playerId: string, targetId: string): void {
  const player = adventureCards(state)?.players[playerId]
  if (player && state.extensions?.adventureWorld?.activeZone) player.passiveHits[targetId] = (player.passiveHits[targetId] ?? 0) + 1
}
export function hasAdventureCardChoice(state: BattleState, playerId: string): boolean {
  const value = adventureCards(state)
  return !!(value?.players[playerId]?.overflow.length || value?.reward)
}
