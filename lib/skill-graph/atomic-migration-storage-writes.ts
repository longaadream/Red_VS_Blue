import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayLiteral, GameplayStatement, GameplayValue } from './module-types'

export const ATOMIC_STORAGE_WRITE_MODULES = new Set(['extension.set-owner', 'extension.set-owner-if-empty', 'extension.read-owner-record', 'extension.remove-owner-record', 'extension.decrement-turns'])
const out = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const nullablePlayer = JSON.stringify({ kind: 'nullable', value: 'player' })
const literal = (value: string | number | boolean | null | string[]): GameplayValue => ({ kind: 'literal', value })
const call = (id: string, module: string, inputs: Record<string, GameplayValue>, parameters?: Record<string, GameplayLiteral>, version = '1'): GameplayCallStatement => ({ kind: 'call', id, module, version, inputs, ...(parameters ? { parameters } : {}) })

function ownerPath(owner: GameplayValue, fresh: (suffix: string) => string, suffix: string[] = []) {
  const text = fresh('owner-key'), path = fresh('owner-path'), joined = fresh('field-path')
  const statements: GameplayStatement[] = [
    call(text, 'text.from-value', { value: owner }, { valueType: 'piece' }),
    call(path, 'collection.singleton', { value: out(text, 'text') }, { valueType: 'string' }),
  ]
  if (suffix.length) statements.push(call(joined, 'collection.concat', { left: out(path, 'items'), right: literal(suffix) }))
  return { statements, value: out(suffix.length ? joined : path, 'items'), key: out(text, 'text') }
}

/** The conditional belongs to the author graph; the host owns only typed storage. */
export const atomicStorageWriteRecipe: AtomicRecipe = (node, fresh, scope): AtomicReplacement | undefined => {
  if (node.module === 'extension.read-owner-record') {
    const path = ownerPath(node.inputs!.owner, fresh)
    return { statements: [...path.statements, { kind: 'call', id: node.id, module: 'extension.read-battle', version: '2', inputs: { path: path.value }, parameters: { namespace: '', name: node.parameters!.key, valueType: 'record' } }], outputs: { record: out(node.id) } }
  }
  if (node.module === 'extension.remove-owner-record') {
    const path = ownerPath(node.inputs!.owner, fresh), root = fresh('records'), selected = fresh('selected-owner'), result = fresh('result'), updated = fresh('remaining-records'), written = fresh('write-record'), current = fresh('result-value')
    return { statements: [...path.statements,
      { kind: 'call', id: root, module: 'extension.read-battle', version: '2', parameters: { namespace: '', name: node.parameters!.key, valueType: 'record' } },
      call(selected, 'data.read-key', { record: out(root), key: path.key }, { valueType: 'record' }),
      call(result, 'local.declare', {}, { valueType: 'boolean' }),
      { kind: 'if', id: fresh('remove-if-present'), condition: out(selected, 'defined'), then: [
        call(updated, 'data.omit-key', { record: out(root), key: path.key }),
        call(written, 'extension.write-battle', { value: out(updated) }, { namespace: '', name: node.parameters!.key, valueType: 'record' }, '3'),
        call(fresh('save-result'), 'local.write', { handle: out(result, 'handle'), value: out(written, 'success') }, { valueType: 'boolean' }),
      ], else: [call(fresh('save-missing'), 'local.write', { handle: out(result, 'handle'), value: literal(false) }, { valueType: 'boolean' })] },
      call(current, 'local.read', { handle: out(result, 'handle') }, { valueType: 'boolean' }),
    ], outputs: { success: out(current, 'value') } }
  }
  if (node.module === 'extension.decrement-turns') {
    const input = node.inputs?.record
    const source = input?.kind === 'output' ? scope?.getDefinition(input.node) : undefined
    if (source?.kind !== 'call' || source.module !== 'extension.read-owner-record') throw new Error('Cannot locate the authoritative storage for ' + node.id)
    const path = ownerPath(source.inputs!.owner, fresh, ['turns']), current = fresh('turns'), next = fresh('next-turns')
    return { statements: [...path.statements,
      { kind: 'call', id: current, module: 'extension.read-battle', version: '2', inputs: { path: path.value }, parameters: { namespace: '', name: source.parameters!.key, valueType: 'number' } },
      call(next, 'math.subtract', { left: out(current), right: literal(1) }),
      { kind: 'call', id: node.id, module: 'extension.write-battle', version: '2', inputs: { path: path.value, value: out(next) }, parameters: { namespace: '', name: source.parameters!.key, valueType: 'number' } },
    ], outputs: { value: out(node.id) } }
  }
  if (node.module !== 'extension.set-owner-if-empty' && node.module !== 'extension.set-owner') return undefined
  const name = node.parameters?.storageKey ?? 'amaterasuOwnerPlayerId'
  if (typeof name !== 'string') return undefined
  const declared = fresh('owner'), result = fresh('result'), empty = fresh('empty'), written = fresh('write-owner'), current = fresh('result-value')
  if (node.module === 'extension.set-owner' && node.parameters?.overwrite === true) {
    return { statements: [
      { kind: 'call', id: declared, module: 'extension.declare-battle', version: '3', inputs: { value: node.inputs!.player }, parameters: { namespace: '', name, valueType: nullablePlayer } },
      call(node.id, 'extension.write-battle', { value: node.inputs!.player }, { namespace: '', name, valueType: nullablePlayer }, '3'),
    ], outputs: { success: out(node.id, 'success') } }
  }
  return { statements: [
    { kind: 'call', id: declared, module: 'extension.declare-battle', version: '3', inputs: { value: node.inputs!.player }, parameters: { namespace: '', name, valueType: nullablePlayer } },
      call(result, 'local.declare', {}, { valueType: 'boolean' }),
    { kind: 'call', id: empty, module: 'compare.values', version: '1', inputs: { left: out(declared), right: { kind: 'literal', value: null } }, parameters: { valueType: nullablePlayer, operator: '==' } },
    { kind: 'if', id: fresh('assign-if-empty'), condition: out(empty), then: [
      call(written, 'extension.write-battle', { value: node.inputs!.player }, { namespace: '', name, valueType: nullablePlayer }, '3'),
      call(fresh('save-result'), 'local.write', { handle: out(result, 'handle'), value: out(written, 'success') }, { valueType: 'boolean' }),
      ], else: [call(fresh('save-existing'), 'local.write', { handle: out(result, 'handle'), value: out(declared, 'success') }, { valueType: 'boolean' })] },
    call(current, 'local.read', { handle: out(result, 'handle') }, { valueType: 'boolean' }),
  ], outputs: { success: out(current, 'value') } }
}
