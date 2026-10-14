import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
} from './module-types'

/**
 * The old relation predicates are intentionally kept as compatibility
 * descriptors.  This migration turns them into the same field reads and
 * ordinary text comparison that new author graphs use.
 */
export type RelationReferenceKind = 'piece' | 'player'
export type RelationName = 'ally' | 'enemy'

export type RelationMigrationConflictReason =
  | 'legacy-v1-preserves-dead-references'
  | 'invalid-relation'
  | 'missing-input'

export type RelationMigrationConflict = {
  readonly callId: string
  readonly module: string
  readonly version: string
  readonly reason: RelationMigrationConflictReason
}

export type RelationMigrationChange = {
  readonly callId: string
  readonly fromModule: 'query.same-relation' | 'compare.allied-players'
  readonly fromVersion: string
  readonly relation: RelationName
  readonly referenceKind: RelationReferenceKind
  readonly fieldStrategy: 'piece-faction' | 'owner-player-faction' | 'player-faction'
  readonly generatedIds: readonly string[]
}

export type RelationMigrationOptions = {
  /**
   * `query.same-relation@1` includes pieces that are still present but dead.
   * Its default migration therefore reads piece.owner and then the player's
   * faction.  `attribute.text@2` is reserved for v2, whose living boundary is
   * explicit.  Callers can preserve a v1 node when its missing-piece false
   * result is itself a gameplay rule that must remain historical.
   */
  /** `migrate` uses piece.owner -> player faction so dead-but-present v1
   * references do not acquire the living requirement of attribute.text@2. */
  readonly legacyV1?: 'preserve' | 'migrate' | 'migrate-owner-faction'
  readonly shouldMigrateLegacyV1?: (call: GameplayCallStatement) => boolean
}

export type RelationMigrationResult = {
  readonly graph: GameplayModuleGraph
  readonly changes: readonly RelationMigrationChange[]
  readonly conflicts: readonly RelationMigrationConflict[]
}

type RelationCall = GameplayCallStatement & {
  readonly module: 'query.same-relation' | 'compare.allied-players'
}

const output = (node: string, port: string): GameplayValue => ({ kind: 'output', node, port })

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGameplayValue(value: unknown): value is GameplayValue {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'literal') return Object.prototype.hasOwnProperty.call(value, 'value')
  if (value.kind === 'input') return typeof value.name === 'string'
  return value.kind === 'output' && typeof value.node === 'string' && typeof value.port === 'string'
}

function sentenceLayout(owner: string, input: string): Readonly<Record<string, GameplayJsonValue>> {
  return { sentenceExpression: { owner, input } }
}

function fieldCall(
  id: string,
  module: 'attribute.text' | 'attribute.player-text',
  inputName: 'piece' | 'player',
  input: GameplayValue,
  owner: string,
  ownerInput: 'left' | 'right',
): GameplayCallStatement {
  return {
    kind: 'call',
    id,
    module,
    version: module === 'attribute.text' ? '2' : '1',
    inputs: { [inputName]: input },
    parameters: { attribute: 'faction' },
    layout: sentenceLayout(owner, ownerInput),
  }
}

function ownerCall(id: string, piece: GameplayValue): GameplayCallStatement {
  return {
    kind: 'call',
    id,
    module: 'piece.owner',
    version: '1',
    inputs: { piece },
  }
}

function finalCall(
  original: GameplayCallStatement,
  module: 'compare.text' | 'logic.not',
  inputs: Readonly<Record<string, GameplayValue>>,
): GameplayCallStatement {
  // Relation parameters are consumed by the recipe.  Keep every unrelated
  // statement property (including layout and future editor metadata), but do
  // not leave a stale relation parameter on a descriptor that does not accept
  // one.
  const next: Record<string, unknown> = { ...original, module, version: '1', inputs }
  delete next.parameters
  return next as GameplayCallStatement
}

function relationOf(call: RelationCall): RelationName | undefined {
  if (call.module === 'compare.allied-players') return 'ally'
  const value = call.parameters?.relation
  if (value === undefined) return 'enemy'
  return value === 'ally' || value === 'enemy' ? value : undefined
}

function inputOf(call: RelationCall, name: 'source' | 'target' | 'left' | 'right'): GameplayValue | undefined {
  const value = call.inputs?.[name]
  return isGameplayValue(value) ? value : undefined
}

function isRelationCall(call: GameplayCallStatement): call is RelationCall {
  return call.module === 'query.same-relation' || call.module === 'compare.allied-players'
}

function shouldMigrateV1(call: RelationCall, options: RelationMigrationOptions): boolean {
  if (call.module !== 'query.same-relation' || call.version !== '1') return true
  if (options.shouldMigrateLegacyV1) return options.shouldMigrateLegacyV1(call)
  return options.legacyV1 !== 'preserve'
}

