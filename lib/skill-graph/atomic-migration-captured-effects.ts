import type { AtomicRecipe, AtomicReplacement } from './atomic-graph-rewrite'
import type { GameplayCallStatement, GameplayValue } from './module-types'

/** Compatibility modules covered by this bounded captured-effect migration. */
export const ATOMIC_CAPTURED_EFFECT_MODULES = new Set([
  'effect.queue-damage-captured',
  'rule.remove-captured',
])

const output = (node: string, port = 'value'): GameplayValue => ({ kind: 'output', node, port })
const isValue = (value: unknown): value is GameplayValue => Boolean(value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string')

function migrateQueuedCapturedDamage(node: GameplayCallStatement, fresh: (suffix: string) => string): AtomicReplacement | undefined {
  const source = node.inputs?.source
  const target = node.inputs?.target
  const amount = node.inputs?.amount
  const damageType = node.parameters?.damageType
  const skillId = node.parameters?.skillId
  if (!isValue(source) || !isValue(target) || !isValue(amount)
    || node.version !== '1'
    || !['physical', 'magical', 'true'].includes(String(damageType))
    || typeof skillId !== 'string' || skillId.length === 0) return undefined

  const normalizedType = damageType === 'true' ? 'true' : 'normal'
  const parameters = {
    sourceType: 'record',
    targetType: 'record',
    amountType: 'number',
    resultType: 'record',
    damageType: normalizedType,
    ...(normalizedType === 'normal' ? { legacyNormalSpelling: damageType } : {}),
    attribution: 'current',
    skillId,
  }
  // The legacy queue adapter returned only `success`, which was true after a
  // successful enqueue.  Read the public queued flag through the ordinary
  // result-field atom so compiler fault isolation cannot turn a skipped
  // invalid statement into a false success value.
  const queued = fresh('queued')
  return {
    statements: [
      { ...node, module: 'author.effect.damage', version: '2', inputs: { source, target, amount }, parameters },
      { kind: 'call', id: queued, module: 'result.field', version: '1', inputs: { record: output(node.id, 'result') }, parameters: { field: 'queued' } },
    ],
    outputs: { success: output(queued, 'value'), result: output(node.id, 'result') },
  }
}

function migrateCapturedRuleRemoval(node: GameplayCallStatement): AtomicReplacement | undefined {
  const source = node.inputs?.source
  const ruleId = node.parameters?.ruleId
  if (!isValue(source) || node.version !== '1' || typeof ruleId !== 'string' || ruleId.length === 0) return undefined

  return {
    statements: [
      {
        ...node,
        module: 'rule.remove-id-raw',
        version: '2',
        inputs: { target: source },
        parameters: { targetType: 'record', ruleId },
      },
    ],
    // The v2 record branch delegates to the old authenticated host remover,
    // so its true-on-valid/no-match result and identity semantics are exact.
    outputs: { success: output(node.id, 'success') },
  }
}

/**
 * Lower the two remaining captured execution adapters to ordinary author
 * atoms.  Unsupported or malformed compatibility shapes are left untouched
 * so the caller can report them rather than silently changing their meaning.
 */
export const atomicCapturedEffectRecipe: AtomicRecipe = (node, fresh) => {
  if (node.module === 'effect.queue-damage-captured') return migrateQueuedCapturedDamage(node, fresh)
  if (node.module === 'rule.remove-captured') return migrateCapturedRuleRemoval(node)
  return undefined
}
