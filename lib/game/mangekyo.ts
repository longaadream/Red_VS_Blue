import type { PieceInstance } from './piece'
import type { SkillDefinition } from './skills'
import type { BattleState } from './turn'

export const MANGEKYO_KEYWORD = '万花筒'

export function isMangekyoSkill(skill: Pick<SkillDefinition, 'keywords'> | undefined): boolean {
  return skill?.keywords?.includes(MANGEKYO_KEYWORD) === true
}

export function getMangekyoDeathCount(state: BattleState, playerId: string): number {
  const player = state.players.find(meta =>
    String(meta.playerId).toLowerCase() === String(playerId).toLowerCase())
  const count = player?.mangekyoDeathCount
  return Number.isSafeInteger(count) && count! > 0 ? count! : 0
}

export function getEffectiveChargeCost(
  state: BattleState,
  playerId: string,
  skill: Pick<SkillDefinition, 'chargeCost' | 'keywords'> | undefined,
): number {
  const baseCost = Math.max(0, Number.isFinite(skill?.chargeCost) ? skill!.chargeCost! : 0)
  if (!isMangekyoSkill(skill)) return baseCost
  return Math.max(0, baseCost - getMangekyoDeathCount(state, playerId))
}

export function recordMangekyoDeath(state: BattleState, piece: PieceInstance): number {
  const player = state.players.find(meta =>
    String(meta.playerId).toLowerCase() === String(piece.ownerPlayerId).toLowerCase())
  if (!player) return 0

  const nextCount = getMangekyoDeathCount(state, player.playerId) + 1
  player.mangekyoDeathCount = nextCount
  state.actions ??= []
  state.actions.push({
    type: 'mangekyoDeath',
    playerId: player.playerId,
    turn: state.turn?.turnNumber ?? 0,
    payload: {
      message: `${piece.name || piece.templateId}的死亡令【万花筒】充能消耗降低1`,
      pieceId: piece.instanceId,
      pieceTemplateId: piece.templateId,
      mangekyoDeathCount: nextCount,
    },
  })
  return nextCount
}
