import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'

const fields = {
  type: 'string', distance: 'number', blocksProjectile: 'boolean',
  piece: { kind: 'nullable', value: 'piece' }, x: 'number', y: 'number',
} as const satisfies Record<string, GameplayValueType>

/** Detached observations remain readable after the observed entity leaves play. */
export const OBSERVATION_FIELD_MODULES: readonly GameplayModuleDescriptor[] = [{
  id: 'observation.field', version: '1', label: '读取观察记录字段',
  inputs: [{ name: 'record', type: 'event' }], outputs: [{ name: 'value', type: 'unknown' }],
  parameters: [{ name: 'field', type: 'string', enum: Object.keys(fields), default: 'type' }],
  outputParameterTypeBindings: { value: { parameter: 'field', types: fields } },
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: true, previewSafe: false, reads: ['event'] },
  lower: ctx => {
    const key = ctx.parameters.field as keyof typeof fields
    const record = ctx.inputs.record
    if (!Object.hasOwn(fields, key)) throw new Error('Unknown observation field')
    const value = key === 'type' ? `String((${record}&&${record}.type)||'')`
      : key === 'distance' ? `Number((${record}&&${record}.distance)||0)`
        : key === 'blocksProjectile' ? `Boolean(${record}&&${record}.blocksProjectile)`
          : key === 'piece' ? `(${record}&&${record}.piece?${record}.piece.instanceId:null)`
            : `Number(${record}[${ctx.emitLiteral(key)}])`
    return `({value:${value}})`
  },
  ui: { category: 'data', authoring: 'standard' },
}]
