import { getBattleStorage, withServerSkills, withoutServerSkills } from './battle-storage'
import {
  appendBattleReplayFrame,
  canonicalBattleStateForHash,
  createBattleStateHashIndex,
  getOrCreateDebugMetadata,
  getBattleRootSeed,
  hashBattleState,
  hashStable,
  readDebugMetadata,
  sanitizeBattleTraceValue,
  type BattleActionTrace,
  type BattleReplayFrame,
  type DebugBattleMetadata,
} from './battle-trace'
import {
  createBattleStateHashPatch,
  updateBattleStateHashIndex,
  type BattleStateHashIndex,
} from './battle-state-hash'
import {
  createRuleExecutionContext,
  getRuleExecutionTriggerSystem,
  RuleRuntime,
  withRuleExecutionContext,
  withRuleRuntime,
  type RuleExecutionContext,
} from './rule-runtime'
import type { BattleAction, BattleState } from './turn'
import { applyBattleAction, assertBattleNotTerminal, safeCloneBattleState } from './turn'
import { globalTriggerSystem, TriggerSystem } from './triggers'

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
  replayFrame?: BattleReplayFrame
  stateHashIndex?: BattleStateHashIndex
}

export interface RunBattleActionOptions {
  rootSeed?: number
  stateHashIndex?: BattleStateHashIndex
  ruleExecutionContext?: RuleExecutionContext
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
      stateHash: options.stateHashIndex?.rootHash ?? hashBattleState(state),
      actionHash: hashStable(action),
      duplicate: true,
      stateHashIndex: options.stateHashIndex,
    }
  }

  const actionHash = hashStable(action)
  const actionIndex = metadata.authority?.actionCount ?? metadata.actionLog.length
  const actionId = explicitActionId || `action-${actionIndex}-${actionHash.slice(0, 16)}`
  const tracedRootSeed = getBattleRootSeed(state)
  const providedRootSeed = typeof options.rootSeed === 'number' ? options.rootSeed : undefined
  if (providedRootSeed !== undefined && tracedRootSeed !== undefined && (providedRootSeed >>> 0) !== tracedRootSeed) {
    const mismatchRuntime = new RuleRuntime({
      rootSeed: providedRootSeed,
      cursors: collectRuntimeCursors(metadata),
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
        cursors: collectRuntimeCursors(metadata),
        tick: actionIndex,
      })
  // Presentation clients hydrate `skillsById` locally for rendering. It is a
  // runtime cache, not authoritative battle state, so it must not alter the
  // cross-platform pre-action hash.
  const canonicalState = withoutServerSkills(state) as BattleState
  const canonicalHashState = canonicalBattleStateForHash(canonicalState)
  const preStateHashIndex = options.stateHashIndex ?? createBattleStateHashIndex(canonicalState)
  const preStateHash = preStateHashIndex.rootHash

  try {
    const clonedState = cloneBattleStateForAction(state, metadata)
    const hydratedState = withServerSkills(clonedState) as BattleState
    const apply = () => applyBattleAction(hydratedState, action)
    const applyWithDeterminism = () => runtime ? withRuleRuntime(runtime, apply) : apply()
    const applied = options.ruleExecutionContext
      ? withRuleExecutionContext(options.ruleExecutionContext, applyWithDeterminism)
      : applyWithDeterminism()
    const next = withoutServerSkills(applied) as BattleState
    const canonicalNextHashState = canonicalBattleStateForHash(next)
    const stateHashIndex = updateBattleStateHashIndex(
      preStateHashIndex,
      canonicalNextHashState,
      createBattleStateHashPatch(canonicalHashState, canonicalNextHashState),
      hashStable,
    ).index
    const postStateHash = stateHashIndex.rootHash
    const nextMetadata = getOrCreateDebugMetadata(next)
    if (explicitActionId) nextMetadata.appliedActionIds.push(explicitActionId)

    const tracedDeploymentAction = deploymentTraceAction(state, next, action)
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
      deployment: tracedDeploymentAction && next.deployment ? {
        command: deploymentCommand(tracedDeploymentAction),
        mode: next.deployment.mode,
        status: next.deployment.status,
        choices: copyDeploymentChoices(next.deployment.choices),
        locks: copyDeploymentLocks(next.deployment.locks),
        timedOutPlayerIds: tracedDeploymentAction.type === 'deploymentTimeout'
          ? next.deployment.playerIds.filter(playerId => next.deployment?.locks[playerId]?.reason === 'timeout')
          : undefined,
        finalPositions: copyDeploymentPositions(next.deployment.finalPositions),
        deadlineAt: next.deployment.deadlineAt,
        revision: next.deployment.revision,
        openingVanguardsInitialized: next.deployment.openingVanguardsInitialized,
        activePlayerId: next.deployment.activePlayerId,
        offerPieceIds: next.deployment.offerPieceIds ? [...next.deployment.offerPieceIds] : undefined,
        reserveCounts: next.deployment.reserveCounts ? { ...next.deployment.reserveCounts } : undefined,
        lastDeployedPieceId: next.deployment.lastDeployedPieceId,
        deployedPosition: committedProgressiveDeploymentPosition(state, next, tracedDeploymentAction),
      } : undefined,
    }
    nextMetadata.actionLog.push(trace)
    nextMetadata.commandLog[trace.index] = sanitizeBattleTraceValue(action) as Record<string, unknown>
    nextMetadata.authority = {
      rootSeed: runtime?.rootSeed ?? metadata.authority?.rootSeed,
      actionCount: trace.index + 1,
      replayFrameCount: metadata.authority?.replayFrameCount ?? nextMetadata.replay?.frames.length ?? 0,
      runtimeCursors: mergeRuntimeCursors(metadata.authority?.runtimeCursors, trace),
    }
    const replayFrame = appendBattleReplayFrame(
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
      replayFrame,
      stateHashIndex,
    }
  } catch (error) {
    if (!runtime) throw error
    // A rejected command is atomic: its random and clock reads are diagnostic
    // only and must not advance the committed cursor chain.
    runtime.restore({
      cursors: collectRuntimeCursors(metadata),
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
  const sourceTriggerSystem = options.ruleExecutionContext?.triggerSystem
    ?? getRuleExecutionTriggerSystem(globalTriggerSystem)
  const sourceRules = [...sourceTriggerSystem.getRules()]
  const sourceRuleSnapshots = sourceRules.map(rule => ({
    rule,
    snapshot: cloneRuntimeValue(rule),
  }))
  const isolatedTriggerSystem = new TriggerSystem()
  isolatedTriggerSystem.addRules(sourceRules.map(rule => cloneRuntimeValue(rule)))
  try {
    return runBattleAction(state, action, {
      ...options,
      ruleExecutionContext: createRuleExecutionContext(isolatedTriggerSystem),
    })
  } finally {
    // Dynamic effects can close over their source rule object. Restore those
    // objects without mutating the owning TriggerSystem registry or event IDs.
    for (const { rule, snapshot } of sourceRuleSnapshots) {
      for (const key of Object.keys(rule)) delete (rule as unknown as Record<string, unknown>)[key]
      Object.assign(rule, cloneRuntimeValue(snapshot))
    }
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
  return action.type === 'deploymentChoice'
    || action.type === 'deploymentLock'
    || action.type === 'deploymentTimeout'
    || action.type === 'deployReservePiece'
}

function deploymentCommand(
  action: BattleAction,
): 'select' | 'lock' | 'timeout' | 'deploy' {
  if (action.type === 'deploymentTimeout' || action.type === 'turnTimeout') return 'timeout'
  if (action.type === 'deploymentLock') return 'lock'
  if (action.type === 'deployReservePiece') return 'deploy'
  return 'select'
}

function deploymentTraceAction(
  state: BattleState,
  next: BattleState,
  action: BattleAction,
): BattleAction | undefined {
  if (isDeploymentAction(action)) return action
  if (
    action.type === 'turnTimeout'
    && (state.deployment?.mode === 'progressive-reserve-v1'
      || next.deployment?.mode === 'progressive-reserve-v1')
  ) return action
  if (
    action.type !== 'pendingOptionSelect'
    && action.type !== 'pendingTargetSelect'
    && action.type !== 'cancelPendingSelection'
  ) return undefined
  const pending = state.pendingOptionSelection ?? state.pendingTargetSelection
  const rootAction = pending?.transaction?.rootAction as BattleAction | undefined
  if (!rootAction) return undefined
  if (isDeploymentAction(rootAction)) return rootAction
  return rootAction.type === 'turnTimeout' ? rootAction : undefined
}


function copyDeploymentPositions(
  positions: Record<string, { x: number; y: number }> | undefined,
): Record<string, { x: number; y: number }> | undefined {
  if (!positions) return undefined
  return Object.fromEntries(
    Object.entries(positions).map(([pieceId, position]) => [pieceId, { ...position }]),
  )
}

function committedProgressiveDeploymentPosition(
  previousState: BattleState,
  state: BattleState,
  action: BattleAction,
): { x: number; y: number } | undefined {
  if (action.type !== 'deployReservePiece' && action.type !== 'turnTimeout') return undefined
  const pieceId = action.type === 'deployReservePiece' ? action.pieceId : undefined
  const previousActionCount = previousState.actions?.length ?? 0
  const committed = [...(state.actions ?? []).slice(previousActionCount)].reverse().find(entry =>
    entry.type === 'deployReservePiece'
    && (pieceId === undefined || entry.payload?.pieceId === pieceId))
  const x = committed?.payload?.toX
  const y = committed?.payload?.toY
  return Number.isSafeInteger(x) && Number.isSafeInteger(y)
    ? { x: x as number, y: y as number }
    : undefined
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

function collectRuntimeCursors(metadata: DebugBattleMetadata): Record<string, number> {
  const cursors: Record<string, number> = { ...(metadata.authority?.runtimeCursors ?? {}) }
  for (const entry of metadata.actionLog) {
    const streams = (entry as Partial<BattleActionTrace>).randomStreams
    if (!Array.isArray(streams)) continue
    for (const stream of streams) {
      if (!stream || typeof stream.name !== 'string' || !Number.isSafeInteger(stream.endCursor) || stream.endCursor < 0) continue
      cursors[stream.name] = stream.endCursor
    }
  }
  return cursors
}

function mergeRuntimeCursors(
  previous: Record<string, number> | undefined,
  trace: Pick<BattleActionTrace, 'randomStreams'>,
): Record<string, number> {
  const cursors = { ...(previous ?? {}) }
  for (const stream of trace.randomStreams) {
    if (!stream || typeof stream.name !== 'string' || !Number.isSafeInteger(stream.endCursor) || stream.endCursor < 0) continue
    cursors[stream.name] = stream.endCursor
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
