import { createHash } from 'crypto'

import { getBattleStorage, withServerSkills, withoutServerSkills } from './battle-storage'
import { mulberry32, setRng } from './rng'
import type { BattleAction, BattleState } from './turn'
import { applyBattleAction } from './turn'

export interface BattleActionResult {
  state: BattleState
  stateHash: string
  actionHash: string
  duplicate?: boolean
}

export interface BattleReplayInput {
  initialState: BattleState
  actions: BattleAction[]
  seed?: number
}

export interface BattleReplayResult {
  initialHash: string
  finalState: BattleState
  finalStateHash: string
  actionHashes: string[]
  actionsApplied: number
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value))
}

export function hashStable(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function runBattleAction(state: BattleState, action: BattleAction): BattleActionResult {
  const actionId = getActionId(action)
  const metadata = getDebugMetadata(state)
  if (actionId && metadata.appliedActionIds.includes(actionId)) {
    return {
      state,
      stateHash: hashStable(state),
      actionHash: hashStable(action),
      duplicate: true,
    }
  }

  const hydratedState = withServerSkills(state) as BattleState
  const next = withoutServerSkills(applyBattleAction(hydratedState, action)) as BattleState
  const nextMetadata = getDebugMetadata(next)
  if (actionId) nextMetadata.appliedActionIds.push(actionId)
  nextMetadata.actionLog.push({
    action,
    actionHash: hashStable(action),
    stateHash: hashStable(next),
    index: nextMetadata.actionLog.length,
  })

  return {
    state: next,
    stateHash: hashStable(next),
    actionHash: hashStable(action),
  }
}

export function replayBattle(input: BattleReplayInput): BattleReplayResult {
  const actionHashes: string[] = []
  const previousRng = Math.random.bind(Math)

  if (typeof input.seed === 'number') {
    setRng(mulberry32(input.seed))
  }

  try {
    let state = input.initialState
    for (const action of input.actions) {
      const result = runBattleAction(state, action)
      state = result.state
      actionHashes.push(result.actionHash)
    }

    return {
      initialHash: hashStable(input.initialState),
      finalState: state,
      finalStateHash: hashStable(state),
      actionHashes,
      actionsApplied: input.actions.length,
    }
  } finally {
    setRng(previousRng)
  }
}

export function getRoomBattleState(room: unknown): BattleState | null {
  const storage = getBattleStorage(room)
  return storage?.state as BattleState | null
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

function getActionId(action: BattleAction): string | undefined {
  const id = (action as unknown as { clientActionId?: unknown; requestId?: unknown }).clientActionId
    ?? (action as unknown as { requestId?: unknown }).requestId
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function getDebugMetadata(state: BattleState): {
  appliedActionIds: string[]
  actionLog: Array<{ action: BattleAction; actionHash: string; stateHash: string; index: number }>
} {
  const extensions = state.extensions ?? {}
  state.extensions = extensions
  const metadata = (extensions.debugBattle ?? {}) as {
    appliedActionIds?: string[]
    actionLog?: Array<{ action: BattleAction; actionHash: string; stateHash: string; index: number }>
  }
  metadata.appliedActionIds ??= []
  metadata.actionLog ??= []
  extensions.debugBattle = metadata
  return metadata as {
    appliedActionIds: string[]
    actionLog: Array<{ action: BattleAction; actionHash: string; stateHash: string; index: number }>
  }
}
