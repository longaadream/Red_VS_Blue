import { getGameplayModule } from './module-registry'
import type {
  GameplayCallStatement,
  GameplayIfStatement,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
} from './module-types'

/** Author guards whose invalid-reference handling belongs to the engine. */
export type AuthorGuardModule = 'query.has-piece' | 'query.has-piece-id' | 'query.has-player' | 'piece.alive'

export type GuardMigrationReason =
  | 'unbound-guard'
  | 'missing-guard-input'
  | 'guard-output-used-elsewhere'
  | 'alive-boundary-not-proven'
  | 'fallback-has-else-branch'
  | 'fallback-missing-return'
  | 'fallback-has-non-pure-call'
  | 'fallback-success-path'
  | 'no-following-statements'
  | 'body-uses-guard-result'
  | 'body-has-independent-work'

export type GuardMigrationChangeKind = 'remove-defensive-fallback' | 'unwrap-dependent-guard' | 'promote-valid-branch'

export type GuardMigrationChange = {
  readonly kind: GuardMigrationChangeKind
  readonly callId: string
  readonly module: AuthorGuardModule
  readonly ifId: string
  readonly scope: string
}

export type GuardMigrationRetention = {
  readonly callId: string
  readonly module: AuthorGuardModule
  readonly ifId?: string
  readonly scope: string
  readonly reason: GuardMigrationReason
}

export type GuardMigrationReport = {
  /** Counts are collected before rewriting and include every graph scope. */
  readonly scannedGuardCalls: number
  readonly guardedIfs: number
  readonly missingChecks: number
  readonly validChecks: number
  readonly unboundGuards: number
  readonly changes: readonly GuardMigrationChange[]
  readonly retained: readonly GuardMigrationRetention[]
}

export type GuardMigrationResult = {
  readonly graph: GameplayModuleGraph
  readonly changes: readonly GuardMigrationChange[]
  readonly retained: readonly GuardMigrationRetention[]
  readonly report: GuardMigrationReport
}

type GuardCall = GameplayCallStatement & { readonly module: AuthorGuardModule }
type ScopeState = {
  readonly changes: GuardMigrationChange[]
  readonly retained: GuardMigrationRetention[]
  scannedGuardCalls: number
  guardedIfs: number
  missingChecks: number
  validChecks: number
  unboundGuards: number
}

const GUARD_MODULES = new Set<AuthorGuardModule>(['query.has-piece', 'query.has-piece-id', 'query.has-player', 'piece.alive'])

function isGuardCall(statement: GameplayStatement | undefined): statement is GuardCall {
  return statement?.kind === 'call' && GUARD_MODULES.has(statement.module as AuthorGuardModule)
}

function isOutput(value: unknown): value is Extract<GameplayValue, { readonly kind: 'output' }> {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'output'
    && typeof (value as { node?: unknown }).node === 'string'
    && typeof (value as { port?: unknown }).port === 'string'
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]))
}

function collectOutputReferences(value: unknown, references: string[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach(item => collectOutputReferences(item, references))
    return
  }
  if ((value as { kind?: unknown }).kind === 'literal') return
  if (isOutput(value)) {
    references.push(value.node)
    return
  }
  Object.values(value).forEach(item => collectOutputReferences(item, references))
}

function countReferences(statements: readonly GameplayStatement[]): ReadonlyMap<string, number> {
  const references: string[] = []
  collectOutputReferences(statements, references)
  const counts = new Map<string, number>()
  for (const node of references) counts.set(node, (counts.get(node) ?? 0) + 1)
  return counts
}

function guardInput(call: GuardCall): GameplayValue | undefined {
  const key = call.module === 'query.has-piece-id' ? 'id' : call.module === 'query.has-piece'
    ? 'pieceId'
    : call.module === 'query.has-player' ? 'playerId' : 'piece'
  const value = call.inputs?.[key]
  return value && typeof value === 'object' && typeof value.kind === 'string' ? value : undefined
}

