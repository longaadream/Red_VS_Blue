import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'

export const ATOMIC_DAMAGE_ATTRIBUTION_MODULES = new Set([
  'effect.damage-with-killer',
  'effect.damage-without-skill-id',
  'effect.damage-pieces-unattributed',
])

const legacyUnattributedDamageModules = new Set([
  'effect.damage-without-skill-id',
  'effect.damage-pieces-unattributed',
])

function migrateUnattributedDamage(node: Parameters<AtomicRecipe>[0], fresh: Parameters<AtomicRecipe>[1]): AtomicReplacement | undefined {
  if (!legacyUnattributedDamageModules.has(node.module) || node.version !== '1') return undefined
  const source = node.inputs?.source
  const target = node.inputs?.target
  const amount = node.inputs?.amount
  if (!source || !target || !amount) return undefined

  // The projectile adapter had a physical default. The flame-spirit adapter
  // always supplied its damage type in authored graphs; reject an absent
  // value there rather than inventing a new event type during migration.
  const rawDamageType = node.parameters?.damageType
  if (node.module === 'effect.damage-pieces-unattributed' && rawDamageType === undefined) return undefined
  const damageType = rawDamageType ?? 'physical'
  if (!['physical', 'magical', 'true'].includes(String(damageType))) return undefined
  // v2 intentionally exposes only the approved normal/true author damage
  // kinds. The historical magical spelling has no equivalent here; leave
  // such a legacy graph untouched for an explicit follow-up adapter instead
  // of changing its rule semantics silently.
  if (damageType === 'magical') return undefined
  const normalizedType = damageType === 'true' ? 'true' : 'normal'
  const parameters = {
    sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record',
    damageType: normalizedType,
    ...(normalizedType === 'normal' ? { legacyNormalSpelling: damageType } : {}),
    attribution: 'unattributed',
  }
  const migrated = { ...node, module: 'author.effect.damage', version: '2', parameters }
  const result = { kind: 'output' as const, node: node.id, port: 'result' }
  if (node.module === 'effect.damage-pieces-unattributed') {
    return { statements: [migrated], outputs: { result } }
  }

  // Preserve the old adapter's three output ports. The unified effect owns
  // the settlement; result.field only exposes the same record members that
  // the legacy wrapper returned to downstream author expressions.
  const success = fresh('success'), damage = fresh('damage')
  return {
    statements: [
      migrated,
      { kind: 'call', id: success, module: 'result.field', version: '1', inputs: { record: result }, parameters: { field: 'success' } },
      { kind: 'call', id: damage, module: 'result.field', version: '1', inputs: { record: result }, parameters: { field: 'damage' } },
    ],
    outputs: { result, success: { kind: 'output', node: success, port: 'value' }, damage: { kind: 'output', node: damage, port: 'value' } },
  }
}

/** Keep attribution separate from the live damage source. Host-valued legacy
 * inputs are migrated only when their integer literal needs no conversion. */
export const atomicDamageAttributionRecipe: AtomicRecipe = (node, fresh): AtomicReplacement | undefined => {
  const unattributed = migrateUnattributedDamage(node, fresh)
  if (unattributed) return unattributed
  if (node.module !== 'effect.damage-with-killer' || node.version !== '1') return undefined
  const amount = node.inputs?.amount
  if (!node.inputs?.source || !node.inputs.target || !amount || !node.inputs.killerPlayer) return undefined
  const damageType = node.parameters?.damageType ?? 'normal'
  if (!['normal', 'true'].includes(String(damageType))) return undefined
  if (node.parameters?.inputPolicy === 'host' && !(amount.kind === 'literal' && typeof amount.value === 'number' && Number.isSafeInteger(amount.value) && amount.value >= 0)) return undefined
  const success = fresh('success'), damage = fresh('damage')
  const result = { kind: 'output' as const, node: node.id, port: 'result' }
  return {
    statements: [
      { ...node, module: 'author.effect.damage', version: '2', parameters: {
        sourceType: 'piece', targetType: 'piece', amountType: 'number', resultType: 'record', damageType,
        ...(node.parameters?.skillId === undefined ? {} : { skillId: node.parameters.skillId }),
      } },
      { kind: 'call', id: success, module: 'result.field', version: '1', inputs: { record: result }, parameters: { field: 'success' } },
      { kind: 'call', id: damage, module: 'result.field', version: '1', inputs: { record: result }, parameters: { field: 'damage' } },
    ],
    outputs: { result, success: { kind: 'output', node: success, port: 'value' }, damage: { kind: 'output', node: damage, port: 'value' } },
  }
}
