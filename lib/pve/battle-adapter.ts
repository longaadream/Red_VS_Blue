import { createGameProfileIdentityV1, type GameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import {
  createServerBattleStateV1,
  validateServerBattleStateV1,
  withoutServerSkills,
  type ServerBattleState,
} from '@/lib/game/battle-storage'
import { hashBattleState, hashStable, runBattleAction } from '@/lib/game/battle-runner'
import { readDebugMetadata } from '@/lib/game/battle-trace'
import type { PieceTemplate } from '@/lib/game/piece'
import { getPieceById } from '@/lib/game/piece-repository'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { getClientTerminalSubmissionError } from '@/lib/server/battle-terminal'
import type { PveActiveBattleReferenceV1 } from './contracts/run-v1'

export const PVE_PLAYER_ID_V1 = 'player-red' as const
export const PVE_ENEMY_ID_V1 = 'player-blue' as const
export const PVE_BATTLE_ADAPTER_REVISION_V1 = 'rvb-pve-battle-adapter/v1' as const

export type PveBattleOutcomeV1 = 'victory' | 'defeat' | 'draw'

export class PveBattleAdapterErrorV1 extends Error {
  constructor(
    readonly code:
      | 'PVE_BATTLE_SETUP_INVALID'
      | 'PVE_BATTLE_PROFILE_MISMATCH'
      | 'PVE_BATTLE_ACTION_INVALID'
      | 'PVE_BATTLE_NOT_TERMINAL',
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'PveBattleAdapterErrorV1'
  }
}

export interface CreatePveBattleInputV1 {
  readonly runId: string
  readonly sourceNodeId: string
  readonly encounterId: string
  readonly mapId: string
  readonly rootSeed: number
  readonly authorityContentHash: string
  readonly profileReference: Parameters<typeof createGameProfileIdentityV1>[0]
  readonly playerPieceIds: readonly string[]
  readonly enemyPieceIds: readonly string[]
}

export interface CreatedPveBattleV1 {
  readonly storage: ServerBattleState
  readonly reference: PveActiveBattleReferenceV1
}

export interface AppliedPveBattleActionV1 {
  readonly storage: ServerBattleState
  readonly stateHash: string
  readonly actionHash: string
  readonly duplicate: boolean
}

export interface SettledPveBattleV1 {
  readonly outcome: PveBattleOutcomeV1
  readonly stateHash: string
  readonly terminalResult: NonNullable<BattleState['terminalResult']>
}

/**
 * Creates the sole battle authority used by PVE. Content IDs have already
 * passed the PVE Snapshot registry; this boundary resolves them through the
 * active game repositories and rejects any missing or misaligned template.
 */
export async function createPveBattleV1(
  input: CreatePveBattleInputV1,
): Promise<CreatedPveBattleV1> {
  const rootSeed = assertUint32(input.rootSeed)
  const profileIdentity = createGameProfileIdentityV1(input.profileReference)
  if (profileIdentity.authorityContentHash !== input.authorityContentHash) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_PROFILE_MISMATCH',
      'PVE battle authorityContentHash does not match the verified active Profile',
    )
  }

  const playerPieces = resolveRoster(input.playerPieceIds, 'good', 'player')
  const enemyPieces = resolveRoster(input.enemyPieceIds, 'evil', 'enemy')
  const battleId = createBattleId(input.runId, input.sourceNodeId)
  const battleSeed = deriveBattleSeed(rootSeed, battleId)
  const state = await createInitialBattleForPlayers(
    [PVE_PLAYER_ID_V1, PVE_ENEMY_ID_V1],
    [...playerPieces, ...enemyPieces],
    [
      {
        playerId: PVE_PLAYER_ID_V1,
        pieces: playerPieces,
        faction: 'red',
        alignment: 'light',
      },
      {
        playerId: PVE_ENEMY_ID_V1,
        pieces: enemyPieces,
        faction: 'blue',
        alignment: 'dark',
      },
    ],
    input.mapId,
    {
      firstPlayerId: PVE_PLAYER_ID_V1,
      rootSeed: battleSeed,
      deploymentEnabled: true,
      // PVE has no wall-clock deployment choice. Zero is deterministic and
      // both registered rosters are locked immediately below.
      deploymentStartedAt: 0,
      profileIdentity,
    },
  )
  if (!state) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_SETUP_INVALID',
      'Formal battle setup rejected the PVE players',
    )
  }

  let lockedState = runBattleAction(state, {
    type: 'deploymentLock',
    playerId: PVE_PLAYER_ID_V1,
  }, { rootSeed: battleSeed }).state
  const enemyLockResult = runBattleAction(lockedState, {
    type: 'deploymentLock',
    playerId: PVE_ENEMY_ID_V1,
  }, { rootSeed: battleSeed })
  lockedState = resolvePrototypeSetupInteractions(enemyLockResult.state, battleSeed)
  if (lockedState.deployment?.status !== 'complete') {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_SETUP_INVALID',
      'Formal PVE deployment did not reach a complete state',
    )
  }

  const canonicalState = withoutServerSkills(lockedState) as BattleState
  const stateHash = hashBattleState(canonicalState)
  return {
    storage: createServerBattleStateV1(profileIdentity, battleSeed, canonicalState),
    reference: {
      schemaVersion: 'rvb-pve-active-battle/v1',
      authorityContentHash: input.authorityContentHash,
      battleId,
      sourceNodeId: input.sourceNodeId,
      encounterId: input.encounterId,
      stateHash,
    },
  }
}