function allStatements(statement: GameplayStatement, visit: (value: GameplayStatement) => void): void {
  visit(statement)
  if (statement.kind === 'if') {
    statement.then.forEach(child => allStatements(child, visit))
    statement.else?.forEach(child => allStatements(child, visit))
  } else if (statement.kind === 'foreach' || statement.kind === 'while') {
    statement.body.forEach(child => allStatements(child, visit))
    if (statement.kind === 'while') statement.condition.body.forEach(child => allStatements(child, visit))
  } else if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.reduce') {
    statement.body.forEach(child => allStatements(child, visit))
  }
}

function hasReferenceTo(statements: readonly GameplayStatement[], node: string): boolean {
  const references: string[] = []
  statements.forEach(statement => collectOutputReferences(statement, references))
  return references.includes(node)
}

function isFailureReturn(statement: GameplayStatement, body: readonly GameplayStatement[]): boolean {
  if (statement.kind !== 'return') return false
  const success = statement.values?.success
  if (success?.kind === 'literal' && success.value === false) return true

  const returnedNodes: string[] = []
  collectOutputReferences(statement.values ?? statement.value, returnedNodes)
  if (returnedNodes.length === 0) return false
  const calls = new Map<string, GameplayCallStatement>()
  body.forEach(item => allStatements(item, nested => {
    if (nested.kind === 'call') calls.set(nested.id, nested)
  }))
  return returnedNodes.some(node => {
    const call = calls.get(node)
    if (!call || (call.module !== 'result.action' && call.module !== 'result.message')) return false
    const value = call.inputs?.success
    if (value?.kind === 'literal' && value.value === false) return true
    return call.module === 'result.message' && call.parameters?.success === false
  })
}

function isPureFallbackCall(statement: GameplayStatement): boolean {
  if (statement.kind !== 'call') return false
  const descriptor = getGameplayModule(statement.module, statement.version)
  const effects = descriptor?.effects
  return !!effects && effects.pure === true && !effects.writes?.length && !effects.events?.length && !effects.random && !effects.pending
}

function defensiveFallback(body: readonly GameplayStatement[]): GuardMigrationReason | undefined {
  const last = body[body.length - 1]
  if (!last || last.kind !== 'return' || !isFailureReturn(last, body)) return 'fallback-missing-return'
  for (const statement of body.slice(0, -1)) {
    if (!isPureFallbackCall(statement)) return 'fallback-has-non-pure-call'
  }
  return undefined
}

type DependencyContext = {
  readonly anchors: readonly GameplayValue[]
  readonly nodes: Set<string>
}

function valueDepends(value: unknown, context: DependencyContext): boolean {
  if (!value || typeof value !== 'object') return false
  if ((value as { kind?: unknown }).kind === 'literal') return false
  if (context.anchors.some(anchor => sameValue(anchor, value))) return true
  if (isOutput(value) && context.nodes.has(value.node)) return true
  return false
}

function valuesDepend(values: unknown, context: DependencyContext): boolean {
  if (!values || typeof values !== 'object') return false
  if (Array.isArray(values)) return values.some(value => valuesDepend(value, context))
  if ((values as { kind?: unknown }).kind) return valueDepends(values, context)
  return Object.values(values).some(value => valuesDepend(value, context))
}

function sequenceDepends(statements: readonly GameplayStatement[], context: DependencyContext): boolean {
  return statements.every(statement => statementDepends(statement, context))
}

/**
 * A `piece.alive` check can only disappear when every stateful operation that
 * depends on the guarded piece advertises the engine's living-reference
 * boundary.  Pure reads are allowed to continue through a dead piece because
 * death-event graphs are allowed to inspect historical state.  Unknown
 * descriptors and stateful calls without the metadata are retained and
 * reported instead of assuming that a runtime implementation happens to
 * reject HP-zero references.
 */
