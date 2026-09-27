/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { planShortSearchAction } from '@/lib/game/ai-short-search'
import { practiceEnvironment } from '@/lib/practice/environment'
import { evaluateZeroStageState } from '@/lib/practice/evaluator'
import { makePiece, makeState } from '../helpers/minimal-state'

const seed = 0x219
const config = {
  turnTimeMs: 0,
  decisionTimeMs: 0,
  deploymentTimeMs: 0,
  nodesPerDecision: 128,
  nodesPerTurn: 896,
}

function loadJson(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function makeCard(id: string, instanceId: string) {
  return {
    ...loadJson(`data/cards/${id}.json`),
    cardId: id,
    instanceId,
    ownerPlayerId: 'player-red',
  }
}

function fixture(options: {
  actionPoints?: number
  chargePoints?: number
  hand?: any[]
  skills?: any[]
  skillDefinitions?: string[]
  attack?: number
  enemyHp?: number
  enemyX?: number
  redX?: number
  moveRange?: number
  maxHp?: number
  enemyMaxHp?: number
  corePieces?: boolean
} = {}) {
  const maxHp = options.maxHp ?? 12
  const enemyMaxHp = options.enemyMaxHp ?? 12
  const red = makePiece({
    instanceId: 'red-caster',
    templateId: 'jaina',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: options.redX ?? 0,
    y: 0,
    moveRange: options.moveRange ?? 4,
    attack: options.attack ?? 4,
    maxHp,
    currentHp: maxHp,
    skills: options.skills ?? [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }],
  }) as any
  const blue = makePiece({
    instanceId: 'blue-target',
    templateId: 'target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: options.enemyX ?? 2,
    y: 0,
    currentHp: options.enemyHp ?? enemyMaxHp,
    maxHp: enemyMaxHp,
    attack: 4,
    actionPoints: 0,
  }) as any
  if (options.corePieces) {
    red.isCore = true
    blue.isCore = true
  }
  const state = makeState({ pieces: [red, blue], width: 8, height: 3 }) as any
  state.players[0].actionPoints = options.actionPoints ?? 2
  state.players[0].chargePoints = options.chargePoints ?? 0
  state.players[0].hand = options.hand ?? []
  for (const skillId of options.skillDefinitions ?? []) {
    state.skillsById[skillId] = loadJson(`data/skills/${skillId}.json`)
  }
  return state
}

function plan(state: any) {
  return planShortSearchAction(state, 'player-red', seed, {
    environment: practiceEnvironment,
    evaluate: observation => evaluateZeroStageState(observation).total,
    config,
  })
}

describe('RED-219 practice resource use', () => {
  it('uses a zero-AP lucky coin for a real core fireball continuation', () => {
    const state = fixture({
      actionPoints: 0,
      moveRange: 0,
      hand: [makeCard('lucky-coin', 'coin-1')],
      corePieces: true,
    })

    const first = plan(state).nextAction
    expect(first?.kind).toBe('card')
    if (!first) throw new Error('Planner returned no first action')
    const afterCoin = practiceEnvironment.simulate(state, first, { rootSeed: seed })
    expect(afterCoin.accepted).toBe(true)
    if (!afterCoin.accepted) return
    expect(afterCoin.state.players[0].actionPoints).toBe(1)

    const continuation = plan(afterCoin.state).nextAction
    expect(continuation?.kind).toBe('basic-skill')
    if (!continuation) throw new Error('Planner returned no fireball continuation')
    const afterFireball = practiceEnvironment.simulate(afterCoin.state, continuation, { rootSeed: seed })
    expect(afterFireball.accepted).toBe(true)
    if (!afterFireball.accepted) return
    expect(afterFireball.state.pieces.find(piece => piece.instanceId === 'blue-target')?.currentHp).toBe(6)
  })

  it('plans and spends CP on the real Itachi Totsuka Blade damage skill', () => {
    const state = fixture({
      actionPoints: 2,
      chargePoints: 3,
      moveRange: 0,
      enemyHp: 8,
      corePieces: true,
      skills: [{ skillId: 'itachi-totsuka-blade', currentCooldown: 0, usesRemaining: -1 }],
      skillDefinitions: ['itachi-totsuka-blade'],
    })

    const action = plan(state).nextAction
    expect(action?.kind).toBe('charge-skill')
    if (!action) throw new Error('Planner returned no charged skill')
    const result = practiceEnvironment.simulate(state, action, { rootSeed: seed })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.state.players[0].actionPoints).toBe(0)
    expect(result.state.players[0].chargePoints).toBe(0)
    expect(result.state.pieces.some(piece => piece.instanceId === 'blue-target')).toBe(false)
    expect(result.state.terminalResult?.winnerPlayerId).toBe('player-red')
  })

  it('keeps a lucky coin when the zero-AP state has no useful follow-up', () => {
    const state = fixture({
      actionPoints: 0,
      moveRange: 0,
      enemyX: 7,
      skills: [],
      hand: [makeCard('lucky-coin', 'coin-1')],
      corePieces: true,
    })

    const legal = practiceEnvironment.listLegalActions(state, 'player-red')
    expect(legal.some(action => action.kind === 'card')).toBe(true)
    expect(legal.some(action => action.kind === 'end-turn')).toBe(true)
    const action = plan(state).nextAction
    expect(action?.kind).toBe('end-turn')
    if (!action) throw new Error('Planner returned no end-turn action')
    const result = practiceEnvironment.simulate(state, action, { rootSeed: seed })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.state.players.find(player => player.playerId === 'player-red')?.hand).toEqual([
      expect.objectContaining({ cardId: 'lucky-coin', instanceId: 'coin-1' }),
    ])
  })
})
