import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createFlowRuntime } from '../../lib/game/flow-runtime'
import { makePiece, makeState } from '../helpers/minimal-state'

type SkillDescriptionApi = {
  interpolate: (text: string, context?: Record<string, unknown>) => string
  resolve: (expression: string, context?: Record<string, unknown>) => unknown
}

function loadRenderer(): SkillDescriptionApi {
  const context = createContext({})
  new Script(readFileSync(resolve('data/pages/js/author-expression-core.js'), 'utf8')).runInContext(context)
  new Script(readFileSync(resolve('data/pages/js/skill-description.js'), 'utf8')).runInContext(context)
  return context.RvBSkillDescription as SkillDescriptionApi
}

describe('skill description flowState projection', () => {
  it('projects exact piece/player/battle owners and updates from the same snapshot', () => {
    const red = makePiece({ instanceId: 'piece-red', ownerPlayerId: 'player-red' })
    const blue = makePiece({ instanceId: 'piece-blue', ownerPlayerId: 'player-blue' })
    const battle = makeState({ pieces: [red, blue] })
    const flow = createFlowRuntime(battle, { piece: red }, 'skill', {})
    Object.defineProperty(red, 'extension', { configurable: true, enumerable: true, writable: true, value: { shared: 99 } })

    flow.extension.declareValue('piece', red.instanceId, 'content', 'shared', 'number', [], 7.5)
    flow.extension.declareValue('piece', blue.instanceId, 'content', 'shared', 'number', [], 2)
    flow.extension.declareValue('player', 'player-red', 'content', 'shared', 'number', [], 3)
    flow.extension.declareValue('battle', 'battle', 'content', 'shared', 'number', [], 4)
    flow.state.set('piece', red.instanceId, 'content', 'shared', {
      format: 'author-extension-value/v1', type: 'number', schemas: [], value: 7.5,
    })

    const renderer = loadRenderer()
    expect(renderer.interpolate('{当前棋子.扩展.shared}', { piece: red, snapshot: battle })).toBe('7.5')
    expect(renderer.interpolate('{当前棋子.扩展.shared}', { piece: blue, snapshot: battle })).toBe('2')
    expect(renderer.interpolate('{当前玩家.扩展.shared}', { player: battle.players[0], snapshot: battle })).toBe('3')
    expect(renderer.interpolate('{当前对局.扩展.shared}', { snapshot: battle })).toBe('4')
    expect(renderer.interpolate('{当前棋子.扩展.privateOnly}', { piece: red, snapshot: battle })).toBe('未赋值')
    expect(renderer.resolve('当前对局.extensions.flowState', { snapshot: battle })).toBeUndefined()

    flow.state.set('piece', red.instanceId, 'content', 'shared', 9.25)
    expect(renderer.interpolate('伤害{当前棋子.扩展.shared}。', { piece: red, snapshot: battle })).toBe('伤害9.25。')
    expect(renderer.interpolate('伤害{当前棋子.扩展.shared}。', { piece: blue, snapshot: battle })).toBe('伤害2。')

    const cardA = { cardId: 'same-card', instanceId: 'card-a', extension: { shared: 1 } }
    const cardB = { cardId: 'same-card', instanceId: 'card-b', extension: { shared: 6 } }
    expect(renderer.interpolate('{当前手牌.扩展.shared}', { card: cardA, handCard: cardA, snapshot: battle })).toBe('1')
    expect(renderer.interpolate('{当前手牌.扩展.shared}', { card: cardB, handCard: cardB, snapshot: battle })).toBe('6')

    flow.extension.declareValue('piece', red.instanceId, 'content', 'whileAlive', 'number', [], 1)
    flow.state.set('piece', red.instanceId, 'content', 'whileAlive', 9, 'while-alive')
    expect(renderer.interpolate('{当前棋子.扩展.whileAlive}', { piece: red, snapshot: battle })).toBe('9')
    red.currentHp = 0
    expect(renderer.interpolate('{当前棋子.扩展.whileAlive}', { piece: red, snapshot: battle })).toBe('未赋值')
    red.currentHp = 100
    battle.pieces = battle.pieces.filter(piece => piece.instanceId !== red.instanceId)
    expect(renderer.interpolate('{当前棋子.扩展.whileAlive}', { piece: red, snapshot: battle })).toBe('未赋值')

    flow.extension.declareValue('player', 'player-blue', 'content', 'shared', 'number', [], 8)
    const redCard = { cardId: 'same-card', instanceId: 'card-red', ownerPlayerId: 'player-red', extension: {} }
    const blueCard = { cardId: 'same-card', instanceId: 'card-blue', ownerPlayerId: 'player-blue', extension: {} }
    expect(renderer.interpolate('{当前玩家.扩展.shared}', { card: redCard, handCard: redCard, snapshot: battle })).toBe('3')
    expect(renderer.interpolate('{当前玩家.扩展.shared}', { card: blueCard, handCard: blueCard, snapshot: battle })).toBe('8')
  })

  it('does not execute snapshot getters or arbitrary expression functions', () => {
    const battle = makeState({ pieces: [makePiece({ instanceId: 'piece-red' })] })
    let getterCalled = false
    const values: Record<string, unknown> = {}
    Object.defineProperty(values, 'amount', {
      configurable: true,
      enumerable: true,
      get: () => { getterCalled = true; return 10 },
    })
    let functionCalled = false
    Object.defineProperty(values, 'run', {
      configurable: true,
      enumerable: true,
      value: () => { functionCalled = true; return 10 },
    })
    const renderer = loadRenderer()
    expect(renderer.interpolate('{values.amount}', { values, snapshot: battle })).toBe('未赋值')
    expect(renderer.interpolate('{run(1)}', { values, snapshot: battle })).toBe('未赋值')
    expect(getterCalled).toBe(false)
    expect(functionCalled).toBe(false)
  })
})
