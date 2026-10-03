import type { PieceInstance } from './piece'
import type { BattleState } from './turn'
import type { DeathParasitismDefinition, SkillDefinition } from './skills'
import {
  changeDyingPiecePosition,
  getLegalDyingTeleportCells,
} from './position-change'
import {
  getActiveSuspendableActionRuntime,
  type SuspendableInteractionInput,
} from './suspendable-action-transaction'

export interface DeathParasitismDependencies {
  addSkill: (battle: BattleState, target: PieceInstance, skillId: string) => boolean
  addRule: (battle: BattleState, target: PieceInstance, ruleId: string) => boolean
}

export interface DeathParasitismResult {
  applied: boolean
  hostId?: string
  destination?: { x: number; y: number }
}

interface DeathParasitismCandidate {
  piece: PieceInstance
  definition: SkillDefinition
  declaration: DeathParasitismDefinition
}

function stablePieceOrder(left: PieceInstance, right: PieceInstance): number {
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0
}

function stableCellOrder(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return left.y - right.y || left.x - right.x
}

function selectedPieceId(input: SuspendableInteractionInput | undefined): string | undefined {
  if (!input || input.cancelled) return undefined
  if (typeof input.targetPieceId === 'string') return input.targetPieceId
  const selected = input.selectedTargets?.[0]
  return selected && typeof selected === 'object' && (selected as { type?: unknown }).type === 'piece'
    && typeof (selected as { pieceId?: unknown }).pieceId === 'string'
    ? (selected as { pieceId: string }).pieceId
    : undefined
}

function selectedCell(input: SuspendableInteractionInput | undefined): { x: number; y: number } | undefined {
  if (!input || input.cancelled) return undefined
  if (Number.isSafeInteger(input.targetX) && Number.isSafeInteger(input.targetY)) {
    return { x: input.targetX!, y: input.targetY! }
  }
  const selected = input.selectedTargets?.[0]
  if (selected && typeof selected === 'object' && (selected as { type?: unknown }).type === 'cell'
    && Number.isSafeInteger((selected as { x?: unknown }).x)
    && Number.isSafeInteger((selected as { y?: unknown }).y)) {
    return { x: (selected as { x: number }).x, y: (selected as { y: number }).y }
  }
  return undefined
}

function consumeInteraction(
  kind: 'host' | 'cell',
  candidate: DeathParasitismCandidate,
  playerId: string,
  prompt: {
    targetType: 'piece' | 'cell'
    candidates: unknown[]
    title: string
  },
): SuspendableInteractionInput | undefined {
  const runtime = getActiveSuspendableActionRuntime()
  if (!runtime) return undefined
  const key = runtime.enterConsumer({
    consumerKind: 'skill',
    consumerId: candidate.definition.id,
    sourceId: candidate.piece.instanceId,
    eventType: `deathParasitism:${kind}`,
  })
  const input = runtime.takeAnswer(key)
  if (input) return input
  runtime.suspend(key, {
    kind: 'target',
    playerId,
    title: prompt.title,
    targetType: prompt.targetType,
    candidates: prompt.candidates,
    canCancel: true,
    resumeOnCancel: true,
    suspendedTurn: undefined,
    sourcePieceId: candidate.piece.instanceId,
  })
}

function livingHostCandidates(
  battle: BattleState,
  candidate: PieceInstance,
  deathCandidateIds: ReadonlySet<string>,
  squareRadius: number,
): PieceInstance[] {
  if (candidate.x == null || candidate.y == null) return []
  return battle.pieces
    .filter(piece => (
      piece.instanceId !== candidate.instanceId
      && piece.currentHp > 0
      && !deathCandidateIds.has(piece.instanceId)
      && piece.x != null
      && piece.y != null
      && Math.abs(piece.x - candidate.x!) <= squareRadius
      && Math.abs(piece.y - candidate.y!) <= squareRadius
      && getLegalDyingTeleportCells(battle, candidate, piece).length > 0
    ))
    .sort(stablePieceOrder)
}

function validateSelectedHost(
  battle: BattleState,
  candidate: PieceInstance,
  hostId: string | undefined,
  candidates: readonly PieceInstance[],
): PieceInstance {
  if (!hostId) throw new Error('寄生选择缺少合法宿主')
  const host = candidates.find(piece => piece.instanceId === hostId)
  if (!host || !battle.pieces.includes(host) || host.currentHp <= 0) {
    throw new Error('寄生选择的宿主已失效')
  }
  if (host === candidate || host.instanceId === candidate.instanceId) {
    throw new Error('寄生不能选择自身')
  }
  return host
}

function validateSelectedCell(
  destination: { x: number; y: number } | undefined,
  candidates: readonly { x: number; y: number }[],
): { x: number; y: number } {
  if (!destination) throw new Error('寄生选择缺少合法落点')
  const found = candidates.find(cell => cell.x === destination.x && cell.y === destination.y)
  if (!found) throw new Error('寄生选择的落点已失效')
  return { ...found }
}

/**
 * Resolve one closed death-time host transfer.  All validation happens before
 * the one resource mutation.  A missing suspendable runtime deliberately
 * leaves the candidate on the ordinary death path: detached damage calls
 * cannot invent a player choice.
 */
