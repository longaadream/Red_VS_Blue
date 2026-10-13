import { describe, expect, it } from 'vitest'
import { authorTargetMetadata } from '../../lib/skill-graph/author-target-metadata'
import { isSinglePieceTargetAction, prepareAction } from '../../lib/game/targeting'
import type { GameplayCallStatement, GameplayModuleGraph } from '../../lib/skill-graph/module-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const call = (module: string, parameters = {}): GameplayCallStatement => ({
  kind: 'call', id: module, module, version: '1', inputs: {}, parameters,
})
const graph = (body: GameplayModuleGraph['body']): GameplayModuleGraph => ({
  version: 'rvb-gameplay-modules/v1', surface: 'skill', outputs: [], body,
})

describe('author target preparation', () => {
  it('prepares the same first target before use and recognizes a single-target action', () => {
    const caster = makePiece({ instanceId: 'caster', x: 1, y: 1 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1 })
    caster.skills = [{ skillId: 'author-target', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [caster, enemy] })
    state.skillsById['author-target'] = {
      id: 'author-target', name: '选择目标', description: '', type: 'normal', kind: 'active', range: 'single',
      actionPointCost: 1, cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1,
      code: 'function executeSkill() {}',
      gameplayModules: { entries: { code: { graph: graph([call('ref.holder'), call('author.choice.target-piece', { range: 5 }), call('effect.damage')]) } } },
    } as never
    const action = { type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: 'author-target' }
    expect(prepareAction(state, action)).toMatchObject({ kind: 'needTarget', candidates: [{ type: 'piece', pieceId: 'enemy' }] })
    expect(isSinglePieceTargetAction(state, action)).toBe(true)
  })

  it('never hoists selections past effects or control flow', () => {
    expect(authorTargetMetadata(graph([call('effect.damage'), call('author.choice.target-piece')]))).toEqual([])
    expect(authorTargetMetadata(graph([{ kind: 'if', id: 'conditional', condition: { kind: 'literal', value: false }, then: [call('author.choice.target-piece')] }]))).toEqual([])
  })

  it('preserves target order and cell defaults, with no implicit source-cell candidate', () => {
    expect(authorTargetMetadata(graph([call('ref.holder'), call('author.choice.target-piece'), call('author.choice.target-cell', { range: 3, requireWalkable: false })]))).toEqual([
      { kind: 'target', type: 'piece', filter: 'enemy', range: 5, minRange: 1 },
      { kind: 'target', type: 'cell', filter: 'all', range: 3, minRange: 1, requireWalkable: false, requireUnoccupied: true },
    ])
  })
})