function livingBoundaryProven(
  statements: readonly GameplayStatement[],
  input: GameplayValue,
  guardId: string,
): boolean {
  const context: DependencyContext = { anchors: [input], nodes: new Set([guardId]) }
  let proven = true
  let boundaryWitness = false

  const inspect = (statement: GameplayStatement): void => {
    if (statement.kind === 'call') {
      const dependentInputs = Object.entries(statement.inputs ?? {})
        .filter(([, value]) => valuesDepend(value, context))
        .map(([name]) => name)
      if (dependentInputs.length > 0) {
        const descriptor = getGameplayModule(statement.module, statement.version)
        const effects = descriptor?.effects
        const living = new Set(descriptor?.livingReferences ?? [])
        if (dependentInputs.some(name => living.has(name))) boundaryWitness = true
        if (!effects || (effects.pure !== true && dependentInputs.some(name => !living.has(name)))) proven = false
        context.nodes.add(statement.id)
      }
      return
    }
    if (statement.kind === 'record.create') {
      if (valuesDepend(statement.fields, context)) context.nodes.add(statement.id)
      return
    }
    if (statement.kind === 'record.get') {
      if (valueDepends(statement.record, context)) context.nodes.add(statement.id)
      return
    }
    if (statement.kind === 'record.with') {
      if (valueDepends(statement.record, context) || valuesDepend(statement.fields, context)) context.nodes.add(statement.id)
      return
    }
    if (statement.kind === 'if') {
      statement.then.forEach(inspect)
      statement.else?.forEach(inspect)
      return
    }
    if (statement.kind === 'foreach') {
      statement.body.forEach(inspect)
      return
    }
    if (statement.kind === 'while') {
      statement.condition.body.forEach(inspect)
      statement.body.forEach(inspect)
      return
    }
    if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.reduce') {
      statement.body.forEach(inspect)
    }
  }

  statements.forEach(inspect)
  return proven && boundaryWitness
}

function statementDepends(statement: GameplayStatement, context: DependencyContext): boolean {
  if (statement.kind === 'call') {
    const depends = valuesDepend(statement.inputs, context)
    if (depends) context.nodes.add(statement.id)
    return depends
  }
  if (statement.kind === 'record.create') {
    const depends = valuesDepend(statement.fields, context)
    if (depends) context.nodes.add(statement.id)
    return depends
  }
  if (statement.kind === 'record.get') {
    const depends = valueDepends(statement.record, context)
    if (depends) context.nodes.add(statement.id)
    return depends
  }
  if (statement.kind === 'record.with') {
    const depends = valueDepends(statement.record, context) || valuesDepend(statement.fields, context)
    if (depends) context.nodes.add(statement.id)
    return depends
  }
  if (statement.kind === 'return') return valuesDepend(statement.values ?? statement.value, context)
  if (statement.kind === 'defer-choice') return valuesDepend(statement, context)
  if (statement.kind === 'if') {
    const thenDepends = sequenceDepends(statement.then, context)
    const elseDepends = !statement.else || sequenceDepends(statement.else, context)
    return thenDepends && elseDepends
  }
  if (statement.kind === 'foreach') {
    if (!valueDepends(statement.items, context)) return false
    context.nodes.add(statement.id)
    return sequenceDepends(statement.body, context)
  }
  if (statement.kind === 'while') {
    const conditionDepends = valuesDepend(statement.condition.inputs, context)
    if (conditionDepends) context.nodes.add(statement.id)
    return conditionDepends && sequenceDepends(statement.condition.body, context) && sequenceDepends(statement.body, context)
  }
  if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.reduce') {
    if (!valueDepends(statement.items, context) && !valuesDepend(statement.inputs, context)) return false
    context.nodes.add(statement.id)
    return sequenceDepends(statement.body, context)
  }
  return false
}

function guardOutputPort(call: GuardCall): string {
  return call.module === 'piece.alive' ? 'alive' : 'exists'
}

type GuardCandidate =
  | { readonly kind: 'missing'; readonly guard: GuardCall; readonly not: GameplayCallStatement; readonly branch: GameplayIfStatement; readonly end: number }
  | { readonly kind: 'valid'; readonly guard: GuardCall; readonly branch: GameplayIfStatement; readonly end: number }

type PromotedBranch = {
  readonly statements: readonly GameplayStatement[]
  readonly scopePart: 'then' | 'else'
}

function promotedBranch(candidate: GuardCandidate): PromotedBranch | undefined {
  const failure = candidate.kind === 'missing' ? candidate.branch.then : candidate.branch.else
  const success = candidate.kind === 'missing' ? candidate.branch.else : candidate.branch.then
  if (!failure || !success || success.length === 0) return undefined
  return defensiveFallback(failure) ? undefined : {
    statements: success,
    scopePart: candidate.kind === 'missing' ? 'else' : 'then',
  }
}

