import { getBattleStorage, withServerSkills, withoutServerSkills } from './battle-storage'
import {
  appendBattleReplayFrame,
  getOrCreateDebugMetadata,
  getBattleRootSeed,
  hashBattleState,
  hashStable,
  readDebugMetadata,
  sanitizeBattleTraceValue,
  type BattleActionTrace,
  type DebugBattleMetadata,
} from './battle-trace'
import {
  RuleRuntime,
  withRuleRuntime,
} from './rule-runtime'
import type { BattleAction, BattleState } from './turn'
import { applyBattleAction, assertBattleNotTerminal, safeCloneBattleState } from './turn'
import { globalTriggerSystem } from './triggers'

export {
  hashBattleState,
  hashStable,
  getBattleRootSeed,
  recordBattleInitialization,
  sha256Hex,
  stableJson,
} from './battle-trace'
export type { BattleActionTrace } from './battle-trace'

export interface BattleActionResult {
  state: BattleState
  stateHash: string
  actionHash: string
  duplicate?: boolean
  trace?: BattleActionTrace
}

export interface RunBattleActionOptions {
  rootSeed?: number
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
  stateHashes: string[]
  actionsApplied: number
}

export function runBattleAction(
  state: BattleState,
  action: BattleAction,
  options: RunBattleActionOptions = {},
): BattleActionResult {
  assertBattleNotTerminal(state)
  const explicitActionId = getActionId(action)
  const metadata = readDebugMetadata(state)
  if (explicitActionId && metadata.appliedActionIds.includes(explicitActionId)) {
    return {
      state,
      stateHash: hashBattleState(state),
      actionHash: hashStable(action),
      duplicate: true,
    }
  }

  const actionHash = hashStable(action)
  const actionIndex = metadata.actionLog.length
  const actionId = explicitActionId || `action-${actionIndex}-${actionHash.slice(0, 16)}`
  const tracedRootSeed = getBattleRootSeed(state)
  const providedRootSeed = typeof options.rootSeed === 'number' ? options.rootSeed : undefined
  if (providedRootSeed !== undefined && tracedRootSeed !== undefined && (providedRootSeed >>> 0) !== tracedRootSeed) {
    const mismatchRuntime = new RuleRuntime({
      rootSeed: providedRootSeed,
      cursors: collectRuntimeCursors(metadata.actionLog),
      tick: actionIndex,
    })
    throw decorateRuleError(
      new Error(`Root seed ${mismatchRuntime.rootSeed} does not match trace root seed ${tracedRootSeed}`),
      mismatchRuntime,
      state,
      action,
      actionId,
    )
  }
  const rootSeed = providedRootSeed ?? tracedRootSeed
  const runtime = rootSeed === undefined
    ? undefined
    : new RuleRuntime({
        rootSeed,
        cursors: collectRuntimeCursors(metadata.actionLog),
        tick: actionIndex,
      })
  // Presentation clients hydrate `skillsById` locally for rendering. It is a
  // runtime cache, not authoritative battle state, so it must not alter the
  // cross-platform pre-action hash.
  const canonicalState = withoutServerSkills(state) as BattleState
  const preStateHash = hashBattleState(canonicalState)

  try {
    const clonedState = cloneBattleStateForAction(state, metadata)
    const hydratedState = withServerSkills(clonedState) as BattleState
    const apply = () => applyBattleAction(hydratedState, action)
    const applied = runtime ? withRuleRuntime(runtime, apply) : apply()
    const next = withoutServerSkills(applied) as BattleState
    const postStateHash = hashBattleState(next)
    const nextMetadata = getOrCreateDebugMetadata(next)
    if (explicitActionId) nextMetadata.appliedActionIds.push(explicitActionId)

    const trace: BattleActionTrace = {
      index: actionIndex,
      rootSeed: runtime?.rootSeed ?? null,
      actionId,
      actionHash,
      tick: actionIndex,
      turn: state.turn?.turnNumber ?? 0,
      playerId: getActionPlayerId(state, action),
      preStateHash,
      postStateHash,
      randomStreams: runtime?.randomTrace(true) ?? [],
      deployment: isDeploymentAction(action) && next.deployment ? {
        command: deploymentCommand(action),
        choices: copyDeploymentChoices(next.deployment.choices),
        locks: copyDeploymentLocks(next.deployment.locks),
        timedOutPlayerIds: action.type === 'deploymentTimeout'
          ? next.deployment.playerIds.filter(playerId => next.deployment?.locks[playerId]?.reason === 'timeout')
          : undefined,
        finalPositions: copyDeploymentPositions(next.deployment.finalPositions),
        deadlineAt: next.deployment.deadlineAt,
        revision: next.deployment.revision,
      } : undefined,
    }
    nextMetadata.actionLog.push(trace)
    nextMetadata.commandLog[trace.index] = sanitizeBattleTraceValue(action) as Record<string, unknown>
    appendBattleReplayFrame(
      next,
      canonicalState,
      next,
      action as unknown as Record<string, unknown>,
      trace,
    )

    return {
      state: next,
      stateHash: postStateHash,
      actionHash,
      trace,
    }
  } catch (error) {
    if (!runtime) throw error
    // A rejected command is atomic: its random and clock reads are diagnostic
    // only and must not advance the committed cursor chain.
    runtime.restore({
      cursors: collectRuntimeCursors(metadata.actionLog),
      clockCursor: 0,
    })
    throw decorateRuleError(error, runtime, state, action, actionId)
  }
}

