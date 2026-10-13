import type { GameplayModuleDescriptor } from './module-types'
import { GENERIC_VALUE_GAMEPLAY_MODULES } from './module-registry-generic-values'

const scalarTypes = ['string', 'number', 'boolean', 'piece', 'player']
export const SCALAR_VALUE_MODULES: readonly GameplayModuleDescriptor[] = [
  ...(['trim', 'lowercase'] as const).map(operation => ({
    id: 'text.' + operation, version: '1', label: operation === 'trim' ? '去掉文本首尾空白' : '文本转小写',
    inputs: [{ name: 'text', type: 'string' as const }], outputs: [{ name: 'text', type: 'string' as const }],
    allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'] as const,
    effects: { pure: true, previewSafe: true }, ui: { category: 'text', authoring: 'standard' as const },
    lower: (ctx: import('./module-types').GameplayNativeLoweringContext) => `${ctx.inputs.text}.${operation === 'trim' ? 'trim' : 'toLowerCase'}()`,
  })), {
  id: 'text.from-value', version: '1', label: '转为文本',
  description: '将标量或实例标识转为文本；读取身份不会要求该实例仍然在场。',
  inputs: [{ name: 'value', type: 'record' }], outputs: [{ name: 'text', type: 'string' }],
  parameters: [{ name: 'valueType', type: 'string', default: 'string', enum: [
    ...scalarTypes, ...scalarTypes.map(value => JSON.stringify({ kind: 'nullable', value })),
  ] }],
  inputValueTypeBindings: { value: { parameter: 'valueType' } },
  inspectReferences: ['value'],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true },
  lower: ctx => `String(${ctx.inputs.value})`,
  ui: { category: 'text', authoring: 'standard' },
}, {
  ...GENERIC_VALUE_GAMEPLAY_MODULES.find(entry => entry.id === 'logic.select')!,
  version: '2',
  inspectReferences: ['whenTrue', 'whenFalse'],
  // A record may itself own a field named `value`; always wrap the output.
  lower: ctx => `({value:(${ctx.inputs.condition} ? ${ctx.inputs.whenTrue} : ${ctx.inputs.whenFalse})})`,
}]
