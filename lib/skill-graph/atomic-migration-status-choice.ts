import { rewriteAtomicGraph, type AtomicRecipe, type AtomicReplacement } from './atomic-graph-rewrite'
import type {
  GameplayCallStatement,
  GameplayJsonValue,
  GameplayModuleGraph,
  GameplayStatement,
  GameplayValue,
  GameplayValueType,
} from './module-types'

/**
 * Expand the legacy Tails status-choice helper into ordinary status handles.
 *
 * The old helper accepted the option transport (`"none"` or a zero-based
 * numeric string), then spliced the raw status array. The replacement keeps
 * that boundary while selecting a stable status handle from status.instances
 * and removing it through status.remove-instance. The latter deliberately has
 * no lifecycle side effects.
 */
export const ATOMIC_STATUS_CHOICE_MODULES = new Set(['status.remove-choice'])
export const ATOMIC_STATUS_CHOICE_MODULE_IDS = ATOMIC_STATUS_CHOICE_MODULES

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const literal = (value: GameplayJsonValue): GameplayValue => ({ kind: 'literal', value })
const typeParameter = (type: GameplayValueType): GameplayJsonValue => typeof type === 'string' ? type : JSON.stringify(type)

function call(
  id: string,
  module: string,
  inputs: Readonly<Record<string, GameplayValue>> = {},
  parameters: Readonly<Record<string, GameplayJsonValue>> = {},
  version = '1',
): GameplayCallStatement {
  return { kind: 'call', id, module, version, inputs, parameters }
}

const nullableStringType: GameplayValueType = { kind: 'nullable', value: 'string' }

function statusChoiceReplacement(
  node: GameplayCallStatement,
  fresh: (suffix: string) => string,
): AtomicReplacement | undefined {
  const target = node.inputs?.target
  if (!target) return undefined

  const statuses = fresh('status-instances')
  const choiceValue = fresh('choice-value')
  const isNoneText = fresh('choice-is-none-text')
  const isEmptyText = fresh('choice-is-empty-text')
  const isNone = fresh('choice-is-none')
  const selectedStatus = fresh('selected-status')
  const selectedIndexText = fresh('selected-index-text')
  const selectedIndexMatch = fresh('selected-index-match')
  const selectedPresent = fresh('selected-status-present')
  const valid = fresh('choice-valid')
  const removedLocal = fresh('removed-local')
  const nameLocal = fresh('name-local')
  const removeBranch = fresh('remove-selected-status')
  const selectedName = fresh('selected-status-name')
  const selectedType = fresh('selected-status-type')
  const namePresent = fresh('selected-name-present')
  const selectedText = fresh('selected-status-text')
  const selectedTextPresent = fresh('selected-text-present')
  const baseText = fresh('selected-status-base')
  const displayName = fresh('selected-status-display-name')
  const remove = fresh('remove-selected-status-instance')
  const markRemoved = fresh('mark-status-removed')
  const nameWrite = fresh('write-status-name')
  const removedRead = fresh('removed-read')
  const nameRead = fresh('name-read')

  // A missing input is the empty-status branch's historical “no choice”. An
  // explicitly supplied choice still goes through choice.option-value, so the
  // normal option/cancel/invalid boundary stays in one place.
  const selectedInput = node.inputs?.choice ?? literal(null)
  const statements: GameplayStatement[] = [
    { ...call(statuses, 'status.instances', { owner: target }, { ownerType: 'piece' }), version: '2' },
    call(choiceValue, 'choice.option-value', { choice: selectedInput }),
    call(isNoneText, 'compare.values', { left: output(choiceValue), right: literal('none') }, { valueType: 'string', operator: '==' }),
    call(isEmptyText, 'compare.values', { left: output(choiceValue), right: literal('') }, { valueType: 'string', operator: '==' }),
    call(isNone, 'logic.or', { left: output(isNoneText), right: output(isEmptyText) }),
    {
      kind: 'collection', id: selectedStatus, method: 'find', items: output(statuses, 'statuses'), item: 'status', index: 'index',
      inputs: { choice: output(choiceValue) },
      body: [
        call(selectedIndexText, 'text.from-value', { value: input('index') }, { valueType: 'number' }),
        call(selectedIndexMatch, 'compare.values', {
          left: input('choice'), right: output(selectedIndexText, 'text'),
        }, { valueType: 'string', operator: '==' }),
        { kind: 'return', id: fresh('selected-status-match'), value: output(selectedIndexMatch) },
      ],
    },
    call(selectedPresent, 'value.to-boolean', { value: output(selectedStatus) }, { valueType: typeParameter({ kind: 'nullable', value: 'status' }) }),
    call(valid, 'logic.or', { left: output(isNone), right: output(selectedPresent) }),
    { kind: 'call', id: removedLocal, module: 'local.declare', version: '2', inputs: { initial: literal(false) }, parameters: { valueType: 'boolean', name: 'statusChoiceRemoved' } },
    { kind: 'call', id: nameLocal, module: 'local.declare', version: '2', inputs: { initial: literal('') }, parameters: { valueType: 'string', name: 'statusChoiceName' } },
    {
      kind: 'if',
      id: removeBranch,
      condition: output(selectedPresent),
      then: [
        call(selectedName, 'status.instance-field', { status: output(selectedStatus) }, { field: 'name' }),
        call(selectedType, 'status.instance-field', { status: output(selectedStatus) }, { field: 'type' }),
        call(namePresent, 'value.to-boolean', { value: output(selectedName) }, { valueType: typeParameter(nullableStringType) }),
        call(selectedText, 'logic.select', {
          condition: output(namePresent), whenTrue: output(selectedName), whenFalse: output(selectedType),
        }, { valueType: typeParameter(nullableStringType) }, '2'),
        call(selectedTextPresent, 'value.to-boolean', { value: output(selectedText) }, { valueType: typeParameter(nullableStringType) }),
        call(baseText, 'logic.select', {
          condition: output(selectedTextPresent), whenTrue: output(selectedText), whenFalse: literal('一个效果'),
        }, { valueType: typeParameter(nullableStringType) }, '2'),
        call(displayName, 'value.coalesce', { value: output(baseText), defaultValue: literal('一个效果') }, { valueType: 'string' }),
        call(nameWrite, 'local.write', {
          handle: output(nameLocal, 'handle'), value: output(displayName),
        }, { valueType: 'string' }),
        call(remove, 'status.remove-instance', { status: output(selectedStatus) }),
        call(markRemoved, 'local.write', {
          handle: output(removedLocal, 'handle'), value: literal(true),
        }, { valueType: 'boolean' }),
      ],
    },
    call(removedRead, 'local.read', { handle: output(removedLocal, 'handle') }, { valueType: 'boolean' }),
    call(nameRead, 'local.read', { handle: output(nameLocal, 'handle') }, { valueType: 'string' }),
  ]

  return {
    statements,
    outputs: {
      valid: output(valid),
      removed: output(removedRead, 'value'),
      name: output(nameRead, 'value'),
    },
  }
}

/** Expand legacy status-choice calls while retaining all unrelated graph data. */
export const atomicStatusChoiceRecipe: AtomicRecipe = (node, fresh) => (
  node.module === 'status.remove-choice' ? statusChoiceReplacement(node, fresh) : undefined
)

export function migrateStatusChoiceModules(graph: GameplayModuleGraph): GameplayModuleGraph {
  return rewriteAtomicGraph(graph, atomicStatusChoiceRecipe)
}

export const migrateAtomicStatusChoiceGraph = migrateStatusChoiceModules
