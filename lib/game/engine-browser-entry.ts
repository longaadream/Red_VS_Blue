/**
 * engine-browser-entry.ts
 *
 * RED-64 权威恢复来源：
 * - commit: 17a3036daddefdb9a25cd7c167d4ca081070b786
 * - source blob: e074b671d44b4b4336d988de5264bf895fbb57d0
 * RED-70 仅补充本来源记录；下方入口实现保持与该来源一致。
 *
 * esbuild 打包入口 —— 供 Android 训练营 (training.html) 使用。
 * 编译命令见 package.json build:game-engine 脚本。
 *
 * 依赖说明：
 * - fs / path 标记为 external，由 training.html 的 VirtualFS shim 提供
 * - process.cwd() 由 training.html 注入的 process shim 提供（返回 ''）
 */

export { applyBattleAction, safeCloneBattleState, validateSkillActionByDryRun } from './turn'
export { getBattleRootSeed, hashBattleState, runBattleAction } from './battle-runner'
export {
  getLegalNormalMoveTargets,
  getLegalNormalMoveTargetsForPlayer,
  getLivingOccupantAt,
  getManhattanArea,
  getNormalMoveRejection,
  getOrthogonalLineCells,
  getSquareArea,
  manhattanDistance,
} from './spatial'
export { setRng, mulberry32 } from './rng'
export { toPublicBattleState } from './deployment'
export { stampPendingDeploymentAuthorityVersion } from './battle-trace'
export type { BattleState, BattleAction, BattleActionLog } from './turn'

import { createInitialBattleForPlayers as _createInitialBattleForPlayers } from './battle-setup'
import { loadAllSkillsById, loadRuleById } from './skills'
import type { BattleState, PlayerId } from './turn'
import type { PieceTemplate } from './piece'

/**
 * Browser-safe wrapper for createInitialBattleForPlayers.
 *
 * The original function calls buildDefaultSkills() → loadJsonFilesServer()
 * which has an early-return guard for browser environments (typeof window !== 'undefined').
 * This wrapper patches skillsById after init using loadAllSkillsById() which
 * reads directly via require('fs') → VirtualFS shim, bypassing that guard.
 */
export async function createInitialBattleForPlayers(
  playerIds: PlayerId[],
  selectedPieces: PieceTemplate[],
  playerSelectedPieces?: Array<{ playerId: string; pieces: PieceTemplate[]; faction?: 'red' | 'blue' }>,
  mapId?: string,
  options?: {
    firstPlayerId?: PlayerId
    rootSeed?: number
    deploymentEnabled?: boolean
    deploymentStartedAt?: number
  },
): Promise<BattleState | null> {
  const state = await _createInitialBattleForPlayers(playerIds, selectedPieces, playerSelectedPieces, mapId, options)
  if (!state) return null

  // buildDefaultSkills() returns {} in browser — patch with VFS-loaded skills
  const skills = loadAllSkillsById()
  if (Object.keys(skills).length > 0) {
    state.skillsById = skills
  }

  return state
}

export { DEFAULT_PIECES, getPieceById, getAllPieces, getPiecesByFaction } from './piece-repository'

export { globalTriggerSystem } from './triggers'
export { loadRuleById }