export function resolveDeathParasitism(
  battle: BattleState,
  candidate: DeathParasitismCandidate,
  deathCandidateIds: ReadonlySet<string>,
  dependencies: DeathParasitismDependencies,
): DeathParasitismResult {
  const runtime = getActiveSuspendableActionRuntime()
  if (!runtime) return { applied: false }

  const player = battle.players.find(entry => entry.playerId === candidate.piece.ownerPlayerId)
  const declaration = candidate.declaration
  if (!player || player.chargePoints < declaration.chargeCost) return { applied: false }

  const hosts = livingHostCandidates(
    battle,
    candidate.piece,
    deathCandidateIds,
    declaration.squareRadius,
  )
  if (hosts.length === 0) return { applied: false }

  const hostInput = consumeInteraction('host', candidate, candidate.piece.ownerPlayerId, {
    targetType: 'piece',
    candidates: hosts.map(host => ({ type: 'piece', pieceId: host.instanceId })),
    title: `寄生（消耗${declaration.chargeCost}充能）：选择宿主`,
  })
  if (!hostInput || hostInput.cancelled) return { applied: false }
  const host = validateSelectedHost(battle, candidate.piece, selectedPieceId(hostInput), hosts)

  const cells = getLegalDyingTeleportCells(battle, candidate.piece, host).sort(stableCellOrder)
  if (cells.length === 0) return { applied: false }
  const cellInput = consumeInteraction('cell', candidate, candidate.piece.ownerPlayerId, {
    targetType: 'cell',
    candidates: cells.map(cell => ({ type: 'cell', x: cell.x, y: cell.y })),
    title: '寄生：选择传送落点',
  })
  if (!cellInput || cellInput.cancelled) return { applied: false }
  const destination = validateSelectedCell(selectedCell(cellInput), cells)

  const hostOrigin = host.x == null || host.y == null ? undefined : { x: host.x, y: host.y }
  if (!hostOrigin) throw new Error('寄生提交时的宿主位置已失效')
  const originalHostOwnerPlayerId = host.ownerPlayerId
  const currentCells = getLegalDyingTeleportCells(battle, candidate.piece, host)
  if (!currentCells.some(cell => cell.x === destination.x && cell.y === destination.y)) {
    throw new Error('寄生提交时的落点已失效')
  }

  const moved = changeDyingPiecePosition(battle, candidate.piece, destination, {
    beforeCommit: finalDestination => {
      // Recheck all authoritative state after position reactions have settled,
      // immediately before the one resource/ownership mutation.
      if (!battle.pieces.includes(candidate.piece) || candidate.piece.currentHp !== 0
        || !battle.pieces.includes(host) || host.currentHp <= 0
        || host.x !== hostOrigin.x || host.y !== hostOrigin.y
        || !battle.players.includes(player) || player.chargePoints < declaration.chargeCost) return false
      const legalCells = getLegalDyingTeleportCells(battle, candidate.piece, host)
      if (!legalCells.some(cell => cell.x === finalDestination.x && cell.y === finalDestination.y)) return false

      player.chargePoints -= declaration.chargeCost
      host.ownerPlayerId = candidate.piece.ownerPlayerId
      host.faction = candidate.piece.faction
      if (!dependencies.addSkill(battle, host, declaration.grantSkillId)) {
        // An existing skill is an idempotent grant.  The callback returns false
        // for both “already present” and a failed load, so validate the result.
        if (!host.skills.some(skill => skill.skillId === declaration.grantSkillId)) {
          throw new Error('寄生无法授予血肉再生技能')
        }
      }
      for (const ruleId of declaration.grantRuleIds) {
        if (dependencies.addRule(battle, host, ruleId)) continue
        if (!host.rules.some(rule => rule?.id === ruleId)) {
          throw new Error(`寄生无法授予规则 ${ruleId}`)
        }
      }
      return true
    },
  })
  if (!moved.success) return { applied: false }
  battle.actions ??= []
  battle.actions.push({
    type: 'deathParasitism',
    playerId: candidate.piece.ownerPlayerId,
    turn: battle.turn.turnNumber,
    payload: {
      message: `${candidate.piece.name || candidate.piece.templateId} 寄生成功：将 ${host.name || host.templateId} 转为己方棋子，消耗 ${declaration.chargeCost} 点充能点并授予「${declaration.grantSkillId}」。`,
      sourcePieceId: candidate.piece.instanceId,
      hostId: host.instanceId,
      originalHostOwnerPlayerId,
      newHostOwnerPlayerId: host.ownerPlayerId,
      chargeCost: declaration.chargeCost,
      skillId: candidate.definition.id,
      grantSkillId: declaration.grantSkillId,
      grantRuleIds: [...declaration.grantRuleIds],
    },
  })
  return { applied: true, hostId: host.instanceId, destination }
}

export function makeDeathParasitismCandidate(
  piece: PieceInstance,
  definition: SkillDefinition,
): DeathParasitismCandidate | undefined {
  const declaration = definition.deathParasitism
  if (!declaration) return undefined
  return { piece, definition, declaration }
}
