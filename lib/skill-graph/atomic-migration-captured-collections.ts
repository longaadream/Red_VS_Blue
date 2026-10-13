import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayValue } from './module-types'

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const input = (name: string): GameplayValue => ({ kind: 'input', name })
const listType = JSON.stringify({ kind: 'list', element: 'record' })
const pieceListType = JSON.stringify({ kind: 'list', element: 'piece' })
const call = (id: string, module: string, inputs: GameplayCallStatement['inputs'] = {}, parameters: GameplayCallStatement['parameters'] = {}): GameplayCallStatement => ({ kind: 'call', id, module, version: '1', inputs, parameters })

export const ATOMIC_CAPTURED_COLLECTION_MODULES = new Set([
  'source.capture-list',
  'effect.damage-captured-list',
  'effect.damage-many-captured',
  'effect.heal-many-captured',
])

function capturedEffectParameters(node: GameplayCallStatement, kind: 'damage' | 'heal'): GameplayCallStatement['parameters'] | undefined {
  const skillId = node.parameters?.skillId
  if (skillId !== undefined && typeof skillId !== 'string') return undefined
  if (kind === 'heal') {
    return {
      sourceType: 'record',
      targetType: pieceListType,
      amountType: 'number',
      resultType: 'record',
      ...(skillId === undefined ? {} : { skillId }),
    }
  }
  const damageType = node.parameters?.damageType
  if (damageType !== undefined && damageType !== 'physical' && damageType !== 'magical' && damageType !== 'true') return undefined
  return {
    sourceType: 'record',
    targetType: pieceListType,
    amountType: 'number',
    resultType: 'record',
    damageType: damageType === 'true' ? 'true' : 'normal',
    ...(damageType === 'magical' ? { legacyNormalSpelling: 'magical' } : {}),
    ...(skillId === undefined ? {} : { skillId }),
  }
}

function replaceCapturedEffect(node: GameplayCallStatement, kind: 'damage' | 'heal', inputs = node.inputs): AtomicReplacement | undefined {
  const parameters = capturedEffectParameters(node, kind)
  if (!parameters) return undefined
  const { targets: legacyTargets, ...restInputs } = inputs ?? {}
  const target = restInputs.target ?? legacyTargets
  if (!target) return undefined
  return {
    statements: [{ ...node, module: `author.effect.${kind}`, version: '2', inputs: { ...restInputs, target }, parameters }],
    outputs: { result: output(node.id, 'result') },
  }
}

/** Keep one authoritative damage batch; only collection construction moves into the graph. */
export const atomicCapturedCollectionRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  if (node.module === 'effect.damage-captured-list') {
    const targets = fresh('targets'), identity = fresh('target-reference')
    const inputs = { ...node.inputs, targets: output(targets) }
    const replacement = replaceCapturedEffect(node, 'damage', inputs)
    if (!replacement) return undefined
    return { statements: [
      { kind: 'collection', id: targets, method: 'map', items: node.inputs!.targets, item: 'target', body: [
        call(identity, 'source.captured-piece-reference', { source: input('target') }),
        { kind: 'return', id: fresh('reference'), value: output(identity, 'piece') },
      ] },
      ...replacement.statements,
    ], outputs: replacement.outputs }
  }
  if (node.module === 'effect.damage-many-captured') return replaceCapturedEffect(node, 'damage')
  if (node.module === 'effect.heal-many-captured') return replaceCapturedEffect(node, 'heal')
  if (node.module !== 'source.capture-list') return undefined
  const result = fresh('sources'), count = fresh('count'), valid = fresh('valid'), current = fresh('current'), source = fresh('source'), one = fresh('one'), appended = fresh('appended'), done = fresh('done')
  return { statements: [
    call(result, 'local.declare', {}, { valueType: listType }),
    call(count, 'collection.length', { items: node.inputs!.pieces }),
    call(valid, 'compare.greater-or-equal', { left: output(count), right: { kind: 'literal', value: 0 } }),
    { kind: 'if', id: fresh('valid-input'), condition: output(valid), then: [
      call(fresh('initialize'), 'local.write', { handle: output(result, 'handle'), value: { kind: 'literal', value: [] } }, { valueType: listType }),
      { kind: 'foreach', id: fresh('capture-each'), items: node.inputs!.pieces, item: 'piece', body: [
        call(source, 'source.capture', { source: input('piece') }),
        call(one, 'collection.singleton', { value: output(source, 'source') }, { valueType: 'record' }),
        call(current, 'local.read', { handle: output(result, 'handle') }, { valueType: listType }),
        call(appended, 'collection.concat', { left: output(current), right: output(one, 'items') }, { valueType: listType }),
        call(fresh('save'), 'local.write', { handle: output(result, 'handle'), value: output(appended, 'items') }, { valueType: listType }),
      ] },
    ] },
    call(done, 'local.read', { handle: output(result, 'handle') }, { valueType: listType }),
  ], outputs: { sources: output(done) } }
}