export function applyPveBattleActionV1(
  current: ServerBattleState,
  actionValue: unknown,
): AppliedPveBattleActionV1 {
  const forbidden = getClientTerminalSubmissionError({ action: actionValue })
  if (forbidden) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_ACTION_INVALID',
      forbidden.message,
      400,
    )
  }
  if (!isBattleActionShape(actionValue)) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_ACTION_INVALID',
      'PVE battle action must be a formal BattleAction object',
      400,
    )
  }

  const storage = validateServerBattleStateV1(current)
  let result: ReturnType<typeof runBattleAction>
  try {
    result = runBattleAction(
      storage.state as BattleState,
      actionValue as BattleAction,
      { rootSeed: storage.rootSeed },
    )
  } catch (error) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_ACTION_INVALID',
      `Formal Battle Runner rejected the action: ${
        error instanceof Error ? error.message : String(error)
      }`,
      400,
    )
  }
  const canonicalState = withoutServerSkills(result.state) as BattleState
  return {
    storage: createServerBattleStateV1(
      storage.profileIdentity,
      storage.rootSeed,
      canonicalState,
    ),
    stateHash: hashBattleState(canonicalState),
    actionHash: result.actionHash,
    duplicate: result.duplicate === true,
  }
}

/** Reads the formal runner terminal only; callers cannot supply an outcome. */
export function settlePveBattleV1(current: ServerBattleState): SettledPveBattleV1 {
  const storage = validateServerBattleStateV1(current)
  const state = storage.state as BattleState
  const terminalResult = state.terminalResult
  if (!terminalResult || terminalResult.status !== 'finished') {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_NOT_TERMINAL',
      'PVE battle cannot settle before the formal Battle Runner commits terminalResult',
    )
  }

  const outcome: PveBattleOutcomeV1 = terminalResult.winnerPlayerId === PVE_PLAYER_ID_V1
    ? 'victory'
    : terminalResult.winnerPlayerId === PVE_ENEMY_ID_V1
      ? 'defeat'
      : 'draw'
  return {
    outcome,
    stateHash: hashBattleState(state),
    terminalResult,
  }
}

export function pveBattleProfileIdentityV1(current: ServerBattleState): GameProfileIdentityV1 {
  return validateServerBattleStateV1(current).profileIdentity
}

export function hasPveBattleActionV1(
  current: ServerBattleState,
  commandId: string,
): boolean {
  const storage = validateServerBattleStateV1(current)
  return readDebugMetadata(storage.state as BattleState)
    .appliedActionIds.includes(commandId)
}

function resolveRoster(
  ids: readonly string[],
  expectedFaction: PieceTemplate['faction'],
  label: string,
): PieceTemplate[] {
  if (ids.length !== 8 || new Set(ids).size !== 8) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_SETUP_INVALID',
      `Registered ${label} roster must contain exactly eight unique pieces`,
    )
  }
  return ids.map(id => {
    const piece = getPieceById(id)
    if (!piece || piece.faction !== expectedFaction) {
      throw new PveBattleAdapterErrorV1(
        'PVE_BATTLE_SETUP_INVALID',
        `Registered ${label} roster piece ${id} is unavailable or misaligned`,
      )
    }
    return piece
  })
}

/**
 * The registered light roster currently contains a mandatory game-start
 * choice. Resolve setup-only option prompts with the first registered option,
 * through the same formal Runner, so the Prototype does not fork rule logic.
 * Target prompts are not safe to guess and therefore fail closed.
 */
function resolvePrototypeSetupInteractions(
  initial: BattleState,
  rootSeed: number,
): BattleState {
  let state = initial
  for (let step = 0; step < 16; step += 1) {
    const pending = state.pendingOptionSelection
    if (!pending) {
      if (state.pendingTargetSelection) {
        throw new PveBattleAdapterErrorV1(
          'PVE_BATTLE_SETUP_INVALID',
          'Prototype battle setup cannot guess a mandatory target selection',
        )
      }
      return state
    }
    if (!pending.selectionId || !Number.isSafeInteger(pending.stateRevision)) {
      throw new PveBattleAdapterErrorV1(
        'PVE_BATTLE_SETUP_INVALID',
        'Prototype battle setup received an unversioned option selection',
      )
    }
    const minimum = pending.selectionMode === 'multi'
      ? Math.max(1, pending.minSelections ?? 1)
      : 1
    if (pending.options.length < minimum) {
      throw new PveBattleAdapterErrorV1(
        'PVE_BATTLE_SETUP_INVALID',
        'Prototype battle setup option selection has no registered default',
      )
    }
    const selected = pending.options.slice(0, minimum).map(optionValue)
    state = runBattleAction(state, {
      type: 'pendingOptionSelect',
      playerId: pending.playerId,
      selectedOption: pending.selectionMode === 'multi' ? selected : selected[0],
      selectionId: pending.selectionId,
      stateRevision: pending.stateRevision!,
    }, { rootSeed }).state
  }
  throw new PveBattleAdapterErrorV1(
    'PVE_BATTLE_SETUP_INVALID',
    'Prototype battle setup exceeded the pending interaction budget',
  )
}

function optionValue(option: unknown): unknown {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return option
  const record = option as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'value')) return record.value
  if (Object.prototype.hasOwnProperty.call(record, 'id')) return record.id
  return option
}

function createBattleId(runId: string, sourceNodeId: string): string {
  return `battle-${hashStable({ runId, sourceNodeId }).slice(0, 24)}`
}

function deriveBattleSeed(rootSeed: number, battleId: string): number {
  return Number.parseInt(hashStable({ rootSeed, battleId }).slice(0, 8), 16) >>> 0
}

function assertUint32(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new PveBattleAdapterErrorV1(
      'PVE_BATTLE_SETUP_INVALID',
      'PVE root seed must be an unsigned 32-bit integer',
      400,
    )
  }
  return value >>> 0
}

function isBattleActionShape(value: unknown): value is BattleAction {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string'
}
