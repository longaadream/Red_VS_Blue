import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayLiteral,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

const nullableNumber: GameplayValueType = { kind: 'nullable', value: 'number' }
const nullableString: GameplayValueType = { kind: 'nullable', value: 'string' }
const listChoice: GameplayValueType = { kind: 'list', element: 'choice' }

/** Compatibility module IDs lowered by this recipe. */
export const ATOMIC_REMAINING_PREDICATE_MODULES = new Set([
  'rule.authorized-by-owner',
  'piece.has-position',
  'spatial.has-position',
  'choice.array-has-duplicate',
  'choice.array-length',
  'ability.was-spent',
  'skill.identifiers',
  'collection.single-piece-list',
  'value.number-or-zero',
  'text.strip-leading-comma',
])

/** Alias used by catalogs that expose retired compatibility IDs. */
export const ATOMIC_REMAINING_PREDICATE_MODULE_IDS = ATOMIC_REMAINING_PREDICATE_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const literal = (value: GameplayLiteral): GameplayValue => ({ kind: 'literal', value })

function requiredInput(call: GameplayCallStatement, name: string): GameplayValue | undefined {
  const value = call.inputs?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'input') return typeof record.name === 'string' && record.name.length > 0 ? value : undefined
  if (record.kind === 'output') {
    return typeof record.node === 'string' && record.node.length > 0 && typeof record.port === 'string' && record.port.length > 0
      ? value
      : undefined
  }
  return record.kind === 'literal' && Object.prototype.hasOwnProperty.call(record, 'value') ? value : undefined
}

function generatedCall(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  return {
    kind: 'call', id, module, version, inputs,
    ...(parameters === undefined ? {} : { parameters }),
  }
}

/** Preserve editor metadata on the final replacement node. */
function replaceCall(
  original: GameplayCallStatement,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>>,
  parameters?: Readonly<Record<string, GameplayJsonValue>>,
  version = '1',
): GameplayCallStatement {
  const next: Record<string, unknown> = { ...original, module, version, inputs }
  if (parameters === undefined) delete next.parameters
  else next.parameters = parameters
  return next as GameplayCallStatement
}

function valueTypeParameter(type: GameplayValueType): GameplayLiteral {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

function fieldRead(id: string, value: GameplayValue, field: 'x' | 'y'): GameplayCallStatement {
  return generatedCall(id, 'piece.optional-field', { piece: value }, { field, valueType: 'number' })
}

function pieceFieldRead(id: string, value: GameplayValue, field: string): GameplayCallStatement {
  return generatedCall(id, 'piece.field', { piece: value }, { field })
}

function compare(
  id: string,
  left: GameplayValue,
  right: GameplayValue,
  type: GameplayValueType,
  operator: '==' | '!=' = '==',
): GameplayCallStatement {
  return generatedCall(id, 'compare.values', { left, right }, {
    valueType: valueTypeParameter(type), operator,
  })
}

function logic(id: string, module: 'logic.and' | 'logic.or', left: GameplayValue, right: GameplayValue): GameplayCallStatement {
  return generatedCall(id, module, { left, right })
}

function migratePosition(
  call: GameplayCallStatement,
  fresh: (suffix: string) => string,
  spatial: boolean,
): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  if (!piece) return undefined

  const x = fresh('x')
  const y = fresh('y')
  const xPresent = fresh('x-present')
  const yPresent = fresh('y-present')
  const xNormalized = fresh('x-normalized')
  const yNormalized = fresh('y-normalized')
  const xFinite = fresh('x-finite')
  const yFinite = fresh('y-finite')
  const xCheck = fresh('x-check')
  const yCheck = fresh('y-check')
  const statements: GameplayStatement[] = [fieldRead(x, piece, 'x')]
  if (spatial) {
    statements.push(compare(xCheck, output(x), literal(null), nullableNumber, '!='))
  } else {
    statements.push(
      compare(xPresent, output(x), literal(null), nullableNumber, '!='),
      generatedCall(xNormalized, 'value.coalesce', { value: output(x), defaultValue: literal(0) }, { valueType: 'number' }),
      generatedCall(xFinite, 'value.is-finite', { value: output(xNormalized) }),
      logic(xCheck, 'logic.and', output(xPresent), output(xFinite)),
    )
  }
  statements.push(fieldRead(y, piece, 'y'))
  if (spatial) {
    statements.push(compare(yCheck, output(y), literal(null), nullableNumber, '!='))
  } else {
    statements.push(
      compare(yPresent, output(y), literal(null), nullableNumber, '!='),
      generatedCall(yNormalized, 'value.coalesce', { value: output(y), defaultValue: literal(0) }, { valueType: 'number' }),
      generatedCall(yFinite, 'value.is-finite', { value: output(yNormalized) }),
      logic(yCheck, 'logic.and', output(yPresent), output(yFinite)),
    )
  }
  statements.push(replaceCall(call, 'logic.and', { left: output(xCheck), right: output(yCheck) }))
  return { statements }
}