/**
 * Execute one authoritative transition while restoring process-level trigger
 * registry state afterwards. This is the synchronous isolation boundary used
 * by headless search/simulation; it does not save or broadcast the result.
 */
export function runBattleActionIsolated(
  state: BattleState,
  action: BattleAction,
  options: RunBattleActionOptions = {},
): BattleActionResult {
  const ruleRegistry = globalTriggerSystem.getRules()
  const rules = [...ruleRegistry]
  const ruleSnapshots = rules.map(rule => ({
    rule,
    snapshot: cloneRuntimeValue(rule),
  }))
  const triggerInternals = globalTriggerSystem as unknown as {
    rules?: typeof ruleRegistry
    nextRootEventId?: number
  }
  const nextRootEventId = triggerInternals.nextRootEventId
  try {
    return runBattleAction(state, action, options)
  } finally {
    for (const { rule, snapshot } of ruleSnapshots) {
      for (const key of Object.keys(rule)) delete (rule as unknown as Record<string, unknown>)[key]
      Object.assign(rule, cloneRuntimeValue(snapshot))
    }
    ruleRegistry.splice(0, ruleRegistry.length, ...rules)
    triggerInternals.rules = ruleRegistry
    if (nextRootEventId !== undefined) triggerInternals.nextRootEventId = nextRootEventId
  }
}

function cloneBattleStateForAction(
  state: BattleState,
  metadata: DebugBattleMetadata,
): BattleState {
  if (!metadata.replay) return safeCloneBattleState(state)

  const extensions = { ...(state.extensions ?? {}) }
  const debugBattle = { ...(extensions.debugBattle as Record<string, unknown> | undefined) }
  delete debugBattle.replay
  extensions.debugBattle = debugBattle
  const cloneInput = { ...state, extensions }
  const cloned = safeCloneBattleState(cloneInput)
  const clonedMetadata = getOrCreateDebugMetadata(cloned)
  clonedMetadata.replay = {
    ...metadata.replay,
    frames: [...metadata.replay.frames],
  }
  return cloned
}

function cloneRuntimeValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  const source = value as object
  const existing = seen.get(source)
  if (existing) return existing as T
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
  seen.set(source, copy)
  for (const [key, entry] of Object.entries(value)) {
    ;(copy as Record<string, unknown>)[key] = cloneRuntimeValue(entry, seen)
  }
  return copy as T
}