function candidateAt(statements: readonly GameplayStatement[], index: number): GuardCandidate | undefined {
  const guard = statements[index]
  if (!isGuardCall(guard)) return undefined
  const next = statements[index + 1]
  const afterNext = statements[index + 2]
  if (next?.kind === 'call' && next.module === 'logic.not' && afterNext?.kind === 'if'
    && isOutput(afterNext.condition) && afterNext.condition.node === next.id && afterNext.condition.port === 'value'
    && isOutput(next.inputs?.value) && next.inputs?.value.node === guard.id && next.inputs?.value.port === guardOutputPort(guard)) {
    return { kind: 'missing', guard, not: next, branch: afterNext, end: index + 2 }
  }
  if (next?.kind === 'if' && isOutput(next.condition) && next.condition.node === guard.id && next.condition.port === guardOutputPort(guard)) {
    return { kind: 'valid', guard, branch: next, end: index + 1 }
  }
  return undefined
}

function addRetention(state: ScopeState, item: GuardMigrationRetention): void {
  state.retained.push(item)
}

function changeFor(state: ScopeState, candidate: GuardCandidate, kind: GuardMigrationChangeKind, scope: string): void {
  state.changes.push({ kind, callId: candidate.guard.id, module: candidate.guard.module, ifId: candidate.branch.id, scope })
}

function rewriteSequence(statements: readonly GameplayStatement[], scope: string, state: ScopeState): GameplayStatement[] {
  const result: GameplayStatement[] = []
  // References are lexical: a same-named node in a sibling composite or
  // continuation must not keep this scope's guard alive.
  const references = countReferences(statements)
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    if (isGuardCall(statement)) state.scannedGuardCalls += 1
    const candidate = candidateAt(statements, index)
    if (candidate) {
      state.guardedIfs += 1
      if (candidate.kind === 'missing') state.missingChecks += 1
      else state.validChecks += 1

      const expectedGuardReferences = candidate.kind === 'missing' ? 1 : 1
      let reason: GuardMigrationReason | undefined
      let promoted: PromotedBranch | undefined
      if (!guardInput(candidate.guard)) reason = 'missing-guard-input'
      else if ((references.get(candidate.guard.id) ?? 0) !== expectedGuardReferences || (candidate.kind === 'missing' && (references.get(candidate.not.id) ?? 0) !== 1)) reason = 'guard-output-used-elsewhere'

      if (!reason && candidate.kind === 'missing') {
        if (candidate.branch.else && candidate.branch.else.length > 0) {
          promoted = promotedBranch(candidate)
          if (!promoted) reason = 'fallback-has-else-branch'
        } else {
          reason = defensiveFallback(candidate.branch.then)
          if (!reason && index + 3 >= statements.length) reason = 'no-following-statements'
          if (!reason && candidate.guard.module === 'piece.alive'
            && !livingBoundaryProven(statements.slice(candidate.end + 1), guardInput(candidate.guard)!, candidate.guard.id)) {
            reason = 'alive-boundary-not-proven'
          }
        }
        if (!reason && promoted && candidate.guard.module === 'piece.alive'
          && !livingBoundaryProven(promoted.statements, guardInput(candidate.guard)!, candidate.guard.id)) reason = 'alive-boundary-not-proven'
      }

      if (!reason && candidate.kind === 'valid') {
        if (hasReferenceTo(candidate.branch.then, candidate.guard.id)) reason = 'body-uses-guard-result'
        else if (candidate.branch.else && candidate.branch.else.length > 0) {
          promoted = promotedBranch(candidate)
          if (!promoted) reason = 'fallback-has-else-branch'
          else if (candidate.guard.module === 'piece.alive'
            && !livingBoundaryProven(promoted.statements, guardInput(candidate.guard)!, candidate.guard.id)) reason = 'alive-boundary-not-proven'
        } else {
          const context: DependencyContext = { anchors: [guardInput(candidate.guard)!], nodes: new Set([candidate.guard.id]) }
          if (!sequenceDepends(candidate.branch.then, context)) reason = 'body-has-independent-work'
          else if (candidate.guard.module === 'piece.alive'
            && !livingBoundaryProven(candidate.branch.then, guardInput(candidate.guard)!, candidate.guard.id)) reason = 'alive-boundary-not-proven'
        }
      }

      if (reason) {
        addRetention(state, { callId: candidate.guard.id, module: candidate.guard.module, ifId: candidate.branch.id, scope, reason })
      } else if (promoted) {
        changeFor(state, candidate, 'promote-valid-branch', scope)
        result.push(...rewriteSequence(promoted.statements, `${scope}/${candidate.branch.id}.${promoted.scopePart}`, state))
        index = candidate.end
        continue
      } else if (candidate.kind === 'missing') {
        changeFor(state, candidate, 'remove-defensive-fallback', scope)
        index = candidate.end
        continue
      } else {
        changeFor(state, candidate, 'unwrap-dependent-guard', scope)
        result.push(...rewriteSequence(candidate.branch.then, `${scope}/${candidate.branch.id}.then`, state))
        index = candidate.end
        continue
      }
    } else if (isGuardCall(statement)) {
      state.unboundGuards += 1
      addRetention(state, { callId: statement.id, module: statement.module, scope, reason: 'unbound-guard' })
    }
    result.push(rewriteStatement(statement, `${scope}/${statement.id}`, state))
  }
  return result
}