function migrateChoiceArray(
  call: GameplayCallStatement,
  module: 'collection.length' | 'collection.distinct',
  outputPort: 'count' | 'duplicate',
  fresh: (suffix: string) => string,
): AtomicReplacement | undefined {
  const choice = requiredInput(call, 'choice')
  if (!choice) return undefined
  const arrayId = fresh('choice-array')
  const array = generatedCall(arrayId, 'choice.as-array', { choice })
  if (module === 'collection.length') {
    const length = replaceCall(call, module, { items: output(arrayId, 'items') })
    return { statements: [array, length], outputs: { [outputPort]: output(call.id) } }
  }
  const sourceLengthId = fresh('choice-length')
  const distinctLengthId = fresh('distinct-length')
  const distinctId = fresh('distinct')
  const distinct = generatedCall(distinctId, 'collection.distinct', { items: output(arrayId, 'items') }, {
    valueType: valueTypeParameter(listChoice),
  })
  const sourceLength = generatedCall(sourceLengthId, 'collection.length', { items: output(arrayId, 'items') })
  const distinctLength = generatedCall(distinctLengthId, 'collection.length', { items: output(distinctId) })
  const comparison = replaceCall(call, 'compare.values', {
    left: output(sourceLengthId), right: output(distinctLengthId),
  }, { valueType: 'number', operator: '!=' })
  return {
    statements: [array, distinct, sourceLength, distinctLength, comparison],
    outputs: { [outputPort]: output(call.id) },
  }
}

function migrateAbilityWasSpent(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  const abilityId = call.parameters?.abilityId
  if (!piece || typeof abilityId !== 'string') return undefined

  const spentId = fresh('spent-passives')
  const foundId = fresh('spent-match')
  const matchId = fresh('spent-equal')
  const spent = pieceFieldRead(spentId, piece, 'spentPassives')
  const found: GameplayStatement = {
    kind: 'collection', id: foundId, method: 'find', items: output(spentId), item: 'item',
    body: [
      compare(matchId, { kind: 'input', name: 'item' }, literal(abilityId), 'string'),
      { kind: 'return', id: fresh('spent-return'), value: output(matchId) },
    ],
  }
  const result = replaceCall(call, 'compare.values', {
    left: output(foundId), right: literal(null),
  }, { valueType: valueTypeParameter(nullableString), operator: '!=' })
  return { statements: [spent, found, result], outputs: { value: output(call.id) } }
}

function migrateSkillIdentifiers(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  if (!piece) return undefined

  const skillsId = fresh('skills')
  const identifiersId = fresh('skill-identifiers')
  const skillId = fresh('skill-id')
  const textId = fresh('skill-id-text')
  const skills = pieceFieldRead(skillsId, piece, 'skills')
  const identifiers: GameplayStatement = {
    kind: 'collection', id: identifiersId, method: 'map', items: output(skillsId), item: 'skill',
    body: [
      generatedCall(skillId, 'data.field', { record: { kind: 'input', name: 'skill' } }, { field: 'skillId' }, '2'),
      generatedCall(textId, 'text.from-value', { value: output(skillId, 'value') }, { valueType: valueTypeParameter(nullableString) }),
      {
        kind: 'return', id: fresh('skill-id-return'),
        value: output(textId, 'text'),
      },
    ],
  }
  // Keep the source order and copy the skill records at the field boundary;
  // map only projects each immutable record's stable skillId.
  return { statements: [skills, identifiers], outputs: { ids: output(identifiersId) } }
}

function migrateSinglePieceList(call: GameplayCallStatement): AtomicReplacement | undefined {
  const piece = requiredInput(call, 'piece')
  if (!piece) return undefined
  return {
    statements: [replaceCall(call, 'collection.singleton', { value: piece })],
    outputs: { pieces: output(call.id, 'items') },
  }
}