function replacementFor(
  call: RelationCall,
  fresh: (suffix: string) => string,
  relation: RelationName,
): AtomicReplacement | undefined {
  const left = inputOf(call, call.module === 'compare.allied-players' ? 'left' : 'source')
  const right = inputOf(call, call.module === 'compare.allied-players' ? 'right' : 'target')
  if (!left || !right) return undefined

  const referenceKind: RelationReferenceKind = call.module === 'compare.allied-players' ? 'player' : 'piece'
  const legacyPieceOwner = call.module === 'query.same-relation' && call.version === '1'
  const fieldModule = referenceKind === 'player' || legacyPieceOwner ? 'attribute.player-text' : 'attribute.text'
  const fieldInputName: 'piece' | 'player' = referenceKind === 'player' || legacyPieceOwner ? 'player' : 'piece'
  const sourceNames = call.module === 'query.same-relation'
  const leftOwnerId = legacyPieceOwner ? fresh(sourceNames ? 'source-owner' : 'left-owner') : undefined
  const rightOwnerId = legacyPieceOwner ? fresh(sourceNames ? 'target-owner' : 'right-owner') : undefined
  const leftFieldId = fresh(sourceNames ? 'source-faction' : 'left-faction')
  const rightFieldId = fresh(sourceNames ? 'target-faction' : 'right-faction')
  const compareId = relation === 'enemy' ? fresh('compare') : call.id
  const leftFieldInput = leftOwnerId ? output(leftOwnerId, 'player') : left
  const rightFieldInput = rightOwnerId ? output(rightOwnerId, 'player') : right
  const leftField = fieldCall(leftFieldId, fieldModule, fieldInputName, leftFieldInput, compareId, 'left')
  const rightField = fieldCall(rightFieldId, fieldModule, fieldInputName, rightFieldInput, compareId, 'right')
  const compareOriginal: GameplayCallStatement = { ...call, id: compareId }
  if (relation === 'enemy') delete (compareOriginal as { layout?: unknown }).layout
  const compare = finalCall(compareOriginal, 'compare.text', {
    left: output(leftFieldId, 'text'),
    right: output(rightFieldId, 'text'),
  })

  const statements: GameplayStatement[] = [
    ...(leftOwnerId ? [ownerCall(leftOwnerId, left)] : []),
    ...(rightOwnerId ? [ownerCall(rightOwnerId, right)] : []),
    leftField,
    rightField,
    compare,
  ]
  if (relation === 'enemy') {
    statements.push(finalCall(call, 'logic.not', { value: output(compareId, 'value') }))
  }
  return {
    statements,
    // Keep the legacy node id and output port as the final value.  The generic
    // rewriter then also rewires references in later lexical statements when a
    // recipe ever chooses a different final id.
    outputs: { value: output(call.id, 'value') },
  }
}

/**
 * Create a recipe for callers that need to compose this migration with other
 * atomic rewrites.  V1 conflicts are reported through the supplied callback;
 * the standalone graph helper below is usually more convenient.
 */
export function createRelationMigrationRecipe(
  options: RelationMigrationOptions = {},
  onConflict?: (conflict: RelationMigrationConflict) => void,
  onChange?: (change: RelationMigrationChange) => void,
): AtomicRecipe {
  return (call, fresh) => {
    if (!isRelationCall(call)) return undefined
    const relation = relationOf(call)
    if (!relation) {
      onConflict?.({ callId: call.id, module: call.module, version: call.version, reason: 'invalid-relation' })
      return undefined
    }
    if (!shouldMigrateV1(call, options)) {
      onConflict?.({ callId: call.id, module: call.module, version: call.version, reason: 'legacy-v1-preserves-dead-references' })
      return undefined
    }

    const expectedLeft = call.module === 'compare.allied-players' ? 'left' : 'source'
    const expectedRight = call.module === 'compare.allied-players' ? 'right' : 'target'
    if (!inputOf(call, expectedLeft) || !inputOf(call, expectedRight)) {
      onConflict?.({ callId: call.id, module: call.module, version: call.version, reason: 'missing-input' })
      return undefined
    }
    const replacement = replacementFor(call, fresh, relation)
    if (!replacement) return undefined
    const generatedIds = replacement.statements
      .filter(statement => statement.id !== call.id)
      .map(statement => statement.id)
    onChange?.({
      callId: call.id,
      fromModule: call.module,
      fromVersion: call.version,
      relation,
      referenceKind: call.module === 'compare.allied-players' ? 'player' : 'piece',
      fieldStrategy: call.module === 'compare.allied-players'
        ? 'player-faction'
        : call.version === '1' ? 'owner-player-faction' : 'piece-faction',
      generatedIds,
    })
    return replacement
  }
}

/** Rewrite every graph scope, including branches, composites, and continuations. */
export function migrateRelationModules(
  graph: GameplayModuleGraph,
  options: RelationMigrationOptions = {},
): RelationMigrationResult {
  const changes: RelationMigrationChange[] = []
  const conflicts: RelationMigrationConflict[] = []
  const recipe = createRelationMigrationRecipe(options, conflict => conflicts.push(conflict), change => changes.push(change))
  return { graph: rewriteAtomicGraph(graph, recipe), changes, conflicts }
}

export const migrateRelationGraph = migrateRelationModules
export const migrateAtomicRelationGraph = migrateRelationModules
