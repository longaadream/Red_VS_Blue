import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { lowerAuthorExpression } from '../../lib/skill-graph/author-expression-graph'
import { compileGameplayModuleGraph } from '../../lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '../../lib/skill-graph/module-registry'
import { makePiece, makeState } from '../helpers/minimal-state'

function execute(
  expression: string,
  options: {
    pieces?: ReturnType<typeof makePiece>[]
    width?: number
    height?: number
    tileEffects?: unknown[]
  } = {},
): unknown {
  const lowered = lowerAuthorExpression(expression, { surface: 'skill' })
  const graph = {
    version: 'rvb-gameplay-modules/v1' as const,
    surface: 'skill' as const,
    schemas: lowered.schemas,
    outputs: [{ name: 'value', type: lowered.type }],
    body: [...lowered.statements, { kind: 'return' as const, id: 'final', values: { value: lowered.value } }],
  }
  const pieces = options.pieces ?? [makePiece({ instanceId: 'caster', x: 0, y: 0 })]
  const source = pieces[0]
  const battle = makeState({ pieces, width: options.width, height: options.height })
  if (options.tileEffects) battle.extensions = { ...(battle.extensions ?? {}), tileEffects: options.tileEffects }
  const context = { piece: source, sourcePiece: source, playerId: source.ownerPlayerId }
  const flow = createFlowRuntime(battle, context, 'skill', {})
  const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
  return Function('context', 'flow', 'battle', `return (${code})(context)`)(context, flow, battle)
}

describe('author board and collection expressions', () => {
  it('filters query pieces through nested position and tile-effect predicates', () => {
    const caster = makePiece({ instanceId: 'caster', x: 1, y: 1 })
    const marked = makePiece({ instanceId: 'marked', x: 1, y: 2, ownerPlayerId: 'player-blue', faction: 'blue' })
    const plain = makePiece({ instanceId: 'plain', x: 2, y: 1, ownerPlayerId: 'player-blue', faction: 'blue' })
    const expression = '查询棋子(中心地格: 当前棋子.位置, 最大距离: 2).筛选(每项.位置.地格效果.任意满足(每项.类型 == "天照"))'
    expect(execute(expression, {
      pieces: [caster, marked, plain],
      tileEffects: [
        { x: marked.x, y: marked.y, tileType: '天照' },
        { x: plain.x, y: plain.y, tileType: '冰霜' },
      ],
    })).toEqual({ value: ['marked'] })
  })

  it('keeps relative-cell tuple order while dropping positions outside the board', () => {
    const caster = makePiece({ instanceId: 'caster', x: 0, y: 0 })
    expect(execute('相对地格范围(当前棋子.位置, {坐标(0, 0), 坐标(-1, 0), 坐标(2, 0), 坐标(0, 1)})', {
      pieces: [caster], width: 3, height: 3,
    })).toEqual({ value: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }] })
  })

  it('reads walkability and occupancy from the authoritative board', () => {
    const caster = makePiece({ instanceId: 'caster', x: 1, y: 1 })
    const occupant = makePiece({ instanceId: 'occupant', x: 1, y: 1, ownerPlayerId: 'player-blue', faction: 'blue' })
    const battleOptions = { pieces: [caster, occupant], width: 3, height: 3 }
    expect(execute('当前棋子.位置.可行走', battleOptions)).toEqual({ value: true })
    expect(execute('当前棋子.位置.被占用', battleOptions)).toEqual({ value: true })
    // The helper creates a fresh battle for every expression, so this keeps
    // the board mutation local to the blocked-cell assertion.
    const blockedCaster = makePiece({ instanceId: 'caster', x: 1, y: 1 })
    const blockedBattle = makeState({ pieces: [blockedCaster], width: 3, height: 3 })
    blockedBattle.map.tiles.find(tile => tile.x === 1 && tile.y === 1)!.props.walkable = false
    const lowered = lowerAuthorExpression('当前棋子.位置.可行走', { surface: 'skill' })
    const graph = {
      version: 'rvb-gameplay-modules/v1' as const,
      surface: 'skill' as const,
      schemas: lowered.schemas,
      outputs: [{ name: 'value', type: lowered.type }],
      body: [...lowered.statements, { kind: 'return' as const, id: 'final', values: { value: lowered.value } }],
    }
    const flow = createFlowRuntime(blockedBattle, { piece: blockedCaster, sourcePiece: blockedCaster }, 'skill', {})
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    expect(Function('context', 'flow', 'battle', `return (${code})(context)`)({ piece: blockedCaster }, flow, blockedBattle)).toEqual({ value: false })
  })

  it('returns zero for an absent status', () => {
    expect(execute('状态强度(当前棋子, "不存在")')).toEqual({ value: 0 })
  })

  it('evaluates contains and first-index collection expressions', () => {
    expect(execute('包含({1, 2, 3}, 2)')).toEqual({ value: true })
    expect(execute('首项序号({1, 2, 3}, 2)')).toEqual({ value: 2 })
  })

  it('evaluates slice and map-values collection expressions', () => {
    expect(execute('截取({1, 2, 3, 4}, 2, 2)')).toEqual({ value: [2, 3] })
    expect(execute('值列表({甲: 7, 乙: 9})')).toEqual({ value: [7, 9] })
  })
})
