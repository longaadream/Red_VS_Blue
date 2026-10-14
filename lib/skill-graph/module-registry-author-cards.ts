import { authorValueSchemas } from '../game/author-extension'
import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'

export const AUTHOR_CARD_MODULES: readonly GameplayModuleDescriptor[] = [{
  id: 'ref.current-card', version: '1', label: '当前手牌',
  description: '当前正在使用或响应事件的那一张手牌实例；同名卡牌各自独立。',
  // A hand is an execution instance handle.  Keep definition cards typed as
  // `card`, but expose the live handle as the opaque record consumed by the
  // unified entity-extension descriptors.
  inputs: [], outputs: [{ name: 'card', type: 'record', label: '手牌实例' }],
  allowedSurfaces: ['card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: true, previewSafe: false, reads: ['execution-context'] }, ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.refs.card()`,
}, {
  id: 'card.instance-reference', version: '1', label: '手牌实例引用',
  description: '从获得手牌或手牌选择器的实例结果取得带类型的引用，不按卡牌名称匹配。',
  inputs: [{ name: 'instance', type: 'record', label: '手牌实例' }], outputs: [{ name: 'card', type: 'record', label: '手牌实例' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: true, previewSafe: false, reads: ['hand', 'execution-context'] }, ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.refs.card(${ctx.inputs.instance})`,
}, {
  id: 'ref.card-definition', version: '1', label: '卡牌',
  description: '在内容库中选取一张卡牌，作为带类型的卡牌引用。',
  inputs: [], outputs: [{ name: 'card', type: 'card', label: '卡牌' }],
  parameters: [{ name: 'cardId', type: 'string', label: '卡牌' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true },
  ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `({card:${ctx.emitLiteral(ctx.parameters.cardId)}})`,
}, {
  id: 'ref.card-template', version: '1', label: '卡牌模板',
  description: '从受信内容目录中选择一份卡牌模板；模板只能作为结构化模板引用传给创建卡牌语句。',
  inputs: [], outputs: [{ name: 'template', type: 'content', label: '卡牌模板' }],
  parameters: [{ name: 'templateId', type: 'string', label: '模板' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending', 'preview'],
  effects: { pure: true, previewSafe: true, reads: ['content'] },
  ui: { category: 'reference', authoring: 'standard' },
  lower: ctx => `({template:${ctx.emitLiteral(ctx.parameters.templateId)}})`,
}, {
  id: 'author.card.gain', version: '1', label: '获得手牌',
  description: '先创建独立手牌并初始化扩展变量，再派发获得事件；手牌已满时按规则进入弃牌堆。',
  inputs: [{ name: 'player', type: 'player', label: '玩家' }, { name: 'card', type: 'card', label: '卡牌' }, { name: 'extension', type: 'record', label: '初始扩展变量', optional: true }],
  parameters: [{ name: 'extensionType', type: 'string', label: '扩展变量类型', default: 'record' }],
  inputValueTypeBindings: { extension: { parameter: 'extensionType' } },
  outputs: [{ name: 'instance', type: 'record', nullable: true, label: '新手牌实例' }, { name: 'success', type: 'boolean', label: '已进入手牌区' }, { name: 'placement', type: 'string', label: '去向' }],
  allowedSurfaces: ['skill', 'card', 'rule', 'triggerSkill', 'pending'],
  effects: { pure: false, previewSafe: false, writes: ['hand', 'extensions'], events: ['beforeCardAdded', 'afterCardAdded'] },
  ui: { category: 'card', authoring: 'standard' },
  lower: ctx => {
    const raw = String(ctx.parameters.extensionType)
    const type = (raw.startsWith('{') ? JSON.parse(raw) : raw) as GameplayValueType
    const initial = ctx.inputs.extension ? `{value:${ctx.inputs.extension},type:${JSON.stringify(type)},schemas:${JSON.stringify(authorValueSchemas(type, ctx.recordSchemas ?? []))}}` : 'undefined'
    return `${ctx.surface === 'pending' ? 'ctx.flow' : 'flow'}.cards.gain(${ctx.inputs.player},${ctx.inputs.card},${initial})`
  },
}]
