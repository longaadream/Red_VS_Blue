import type { BattleState } from './turn'

export const CHARGE_CRYSTAL_TILE_TYPE = 'charge-crystal' as const

export interface ChargeCrystalTileEffect {
  id: string
  sourceId: string
  tileType: typeof CHARGE_CRYSTAL_TILE_TYPE
  x: number
  y: number
  visible: true
}

function tileEffects(state: BattleState): unknown[] {
  state.extensions ??= {}
  if (!Array.isArray(state.extensions.tileEffects)) state.extensions.tileEffects = []
  return state.extensions.tileEffects
}

export function isChargeCrystal(value: unknown): value is ChargeCrystalTileEffect {
  if (!value || typeof value !== 'object') return false
  const effect = value as Record<string, unknown>
  return effect.tileType === CHARGE_CRYSTAL_TILE_TYPE
    && typeof effect.id === 'string'
    && Number.isSafeInteger(effect.x)
    && Number.isSafeInteger(effect.y)
}

export function dropChargeCrystal(
  state: BattleState,
  input: { id: string; sourcePieceId: string; x: number; y: number },
): ChargeCrystalTileEffect {
  if (!input.id || !input.sourcePieceId || !Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)) {
    throw new Error('Charge crystal requires stable identity, source piece, and board coordinates')
  }
  const effects = tileEffects(state)
  if (effects.some(effect => isChargeCrystal(effect) && effect.id === input.id)) {
    throw new Error(`Duplicate charge crystal ID: ${input.id}`)
  }
  const crystal: ChargeCrystalTileEffect = {
    id: input.id,
    sourceId: input.sourcePieceId,
    tileType: CHARGE_CRYSTAL_TILE_TYPE,
    x: input.x,
    y: input.y,
    visible: true,
  }
  effects.push(crystal)
  return crystal
}

export function collectChargeCrystalsAt(
  state: BattleState,
  x: number,
  y: number,
): ChargeCrystalTileEffect[] {
  const effects = Array.isArray(state.extensions?.tileEffects)
    ? state.extensions.tileEffects as unknown[]
    : []
  const collected = effects.filter(effect => (
    isChargeCrystal(effect) && effect.x === x && effect.y === y
  )) as ChargeCrystalTileEffect[]
  if (collected.length === 0) return []
  const ids = new Set(collected.map(crystal => crystal.id))
  state.extensions!.tileEffects = effects.filter(effect => !(
    isChargeCrystal(effect) && ids.has(effect.id)
  ))
  return collected
}
