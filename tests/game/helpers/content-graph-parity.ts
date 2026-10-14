import {
  hashBattleState,
  runBattleAction,
  type BattleActionResult,
} from '@/lib/game/battle-runner'
import {
  projectBattlePresentationEvents,
  projectBattlePresentationEventsForViewer,
} from '@/lib/game/battle-presentation-events'
import { recordBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { toPublicBattleState } from '@/lib/game/deployment'
import { safeCloneBattleState, type BattleAction, type BattleState } from '@/lib/game/turn'

/** A viewer id; `undefined` represents the spectator/public projection. */
export type ContentGraphParityViewer = string | undefined

export interface ContentGraphParityExecutorContext<TContent> {
  readonly variantName: string
  readonly content: TContent
  readonly seed: number
  readonly actionIndex: number
  readonly action: BattleAction
  readonly beforeState: BattleState
  readonly viewers: readonly ContentGraphParityViewer[]
}

/**
 * A variant executor returns the state produced by one authoritative runtime.
 * The optional channels are deliberately explicit: a compiler adapter can
 * provide its own outcome/trace, while the battle adapter below captures the
 * existing engine's logs, random trace, presentation, pending state, and
 * public projections without reimplementing game rules.
 */
export interface ContentGraphParityExecution {
  readonly state: BattleState
  readonly outcome?: unknown
  readonly trace?: unknown
  readonly random?: unknown
  readonly actionLog?: unknown
  readonly presentationEvents?: readonly unknown[]
  readonly pending?: unknown
  readonly viewerProjections?: Readonly<Record<string, unknown>>
  readonly stateHash?: string
}

export type ContentGraphParityExecutor<TContent> = (
  input: {
    readonly state: BattleState
    readonly action: BattleAction
    readonly context: ContentGraphParityExecutorContext<TContent>
  },
) => ContentGraphParityExecution | BattleState | Promise<ContentGraphParityExecution | BattleState>

export interface ContentGraphParityVariant<TContent> {
  /** Human-readable name used in mismatch diagnostics. */
  readonly name: string
  /** The legacy or graph content definition supplied to the executor. */
  readonly content: TContent
  /**
   * Optional variant-specific initial state factory. When omitted, the common
   * `initialState` from the run options is cloned for this variant.
   */
  readonly createInitialState?: (content: TContent) => BattleState
  readonly execute: ContentGraphParityExecutor<TContent>
}

export interface ContentGraphParityOptions<TLegacyContent, TGraphContent> {
  readonly seed: number
  readonly actions: readonly BattleAction[]
  readonly initialState: BattleState | (() => BattleState)
  readonly legacy: ContentGraphParityVariant<TLegacyContent>
  readonly graph: ContentGraphParityVariant<TGraphContent>
  /** Public battle and presentation projections to capture at every step. */
  readonly viewers?: readonly ContentGraphParityViewer[]
  /**
   * Explicit state projection for callers whose runtime state contains a
   * separately tracked content definition. The default compares the complete
   * state returned by the executor, preserving every semantic field.
   */
  readonly projectState?: (state: BattleState, context: ContentGraphParityExecutorContext<unknown>) => unknown
  /** Optional matching hash for an explicit state projection. */
  readonly projectStateHash?: (state: BattleState, context: ContentGraphParityExecutorContext<unknown>) => string
}

export type ContentGraphParityDifferenceCategory =
  | 'execution'
  | 'content'
  | 'state'
  | 'stateHash'
  | 'outcome'
  | 'trace'
  | 'random'
  | 'actionLog'
  | 'presentationEvents'
  | 'pending'
  | `viewer:${string}`

export interface ContentGraphParityDifference {
  readonly category: ContentGraphParityDifferenceCategory
  readonly path: string
  readonly legacy: unknown
  readonly graph: unknown
}

export interface ContentGraphParitySnapshot {
  readonly state: unknown
  readonly stateHash: string
  readonly outcome: unknown
  readonly trace: unknown
  readonly random: unknown
  readonly actionLog: unknown
  readonly presentationEvents: readonly unknown[] | undefined
  readonly pending: unknown
  readonly viewerProjections: Readonly<Record<string, unknown>> | undefined
  readonly executionError?: unknown
}

export interface ContentGraphParityStep {
  readonly actionIndex: number
  readonly action: BattleAction
  readonly legacy: ContentGraphParitySnapshot
  readonly graph: ContentGraphParitySnapshot
  readonly differences: readonly ContentGraphParityDifference[]
}

export interface ContentGraphParityReport {
  readonly seed: number
  readonly equal: boolean
  readonly steps: readonly ContentGraphParityStep[]
  /** Content is reported separately so generated/source bytes are visible. */
  readonly content: {
    readonly legacy: unknown
    readonly graph: unknown
    readonly difference?: ContentGraphParityDifference
  }
}

export class ContentGraphParityError extends Error {
  readonly report: ContentGraphParityReport

  constructor(report: ContentGraphParityReport) {
    const firstStep = report.steps.find(step => step.differences.length > 0)
    const first = firstStep?.differences[0]
    const action = firstStep ? formatValue(firstStep.action) : '<none>'
    const message = first
      ? [
          '[RED-252] content graph parity mismatch',
          `seed: 0x${report.seed.toString(16).padStart(8, '0')} (${report.seed})`,
          `action index: ${firstStep.actionIndex}`,
          `action: ${action}`,
          `first difference: ${first.category}${first.path ? `.${first.path}` : ''}`,
          `legacy: ${formatValue(first.legacy)}`,
          `graph: ${formatValue(first.graph)}`,
        ].join('\n')
      : '[RED-252] content graph parity mismatch'
    super(message)
    this.name = 'ContentGraphParityError'
    this.report = report
  }
}

/**
 * Run the same fixed-seed action sequence through two content executors.
 * Executors are called sequentially because the authoritative runtime keeps
 * scoped trigger/presentation state; this also avoids sharing mutable inputs.
 */
export async function runContentGraphParity<TLegacyContent, TGraphContent>(
  options: ContentGraphParityOptions<TLegacyContent, TGraphContent>,
): Promise<ContentGraphParityReport> {
  const viewers = options.viewers ?? []
  let legacyState = createInitialState(options.initialState, options.legacy)
  let graphState = createInitialState(options.initialState, options.graph)
  const steps: ContentGraphParityStep[] = []

  for (let actionIndex = 0; actionIndex < options.actions.length; actionIndex += 1) {
    const action = options.actions[actionIndex]
    const legacyContext: ContentGraphParityExecutorContext<TLegacyContent> = {
      variantName: options.legacy.name,
      content: options.legacy.content,
      seed: options.seed >>> 0,
      actionIndex,
      action,
      beforeState: legacyState,
      viewers,
    }
    const graphContext: ContentGraphParityExecutorContext<TGraphContent> = {
      variantName: options.graph.name,
      content: options.graph.content,
      seed: options.seed >>> 0,
      actionIndex,
      action,
      beforeState: graphState,
      viewers,
    }

    const legacyRun = await executeVariant(options.legacy, legacyState, action, legacyContext)
    const graphRun = await executeVariant(options.graph, graphState, action, graphContext)
    legacyState = legacyRun.state
    graphState = graphRun.state

    const legacySnapshot = snapshotExecution(legacyRun, legacyContext, options.projectState, options.projectStateHash)
    const graphSnapshot = snapshotExecution(graphRun, graphContext, options.projectState, options.projectStateHash)
    const differences = compareSnapshots(legacySnapshot, graphSnapshot)
    steps.push({ actionIndex, action, legacy: legacySnapshot, graph: graphSnapshot, differences })
  }

  const contentDifference = firstDifference(
    options.legacy.content,
    options.graph.content,
    'content',
  )
  return {
    seed: options.seed >>> 0,
    equal: steps.every(step => step.differences.length === 0),
    steps,
    content: {
      legacy: options.legacy.content,
      graph: options.graph.content,
      difference: contentDifference ? toParityDifference('content', contentDifference) : undefined,
    },
  }
}

/** Run parity and fail with a reproducible first-difference diagnostic. */
export async function assertContentGraphParity<TLegacyContent, TGraphContent>(
  options: ContentGraphParityOptions<TLegacyContent, TGraphContent>,
): Promise<ContentGraphParityReport> {
  const report = await runContentGraphParity(options)
  if (!report.equal) throw new ContentGraphParityError(report)
  return report
}

export interface BattleActionParityCaptureOptions {
  readonly runBattleAction?: typeof runBattleAction
  readonly viewers?: readonly ContentGraphParityViewer[]
}

/**
 * Adapt the real authoritative battle runner to the parity harness. This is
 * intentionally an adapter around existing engine APIs, rather than a second
 * implementation of SkillCode or graph semantics.
 */
export function executeBattleActionForContentGraphParity<TContent>(
  input: {
    readonly state: BattleState
    readonly action: BattleAction
    readonly context: ContentGraphParityExecutorContext<TContent>
  },
  captureOptions: BattleActionParityCaptureOptions = {},
): ContentGraphParityExecution {
  const runner = captureOptions.runBattleAction ?? runBattleAction
  const viewers = captureOptions.viewers ?? input.context.viewers
  const beforeState = input.state
  const result: BattleActionResult = recordBattlePresentation(
    beforeState,
    () => runner(beforeState, input.action, { rootSeed: input.context.seed }),
    value => value.state,
  )

  const presentationEvents = projectBattlePresentationEvents({
    actionId: result.trace?.actionId ?? `content-graph-parity-${input.context.actionIndex}`,
    command: input.action,
    beforeState,
    afterState: result.state,
  })
  const authority = result.state.extensions?.debugBattle?.authority
  const trace = result.trace
  const random = {
    rootSeed: trace?.rootSeed ?? authority?.rootSeed ?? input.context.seed,
    streams: trace?.randomStreams ?? [],
    cursors: authority?.runtimeCursors ?? {},
  }
  const actionLog = {
    actions: result.state.actions ?? [],
    authority: result.state.extensions?.debugBattle?.actionLog ?? [],
  }
  const viewerProjections = viewers.length > 0
    ? Object.fromEntries(viewers.map(viewer => [viewerKey(viewer), {
        battleState: toPublicBattleState(result.state, viewer),
        presentationEvents: projectBattlePresentationEventsForViewer(presentationEvents, viewer),
      }]))
    : undefined

  return {
    state: result.state,
    stateHash: result.stateHash,
    outcome: {
      accepted: true,
      duplicate: result.duplicate === true,
      actionHash: result.actionHash,
    },
    trace,
    random,
    actionLog,
    presentationEvents,
    pending: pendingState(result.state),
    viewerProjections,
  }
}

function createInitialState<TContent>(
  common: BattleState | (() => BattleState),
  variant: ContentGraphParityVariant<TContent>,
): BattleState {
  const initial = variant.createInitialState
    ? variant.createInitialState(variant.content)
    : typeof common === 'function' ? common() : common
  return safeCloneBattleState(initial)
}

async function executeVariant<TContent>(
  variant: ContentGraphParityVariant<TContent>,
  state: BattleState,
  action: BattleAction,
  context: ContentGraphParityExecutorContext<TContent>,
): Promise<ContentGraphParityExecution & { state: BattleState; executionError?: unknown }> {
  try {
    const value = await variant.execute({ state, action, context })
    if (isBattleState(value)) return { state: value }
    if (!value || typeof value !== 'object' || !isBattleState(value.state)) {
      throw new Error(`Parity executor ${variant.name} did not return a BattleState`)
    }
    return value
  } catch (error) {
    // Preserve the mutable state at the rejection boundary so the harness can
    // prove that both engines reject atomically without hiding the error.
    return { state, executionError: serializeError(error) }
  }
}

function snapshotExecution<TContent>(
  execution: ContentGraphParityExecution & { state: BattleState; executionError?: unknown },
  context: ContentGraphParityExecutorContext<TContent>,
  projectState?: ContentGraphParityOptions<unknown, unknown>['projectState'],
  projectStateHash?: ContentGraphParityOptions<unknown, unknown>['projectStateHash'],
): ContentGraphParitySnapshot {
  const stateContext = context as unknown as ContentGraphParityExecutorContext<unknown>
  const stateHash = projectStateHash
    ? projectStateHash(execution.state, stateContext)
    : execution.stateHash ?? hashBattleState(execution.state)
  const traceRecord = asRecord(execution.trace)
  const authority = asRecord(execution.state.extensions?.debugBattle?.authority)
  const random = execution.random ?? {
    rootSeed: traceRecord?.rootSeed ?? authority?.rootSeed ?? context.seed,
    streams: traceRecord?.randomStreams ?? [],
    cursors: authority?.runtimeCursors ?? {},
  }
  const actionLog = execution.actionLog ?? {
    actions: execution.state.actions ?? [],
    authority: execution.state.extensions?.debugBattle?.actionLog ?? [],
  }
  const pending = execution.pending ?? pendingState(execution.state)
  return {
    state: projectState ? projectState(execution.state, stateContext) : execution.state,
    stateHash,
    outcome: execution.outcome,
    trace: execution.trace,
    random,
    actionLog,
    presentationEvents: execution.presentationEvents,
    pending,
    viewerProjections: execution.viewerProjections,
    executionError: execution.executionError,
  }
}

function compareSnapshots(
  legacy: ContentGraphParitySnapshot,
  graph: ContentGraphParitySnapshot,
): ContentGraphParityDifference[] {
  const differences: ContentGraphParityDifference[] = []
  compareCategory(differences, 'execution', legacy.executionError, graph.executionError)
  compareCategory(differences, 'state', legacy.state, graph.state)
  compareCategory(differences, 'stateHash', legacy.stateHash, graph.stateHash)
  compareCategory(differences, 'outcome', legacy.outcome, graph.outcome)
  compareCategory(differences, 'trace', legacy.trace, graph.trace)
  compareCategory(differences, 'random', legacy.random, graph.random)
  compareCategory(differences, 'actionLog', legacy.actionLog, graph.actionLog)
  compareCategory(differences, 'presentationEvents', legacy.presentationEvents, graph.presentationEvents)
  compareCategory(differences, 'pending', legacy.pending, graph.pending)

  const legacyViewers = legacy.viewerProjections
  const graphViewers = graph.viewerProjections
  if (legacyViewers || graphViewers) {
    const viewerKeys = [...new Set([
      ...Object.keys(legacyViewers ?? {}),
      ...Object.keys(graphViewers ?? {}),
    ])].sort()
    for (const key of viewerKeys) {
      compareCategory(
        differences,
        `viewer:${key}`,
        legacyViewers?.[key],
        graphViewers?.[key],
      )
    }
  }
  return differences
}

function compareCategory(
  differences: ContentGraphParityDifference[],
  category: ContentGraphParityDifferenceCategory,
  legacy: unknown,
  graph: unknown,
): void {
  const difference = firstDifference(legacy, graph, '')
  if (difference) differences.push(toParityDifference(category, difference))
}

function toParityDifference(
  category: ContentGraphParityDifferenceCategory,
  difference: RawDifference,
): ContentGraphParityDifference {
  return {
    category,
    path: difference.path,
    legacy: difference.legacy,
    graph: difference.graph,
  }
}

type RawDifference = { path: string; legacy: unknown; graph: unknown }

function firstDifference(legacy: unknown, graph: unknown, path: string): RawDifference | undefined {
  if (Object.is(legacy, graph)) return undefined

  if (Array.isArray(legacy) || Array.isArray(graph)) {
    if (!Array.isArray(legacy) || !Array.isArray(graph)) return { path, legacy, graph }
    if (legacy.length !== graph.length) return { path: `${path}.length`.replace(/^\./, ''), legacy: legacy.length, graph: graph.length }
    for (let index = 0; index < legacy.length; index += 1) {
      const difference = firstDifference(legacy[index], graph[index], `${path}[${index}]`)
      if (difference) return difference
    }
    return undefined
  }

  if (isRecord(legacy) || isRecord(graph)) {
    if (!isRecord(legacy) || !isRecord(graph)) return { path, legacy, graph }
    const legacyKeys = Object.keys(legacy)
    const graphKeys = Object.keys(graph)
    const keys = [...new Set([...legacyKeys, ...graphKeys])].sort()
    for (const key of keys) {
      if (!(key in legacy) || !(key in graph)) {
        return {
          path: joinPath(path, key),
          legacy: key in legacy ? legacy[key] : '<missing>',
          graph: key in graph ? graph[key] : '<missing>',
        }
      }
      const difference = firstDifference(legacy[key], graph[key], joinPath(path, key))
      if (difference) return difference
    }
    return undefined
  }

  return { path, legacy, graph }
}

function pendingState(state: BattleState): unknown {
  return {
    option: state.pendingOptionSelection,
    target: state.pendingTargetSelection,
  }
}

function viewerKey(viewer: ContentGraphParityViewer): string {
  return viewer === undefined ? '<spectator>' : viewer
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}.${child}` : child
}

function isBattleState(value: unknown): value is BattleState {
  return isRecord(value)
    && Array.isArray(value.pieces)
    && isRecord(value.turn)
    && isRecord(value.map)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const record: Record<string, unknown> = { name: error.name, message: error.message }
    const code = (error as Error & { code?: unknown }).code
    if (code !== undefined) record.code = code
    return record
  }
  return error
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'bigint') return `${nested}n`
      if (typeof nested === 'function') return '[Function]'
      return nested
    }) ?? String(value)
  } catch {
    return String(value)
  }
}
