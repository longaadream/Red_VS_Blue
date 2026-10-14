/* eslint-disable @typescript-eslint/no-explicit-any -- adapts existing SkillCode host contexts. */
import type { BattleState } from './turn'
import type { PieceInstance } from './piece'
import { areMatchAllies } from './match-teams'
import { hashStable } from './battle-trace'
import { getActiveSuspendableActionRuntime, SuspendableActionRuntime, SuspendableActionReplayError, type SuspendableInteractionPrompt } from './suspendable-action-transaction'

/** Stops only the current content entry; the containing event can continue. */
const authorChoiceCancellations = new WeakSet<object>()
export class AuthorChoiceCancelled extends Error {
  constructor() { super('Author selection cancelled'); this.name = 'AuthorChoiceCancelled'; authorChoiceCancellations.add(this) }
}

/** Inspect identity without invoking user-defined prototype or property traps. */
export function isAuthorChoiceCancelled(value: unknown): value is AuthorChoiceCancelled {
  return typeof value === 'object' && value !== null && authorChoiceCancellations.has(value)
}

export function createAuthorChoiceRuntime(battle: BattleState, context: any, surface: string, holder: () => PieceInstance | undefined) {
  let optionIndex = 0
  let targetIndex = 0
  const identity = (callId: string, selectingPlayer?: string) => {
    if (typeof callId !== 'string' || !callId) throw new Error('flow: 选择语句缺少标识')
    const source = holder()
    const playerId = selectingPlayer ?? source?.ownerPlayerId ?? context.playerId
    if (!battle.players.some(player => player.playerId === playerId)) throw new Error('flow: 选择缺少有效玩家')
    const runtime = getActiveSuspendableActionRuntime() ?? new SuspendableActionRuntime([])
    const consumerKind = surface === 'card' ? 'card' : surface === 'rule' || surface === 'triggerSkill' ? 'rule' : 'skill'
    const key = runtime.enterConsumer({
      consumerKind,
      consumerId: String(context.ruleId ?? context.skill?.id ?? context.card?.id ?? 'author'),
      sourceId: source?.instanceId,
      eventType: JSON.stringify([context.type ?? '', callId]),
    })
    return { runtime, key, source, playerId }
  }
  const cancelled = (input: { cancelled?: boolean } | undefined) => {
    if (input?.cancelled) throw new AuthorChoiceCancelled()
  }
  return {
    option(config: { options: Array<{ label: string; value: unknown }>; title?: string; canCancel?: boolean; playerId?: string; selectionMode?: 'single' | 'multi'; minSelections?: number; maxSelections?: number; indexed?: boolean; cancelValue?: unknown }, callId: string): unknown {
      const multi = config.selectionMode === 'multi'
      const minimum = Math.floor(config.minSelections ?? 1)
      const maximum = Math.floor(config.maxSelections ?? 1)
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || maximum > 64 || !multi && (minimum !== 1 || maximum !== 1)) throw new Error('flow: 选项数量范围无效')
      if (!Array.isArray(config.options) || config.options.length > 64
        || config.options.some(option => !option || typeof option.label !== 'string' || option.value === undefined)) throw new Error('flow: 选项映射无效')
      if (config.options.length < minimum) throw new AuthorChoiceCancelled()
      if (multi && (maximum === 0 || config.options.length === 0)) return []
      // Indexed transport identifies the OPTION, not its value. Two labels
      // may intentionally return equal values; both must remain selectable.
      const transportOptions = config.indexed ? config.options.map((option, index) => ({ label: option.label, value: { authorOptionIndex: index + 1 } })) : config.options
      const currentIndex = optionIndex++
      const { runtime, key, source, playerId } = identity(callId, config.playerId)
      const answer = runtime.takeAnswer(key)
      if (answer?.cancelled && config.canCancel === true && Object.prototype.hasOwnProperty.call(config, 'cancelValue')) return config.cancelValue
      cancelled(answer)
      // A predeclared target sequence can already have supplied the first
      // option. It must never be reused for a second authored selection.
      const prepared = currentIndex === 0 && (surface === 'skill' || surface === 'card') && context.selectedOption !== undefined
      const selected = answer ? answer.selectedOption : prepared ? context.selectedOption : undefined
      if (selected !== undefined) {
        const selectedValues = multi ? selected : [selected]
        if (!Array.isArray(selectedValues) || selectedValues.length < minimum || selectedValues.length > maximum) throw new SuspendableActionReplayError('Selected author option count is outside its bounds')
        const indices = selectedValues.map(value => transportOptions.findIndex(option => hashStable(option.value) === hashStable(value)))
        if (indices.some(index => index < 0) || new Set(indices).size !== indices.length) throw new SuspendableActionReplayError('Selected author option is duplicate or not in the current candidate map')
        const values = indices.map(index => config.options[index].value)
        return multi ? values : values[0]
      }
      return runtime.suspend(key, { kind: 'option', playerId, title: config.title ?? '请选择', options: transportOptions,
        ...(config.selectionMode ? { selectionMode: config.selectionMode, minSelections: minimum, maxSelections: Math.min(maximum, config.options.length) } : {}),
        ...(Object.prototype.hasOwnProperty.call(config, 'cancelValue') ? { cancelValue: config.cancelValue, resumeOnCancel: true } : {}),
        canCancel: config.canCancel === true, sourcePieceId: source?.instanceId, suspendedTurn: { ...battle.turn } })
    },
    target(spec: { type: 'piece' | 'grid'; range?: number; filter?: 'enemy' | 'ally' | 'all'; title?: string; canCancel?: boolean; requireWalkable?: boolean; requireUnoccupied?: boolean }, callId: string): unknown {
      const currentIndex = targetIndex++
      const { runtime, key, source, playerId } = identity(callId)
      const range = spec.range ?? 5
      if (!source || source.currentHp <= 0 || source.x == null || source.y == null) throw new Error('flow: 选择中心棋子已失效')
      if (!['piece', 'grid'].includes(spec.type) || !['enemy', 'ally', 'all'].includes(spec.filter ?? 'all') || !Number.isFinite(range) || range < 0) throw new Error('flow: 目标选择条件无效')
      const declared = context.skill?.targeting?.steps?.filter((step: any) => step.kind === 'target')?.[currentIndex]
      const distance = (x: number, y: number) => declared?.distanceMetric === 'chebyshev'
        ? Math.max(Math.abs(source.x! - x), Math.abs(source.y! - y))
        : Math.abs(source.x! - x) + Math.abs(source.y! - y)
      const minRange = declared?.minRange ?? (range === 0 ? 0 : 1)
      const inRange = (x: number, y: number) => distance(x, y) >= minRange && distance(x, y) <= range
      const candidates = spec.type === 'piece'
        ? battle.pieces.filter(piece => piece.currentHp > 0 && piece.x != null && piece.y != null && inRange(piece.x, piece.y)
          && ((spec.filter ?? 'all') === 'all' || areMatchAllies(battle, piece.ownerPlayerId, playerId) === (spec.filter === 'ally')))
          .map(piece => ({ type: 'piece' as const, pieceId: piece.instanceId }))
        : battle.map.tiles.filter(tile => inRange(tile.x, tile.y)
          && (spec.requireWalkable === false || tile.props.walkable)
          && (spec.requireUnoccupied === false || !battle.pieces.some(piece => piece.currentHp > 0 && piece.x === tile.x && piece.y === tile.y)))
          .map(tile => ({ type: 'cell' as const, x: tile.x, y: tile.y }))
      const answer = runtime.takeAnswer(key)
      cancelled(answer)
      const slot = (surface === 'skill' || surface === 'card') ? context.targets?.[currentIndex] : undefined
      const selected = answer?.selectedTargets?.[0] as any
      const preparedTarget = slot?.info ?? (currentIndex === 0 && surface === 'skill' ? context.target : undefined)
      const preparedCell = slot?.pos ?? (currentIndex === 0 && (surface === 'skill' || surface === 'card') ? context.targetPosition : undefined)
      const id = answer?.targetPieceId ?? selected?.pieceId ?? preparedTarget?.instanceId
      const x = answer?.targetX ?? selected?.x ?? preparedCell?.x
      const y = answer?.targetY ?? selected?.y ?? preparedCell?.y
      if (spec.type === 'piece' && id !== undefined) {
        const rewritten = currentIndex === 0 && context.ruleRewrittenPrimaryTargetPieceId === id
        const target = battle.pieces.find(piece => piece.instanceId === id && piece.currentHp > 0)
        if (target && (rewritten || candidates.some(candidate => candidate.type === 'piece' && candidate.pieceId === id))) return target.instanceId
        throw new SuspendableActionReplayError('Selected author target is no longer legal')
      }
      if (spec.type === 'grid' && (x !== undefined || y !== undefined)) {
        if (candidates.some(candidate => candidate.type === 'cell' && candidate.x === x && candidate.y === y)) return { x, y }
        throw new SuspendableActionReplayError('Selected author cell is no longer legal')
      }
      if (!candidates.length) throw new AuthorChoiceCancelled()
      const prompt: SuspendableInteractionPrompt = { kind: 'target', playerId, title: spec.title ?? '请选择目标',
        targetType: spec.type === 'grid' ? 'cell' : 'piece', range, filter: spec.filter ?? 'all', candidates,
        selectionMode: 'single', minSelections: 1, maxSelections: 1, canCancel: spec.canCancel === true,
        rollbackOnCancel: surface === 'skill' || surface === 'card', sourcePieceId: source.instanceId,
        suspendedTurn: { ...battle.turn }, candidateState: battle }
      return runtime.suspend(key, prompt)
    },
  }
}
