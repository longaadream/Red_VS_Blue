import { createInitialBattleForPlayers } from '../game/battle-setup'
import { getAvailablePieces, getPieceById, isDemoPieceAdmitted } from '../game/piece-repository'
import { validateDemoRosterSelection } from '../game/roster-contract'
import { getSelectableMapCatalog } from '../game/map-selection'
import { mulberry32 } from '../game/rng'
import type { GameProfileIdentityV1 } from '../content-pipeline/runtime/profile-game-identity'

export const HUMAN_ID = 'practice-human'
export const AI_ID = 'practice-ai'
export interface PracticeRoster { alignment: 'good' | 'evil'; pieceIds: string[] }
export interface PracticeSetup {
  human: PracticeRoster
  ai: PracticeRoster
  humanFirst: boolean
  mapId: string
  seed: number
}

export function validateRoster(roster: PracticeRoster) {
  if (!roster || !['good', 'evil'].includes(roster.alignment) || !Array.isArray(roster.pieceIds)) {
    throw new Error('请选择棋组阵营和8个棋子')
  }
  return validateDemoRosterSelection({ alignment: roster.alignment === 'good' ? 'light' : 'dark',
    pieces: roster.pieceIds.map(templateId => ({ templateId })) })
}

export function choosePracticeRoster(alignment: PracticeRoster['alignment'], seed: number, presets: PracticeRoster[] = []): PracticeRoster {
  if (!['good', 'evil'].includes(alignment)) throw new Error('棋组阵营无效')
  const random = mulberry32(seed)
  const valid = presets.filter(roster => {
    try { validateRoster(roster); return roster.alignment === alignment } catch { return false }
  })
  if (valid.length) return { alignment, pieceIds: [...valid[Math.floor(random() * valid.length)].pieceIds] }
  const ids = getAvailablePieces('pvp').filter(piece => piece.faction === alignment && isDemoPieceAdmitted(piece.id)).map(piece => piece.id).sort()
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]
  }
  const roster = { alignment, pieceIds: ids.slice(0, 8) }
  validateRoster(roster)
  return roster
}

export function practiceCatalog() {
  return { pieces: getAvailablePieces('pvp').filter(piece => isDemoPieceAdmitted(piece.id)), maps: getSelectableMapCatalog() }
}

export async function createPracticeState(setup: PracticeSetup, profileIdentity: GameProfileIdentityV1) {
  validateRoster(setup.human); validateRoster(setup.ai)
  if (typeof setup.humanFirst !== 'boolean' || !Number.isSafeInteger(setup.seed) || setup.seed < 0 || setup.seed > 0xffffffff) {
    throw new Error('练习配置无效')
  }
  const roster = (playerId: string, selected: PracticeRoster, faction: 'red' | 'blue') => ({
    playerId, faction, alignment: selected.alignment === 'good' ? 'light' as const : 'dark' as const,
    pieces: selected.pieceIds.map(id => getPieceById(id)!),
  })
  const firstId = setup.humanFirst ? HUMAN_ID : AI_ID
  const players = [roster(HUMAN_ID, setup.human, setup.humanFirst ? 'red' : 'blue'),
    roster(AI_ID, setup.ai, setup.humanFirst ? 'blue' : 'red')]
  const state = await createInitialBattleForPlayers([firstId, setup.humanFirst ? AI_ID : HUMAN_ID], [], players, setup.mapId, {
    firstPlayerId: firstId, rootSeed: setup.seed, profileIdentity,
    deploymentEnabled: true, deploymentMode: 'progressive-reserve-v1', deploymentStartedAt: 0,
  })
  if (!state) throw new Error('无法创建练习战局')
  state.players.forEach(player => { player.name = player.playerId === HUMAN_ID ? '你' : '实验 AI' })
  return state
}
