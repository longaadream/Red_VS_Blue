import type { GameplayEffectMetadata, GameplayModuleDescriptor, GameplayModuleSurface, GameplayValueType } from './module-types'

/**
 * Reference to the concrete Rule currently dispatching.  The runtime returns
 * an execution-local handle; pending continuations rebuild the same identity
 * from the serialized owner and instanceId rather than selecting a same-id
 * sibling.
 */

const flow = (ctx: { surface: GameplayModuleSurface }): string => ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
const recordType: GameplayValueType = 'record'
const pureRead: GameplayEffectMetadata = {
  pure: true,
  previewSafe: false,
  reads: ['execution-context', 'rules'],
}

export const AUTHOR_RULE_INSTANCE_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([{
  id: 'ref.current-rule',
  version: '1',
  label: '当前规则实例',
  description: '取得当前正在执行的实际规则实例；不存在有效实例时由运行时使语句失效。',
  inputs: [],
  outputs: [{ name: 'instance', type: recordType, label: '规则实例' }],
  allowedSurfaces: ['rule', 'triggerSkill', 'pending'],
  effects: pureRead,
  ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `${flow(ctx)}.rules.current()`,
}])