function copyDeploymentChoices(
  choices: Record<string, { pieceId: string | null }>,
): Record<string, { pieceId: string | null }> {
  return Object.fromEntries(
    Object.entries(choices).map(([playerId, choice]) => [playerId, { pieceId: choice.pieceId }]),
  )
}
function copyDeploymentLocks(
  locks: Record<string, { locked: boolean; reason?: 'player' | 'timeout' }>,
): Record<string, { locked: boolean; reason?: 'player' | 'timeout' }> {
  return Object.fromEntries(
    Object.entries(locks).map(([playerId, lock]) => [playerId, { ...lock }]),
  )
}

function isDeploymentAction(action: BattleAction): boolean {
  return action.type === 'deploymentChoice' || action.type === 'deploymentLock' || action.type === 'deploymentTimeout'
}

function deploymentCommand(action: BattleAction): 'select' | 'lock' | 'timeout' {
  if (action.type === 'deploymentTimeout') return 'timeout'
  if (action.type === 'deploymentLock') return 'lock'
  return 'select'
}


function copyDeploymentPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
): Record<string, { x: number; y: number }> | undefined {
  if (!positions) return undefined
  return Object.fromEntries(
    Object.entries(positions).map(([pieceId, position]) => [pieceId, { ...position }]),
  )
}

export function replayBattle(input: BattleReplayInput): BattleReplayResult {
  const actionHashes: string[] = []
  const stateHashes: string[] = []
  let state = input.initialState
  for (const action of input.actions) {
    const result = runBattleAction(state, action, { rootSeed: input.seed })
    state = result.state
    actionHashes.push(result.actionHash)
    stateHashes.push(result.stateHash)
  }

  return {
    initialHash: hashBattleState(input.initialState),
    finalState: state,
    finalStateHash: hashBattleState(state),
    actionHashes,
    stateHashes,
    actionsApplied: input.actions.length,
  }
}

export function getRoomBattleState(room: unknown): BattleState | null {
  const storage = getBattleStorage(room)
  return storage?.state as BattleState | null
}

function getActionId(action: BattleAction): string | undefined {
  const id = (action as unknown as { clientActionId?: unknown; requestId?: unknown }).clientActionId
    ?? (action as unknown as { requestId?: unknown }).requestId
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function collectRuntimeCursors(actionLog: DebugBattleMetadata['actionLog']): Record<string, number> {
  const cursors: Record<string, number> = {}
  for (const entry of actionLog) {
    const streams = (entry as Partial<BattleActionTrace>).randomStreams
    if (!Array.isArray(streams)) continue
    for (const stream of streams) {
      if (!stream || typeof stream.name !== 'string' || !Number.isSafeInteger(stream.endCursor) || stream.endCursor < 0) continue
      cursors[stream.name] = stream.endCursor
    }
  }
  return cursors
}

function getActionPlayerId(state: BattleState, action: BattleAction): string {
  const playerId = (action as unknown as { playerId?: unknown }).playerId
  if (action.type === 'deploymentTimeout') return 'system'
  return typeof playerId === 'string' && playerId.trim()
    ? playerId.trim()
    : state.turn?.currentPlayerId ?? 'system'
}

function decorateRuleError(
  error: unknown,
  runtime: RuleRuntime,
  state: BattleState,
  action: BattleAction,
  actionId: string,
): Error {
  const decorated = error instanceof Error ? error : new Error(String(error))
  const randomAccess = runtime.getLastRandomAccess()
  const determinism = {
    rootSeed: runtime.rootSeed,
    streamName: randomAccess.streamName,
    cursor: randomAccess.cursor,
    turn: state.turn?.turnNumber ?? 0,
    playerId: getActionPlayerId(state, action),
    actionId,
  }
  Object.assign(decorated, { determinism })
  decorated.message = `${decorated.message} [seed=${determinism.rootSeed} stream=${determinism.streamName} cursor=${determinism.cursor} turn=${determinism.turn} player=${determinism.playerId} actionId=${determinism.actionId}]`
  return decorated
}
