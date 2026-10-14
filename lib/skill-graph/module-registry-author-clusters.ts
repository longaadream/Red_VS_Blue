import type { GameplayModuleDescriptor, GameplayValueType } from './module-types'

const recordType: GameplayValueType = 'record'
const recordListType: GameplayValueType = { kind: 'list', element: recordType }
const activeSurfaces = ['skill', 'card', 'rule', 'triggerSkill', 'pending'] as const
const currentClusterSurfaces = ['skill', 'rule', 'triggerSkill', 'pending'] as const

function flow(ctx: Parameters<NonNullable<GameplayModuleDescriptor['lower']>>[0]): string {
  return ctx.surface === 'pending' ? 'ctx.flow' : 'flow'
}

/** Runtime Cluster operations. The production registry may opt into these descriptors explicitly. */
export const AUTHOR_CLUSTER_MODULES: readonly GameplayModuleDescriptor[] = Object.freeze([
  {
    id: 'ref.current-cluster',
    version: '1',
    label: '当前能力组实例',
    description: '取得当前执行的主动技能或规则所属的实际能力组实例；没有唯一有效归属时由运行时使语句失效。',
    inputs: [],
    outputs: [{ name: 'group', type: recordType, label: '能力组实例' }],
    allowedSurfaces: currentClusterSurfaces,
    effects: {
      pure: true,
      previewSafe: false,
      reads: ['execution-context', 'pieces'],
    },
    lower: ctx => `${flow(ctx)}.clusters.current()`,
    ui: { category: 'reference', authoring: 'standard' },
  },
  {
    id: 'author.cluster.acquire',
    version: '1',
    label: '获得能力组',
    description: '按结构化能力组定义为指定棋子获得一组主动技能与规则，并返回本次能力组实例。',
    inputs: [
      { name: 'piece', type: 'piece', label: '棋子' },
      { name: 'definition', type: 'record', label: '能力组定义' },
    ],
    inputValueTypeBindings: { definition: { parameter: 'definitionType' } },
    outputs: [{ name: 'group', type: 'record', label: '能力组实例' }],
    parameters: [{ name: 'definitionType', type: 'string', label: '定义类型', default: 'record' }],
    livingReferences: ['piece'],
    allowedSurfaces: activeSurfaces,
    effects: {
      pure: false,
      previewSafe: false,
      reads: ['pieces', 'skills', 'rules'],
      writes: ['pieces', 'skills', 'rules'],
    },
    lower: ctx => `${flow(ctx)}.clusters.acquire(${ctx.inputs.piece},${ctx.inputs.definition})`,
    ui: { category: 'skill', authoring: 'standard' },
  },
  {
    id: 'author.cluster.list',
    version: '1',
    label: '获取能力组',
    description: '按棋子当前能力组实例顺序返回其已获得的能力组。',
    inputs: [{ name: 'piece', type: 'piece', label: '棋子' }],
    outputs: [{ name: 'groups', type: recordListType, label: '能力组实例元组' }],
    livingReferences: ['piece'],
    allowedSurfaces: activeSurfaces,
    effects: {
      pure: true,
      previewSafe: false,
      reads: ['pieces'],
    },
    lower: ctx => `${flow(ctx)}.clusters.list(${ctx.inputs.piece})`,
    ui: { category: 'skill', authoring: 'standard' },
  },
  {
    id: 'author.cluster.remove',
    version: '1',
    label: '移除能力组',
    description: '按能力组实例身份移除其带入的Skill与Rule；其他能力组或基础成员仍由权威运行时保留。',
    inputs: [{ name: 'group', type: 'record', label: '能力组实例' }],
    outputs: [{ name: 'removed', type: 'boolean', label: '是否移除' }],
    allowedSurfaces: activeSurfaces,
    effects: {
      pure: false,
      previewSafe: false,
      reads: ['pieces', 'skills', 'rules'],
      writes: ['pieces', 'skills', 'rules'],
    },
    lower: ctx => `${flow(ctx)}.clusters.remove(${ctx.inputs.group})`,
    ui: { category: 'skill', authoring: 'standard' },
  },
])