function rewriteStatement(statement: GameplayStatement, scope: string, state: ScopeState): GameplayStatement {
  if (statement.kind === 'if') {
    return {
      ...statement,
      then: rewriteSequence(statement.then, `${scope}.then`, state),
      ...(statement.else ? { else: rewriteSequence(statement.else, `${scope}.else`, state) } : {}),
    }
  }
  if (statement.kind === 'foreach') return { ...statement, body: rewriteSequence(statement.body, `${scope}.body`, state) }
  if (statement.kind === 'while') {
    return {
      ...statement,
      condition: { ...statement.condition, body: rewriteSequence(statement.condition.body, `${scope}.condition`, state) },
      body: rewriteSequence(statement.body, `${scope}.body`, state),
    }
  }
  if (statement.kind === 'collection' || statement.kind === 'collection.map' || statement.kind === 'collection.filter' || statement.kind === 'collection.reduce') {
    return { ...statement, body: rewriteSequence(statement.body, `${scope}.body`, state) }
  }
  return statement
}

function rewriteGraph(graph: GameplayModuleGraph, state: ScopeState, scope: string): GameplayModuleGraph {
  return {
    ...graph,
    body: rewriteSequence(graph.body, `${scope}.body`, state),
    ...(graph.composites ? { composites: graph.composites.map(composite => ({ ...composite, body: rewriteSequence(composite.body, `${scope}.composite:${composite.id}`, state) })) } : {}),
    ...(graph.continuations ? { continuations: graph.continuations.map(continuation => ({ ...continuation, graph: rewriteGraph(continuation.graph, state, `${scope}.continuation:${continuation.id}`) })) } : {}),
  }
}

/** Remove proven defensive existence/survival fallbacks and report the rest. */
export function migrateAuthorGuards(graph: GameplayModuleGraph): GuardMigrationResult {
  const state: ScopeState = {
    changes: [],
    retained: [],
    scannedGuardCalls: 0,
    guardedIfs: 0,
    missingChecks: 0,
    validChecks: 0,
    unboundGuards: 0,
  }
  const rewritten = rewriteGraph(graph, state, graph.surface)
  const report: GuardMigrationReport = {
    scannedGuardCalls: state.scannedGuardCalls,
    guardedIfs: state.guardedIfs,
    missingChecks: state.missingChecks,
    validChecks: state.validChecks,
    unboundGuards: state.unboundGuards,
    changes: state.changes,
    retained: state.retained,
  }
  return { graph: rewritten, changes: state.changes, retained: state.retained, report }
}

export const migrateDefensiveGuards = migrateAuthorGuards
export const migrateAtomicGuardGraph = migrateAuthorGuards