function migrateNumberOrZero(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const value = requiredInput(call, 'value')
  if (!value) return undefined
  const normalizedId = fresh('number-or-zero-value')
  const normalized = generatedCall(normalizedId, 'value.coalesce', {
    value, defaultValue: literal(0),
  }, { valueType: 'number' })
  const result = replaceCall(call, 'math.max', {
    left: output(normalizedId), right: literal(0),
  })
  return { statements: [normalized, result], outputs: { value: output(call.id) } }
}

function migrateStripLeadingComma(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const text = requiredInput(call, 'text')
  if (!text) return undefined
  const startsId = fresh('leading-comma')
  const sliceId = fresh('without-leading-comma')
  const starts = generatedCall(startsId, 'text.starts-with', {
    text, value: literal('，'),
  })
  const slice = generatedCall(sliceId, 'text.slice', {
    text, start: literal(1),
  })
  const result = replaceCall(call, 'logic.select', {
    condition: output(startsId), whenTrue: output(sliceId), whenFalse: text,
  }, { valueType: 'string' })
  return { statements: [starts, slice, result], outputs: { value: output(call.id) } }
}

function migrateAuthorizedByOwner(call: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const storageKey = call.parameters?.storageKey
  // Keep invalid legacy parameters invalid. The native descriptor accepts only
  // the single registered owner key; silently changing another key would alter
  // the old compiler's validation behavior.
  if (storageKey !== undefined && storageKey !== 'amaterasuOwnerPlayerId') return undefined
  const key = storageKey === undefined ? 'amaterasuOwnerPlayerId' : storageKey

  const extensions = fresh('extensions')
  const ownerMissing = fresh('owner-missing')
  const ownerEmpty = fresh('owner-empty')
  const unrestricted = fresh('unrestricted')
  const eventPlayer = fresh('event-player')
  const sameOwner = fresh('same-owner')

  return {
    statements: [
      generatedCall(extensions, 'battle.field', {}, {
        field: key,
        valueType: valueTypeParameter(nullableString),
      }, '4'),
      compare(ownerMissing, output(extensions), literal(null), nullableString),
      compare(ownerEmpty, output(extensions), literal(''), nullableString),
      logic(unrestricted, 'logic.or', output(ownerMissing), output(ownerEmpty)),
      generatedCall(eventPlayer, 'context.field', {}, { field: 'playerId' }),
      compare(sameOwner, output(extensions), output(eventPlayer), nullableString),
      replaceCall(call, 'logic.or', { left: output(unrestricted), right: output(sameOwner) }),
    ],
    outputs: { authorized: output(call.id) },
  }
}

/** Recipe consumed by `rewriteAtomicGraph` for the remaining simple predicates. */
export const atomicRemainingPredicatesRecipe: AtomicRecipe = (call, fresh): AtomicReplacement | undefined => {
  switch (call.module) {
    case 'rule.authorized-by-owner': return migrateAuthorizedByOwner(call, fresh)
    case 'piece.has-position': return migratePosition(call, fresh, false)
    case 'spatial.has-position': return migratePosition(call, fresh, true)
    case 'choice.array-length': return migrateChoiceArray(call, 'collection.length', 'count', fresh)
    case 'choice.array-has-duplicate': return migrateChoiceArray(call, 'collection.distinct', 'duplicate', fresh)
    case 'ability.was-spent': return migrateAbilityWasSpent(call, fresh)
    case 'skill.identifiers': return migrateSkillIdentifiers(call, fresh)
    case 'collection.single-piece-list': return migrateSinglePieceList(call)
    case 'value.number-or-zero': return migrateNumberOrZero(call, fresh)
    case 'text.strip-leading-comma': return migrateStripLeadingComma(call, fresh)
    default: return undefined
  }
}

/** Backwards-compatible factory form for callers composing multiple recipes. */
export function createRemainingPredicateMigrationRecipe(): AtomicRecipe {
  return atomicRemainingPredicatesRecipe
}

/** Rewrite every graph scope, including branches, composites, and continuations. */
export function migrateRemainingPredicateModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicRemainingPredicatesRecipe)
}

export const migrateAtomicRemainingPredicateGraph = migrateRemainingPredicateModules
