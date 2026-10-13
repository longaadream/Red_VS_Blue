import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'
import { FIELD_GAMEPLAY_MODULES } from './module-registry-fields'

const previous = FIELD_GAMEPLAY_MODULES.find(module => module.id === 'battle.field')!
const fields: Readonly<Record<string, GameplayValueType>> = {
  tileEffects: { kind: 'list', element: 'record' }, turnNumber: 'number', currentPlayerId: 'player',
  actions: { kind: 'list', element: 'record' }, extensions: { kind: 'nullable', value: 'record' },
}
/** One current field selector keeps all regular battle fields available in the palette. */
export const BATTLE_FIELD_GAMEPLAY_MODULES: readonly GameplayModuleDescriptor[] = [{
  ...previous, version: '5', label: '读取战斗字段',
  effects: { ...previous.effects, reads: [...(previous.effects.reads ?? []), 'actions', 'extensions'] },
  parameters: [{ name: 'field', type: 'string', enum: Object.keys(fields) }],
  outputParameterTypeBindings: { value: { parameter: 'field', types: fields } },
  lower: ctx => {
    const state = ctx.surface === 'pending' ? 'ctx.battle' : 'battle'
    if (ctx.parameters.field === 'actions') return `({value:JSON.parse(JSON.stringify(Array.isArray(${state}.actions)?${state}.actions:[]))})`
    if (ctx.parameters.field === 'extensions') return `({value:${state}.extensions==null?null:JSON.parse(JSON.stringify(${state}.extensions))})`
    return previous.lower(ctx)
  },
}]
