/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills are exercised through the runtime. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 213
const DATA_ROOT = join(process.cwd(), 'data')

function loadSkill(skillId: string): any {
  return JSON.parse(readFileSync(join(DATA_ROOT, 'skills', `${skillId}.json`), 'utf8'))
}

function installSkill(state: BattleState, piece: any, skillId: string): any {
  const skill = loadSkill(skillId)
  state.skillsById[skillId] = skill
  piece.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
  return skill
}

function step(state: BattleState, action: BattleAction): BattleState {
  const next = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
  next.skillsById = state.skillsById
  return next
}

function selectedGridAction(
  state: BattleState,
  pieceId: string,
  skillId: string,
  targetX: number,
  targetY: number,
  type: 'useBasicSkill' | 'useChargeSkill' = 'useBasicSkill',
): BattleAction {
  const base = { type, playerId: 'player-red', pieceId, skillId } as BattleAction
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return { ...base, targetX, targetY, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
}

describe('RED-213 skill balance data', () => {
  it('publishes the approved AP, charge, and cooldown values', () => {
    expect(loadSkill('alfonso-water-dash')).toMatchObject({ actionPointCost: 2, chargeCost: 2 })
    expect(loadSkill('alfonso-kick')).toMatchObject({ actionPointCost: 1, cooldownTurns: 1 })
    expect(loadSkill('max-speed-shot')).toMatchObject({ actionPointCost: 1, cooldownTurns: 0 })
    expect(loadSkill('max-full-speed')).toMatchObject({ actionPointCost: 0, chargeCost: 1, cooldownTurns: 1 })
    expect(loadSkill('death-blossom')).toMatchObject({ actionPointCost: 2, chargeCost: 1 })
  })
})

describe('RED-213 Alfonso costs and cooldown', () => {
  it('charges Alfonso Water Dash 2 AP and 2 charge points', () => {
    const alfonso = makePiece({ instanceId: 'alfonso', templateId: 'red-alfonso', x: 0, y: 0 }) as any
    const state = makeState({ pieces: [alfonso], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-water-dash')
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2

    const next = step(state, selectedGridAction(state, alfonso.instanceId, 'alfonso-water-dash', 1, 0, 'useChargeSkill'))

    expect(next.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(next.pieces[0].skills[0].currentCooldown).toBe(1)
  })

  it('puts Alfonso Kick on cooldown after a normal release', () => {
    const alfonso = makePiece({ instanceId: 'alfonso', templateId: 'red-alfonso', x: 0, y: 0, attack: 10 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0, currentHp: 20, maxHp: 20 }) as any
    const state = makeState({ pieces: [alfonso, enemy], width: 6, height: 2 })
    installSkill(state, alfonso, 'alfonso-kick')
    state.players[0].actionPoints = 1

    const next = step(state, selectedGridAction(state, alfonso.instanceId, 'alfonso-kick', 1, 0))

    expect(next.players[0].actionPoints).toBe(0)
    expect(next.pieces.find(piece => piece.instanceId === alfonso.instanceId)?.skills[0].currentCooldown).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(13)
  })
})

describe('RED-213 Max speed shot', () => {
  it('allows exactly two paid casts in one turn, then resumes next turn', () => {
    const max = makePiece({ instanceId: 'max', templateId: 'max', x: 0, y: 0 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 0, currentHp: 100, maxHp: 100 }) as any
    const state = makeState({ pieces: [max, enemy], width: 6, height: 2 })
    installSkill(state, max, 'max-speed-shot')
    state.players[0].actionPoints = 2

    let next = step(state, selectedGridAction(state, max.instanceId, 'max-speed-shot', 3, 0))
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(96)
    expect(next.pieces.find(piece => piece.instanceId === max.instanceId)?.skills[0].currentCooldown).toBe(0)

    next = step(next, selectedGridAction(next, max.instanceId, 'max-speed-shot', 3, 0))
    expect(next.players[0].actionPoints).toBe(0)
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(92)
    expect(next.pieces.find(piece => piece.instanceId === max.instanceId)?.skills[0].currentCooldown).toBe(1)

    const thirdAttempt = prepareAction(next, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: max.instanceId, skillId: 'max-speed-shot',
    })
    expect(thirdAttempt.kind).toBe('invalid')

    next = step(next, { type: 'endTurn', playerId: 'player-red' })
    next = step(next, { type: 'beginPhase' })
    next = step(next, { type: 'endTurn', playerId: 'player-blue' })
    next = step(next, { type: 'beginPhase' })
    expect(next.turn.currentPlayerId).toBe('player-red')
    expect(next.pieces.find(piece => piece.instanceId === max.instanceId)?.skills[0].currentCooldown).toBe(0)
  })

  it('keeps the two-cast limit after the recast marker is removed and cooldown is reset', () => {
    const max = makePiece({ instanceId: 'max-marker-cleanup', templateId: 'max', x: 0, y: 0 }) as any
    const enemy = makePiece({ instanceId: 'enemy-marker-cleanup', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 0, currentHp: 100, maxHp: 100 }) as any
    const state = makeState({ pieces: [max, enemy], width: 6, height: 2 })
    installSkill(state, max, 'max-speed-shot')
    state.players[0].actionPoints = 3

    let next = step(state, selectedGridAction(state, max.instanceId, 'max-speed-shot', 3, 0))
    const afterFirst = next.pieces.find(piece => piece.instanceId === max.instanceId)!
    afterFirst.statusTags = (afterFirst.statusTags || []).filter(tag => tag.type !== 'max-speed-shot-recast')
    afterFirst.skills![0].currentCooldown = 0

    next = step(next, selectedGridAction(next, max.instanceId, 'max-speed-shot', 3, 0))
    expect(next.players[0].actionPoints).toBe(1)
    const afterSecond = next.pieces.find(piece => piece.instanceId === max.instanceId)!
    afterSecond.statusTags = (afterSecond.statusTags || []).filter(tag => tag.type !== 'max-speed-shot-recast')
    afterSecond.skills![0].currentCooldown = 0

    const thirdAction = selectedGridAction(next, max.instanceId, 'max-speed-shot', 3, 0)
    expect(() => step(next, thirdAction)).toThrow(/最多释放2次/)
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(92)
  })

  it.each([
    ['an empty lane', false],
    ['a blocked lane', true],
  ])('counts both casts when %s produces no hit', (_label, blocked) => {
    const max = makePiece({ instanceId: `max-${blocked}`, templateId: 'max', x: 0, y: 0 }) as any
    const state = makeState({ pieces: [max], width: 6, height: 2 })
    installSkill(state, max, 'max-speed-shot')
    state.players[0].actionPoints = 2
    if (blocked) {
      const tile = state.map.tiles.find(candidate => candidate.x === 1 && candidate.y === 0)!
      tile.props = { ...tile.props, type: 'wall', walkable: false, bulletPassable: false }
    }

    let next = step(state, selectedGridAction(state, max.instanceId, 'max-speed-shot', 3, 0))
    next = step(next, selectedGridAction(next, max.instanceId, 'max-speed-shot', 3, 0))

    expect(next.players[0].actionPoints).toBe(0)
    expect(next.pieces.find(piece => piece.instanceId === max.instanceId)?.skills[0].currentCooldown).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === max.instanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'max-speed-shot-recast' }))
  })
})

describe('RED-213 Max full speed', () => {
  it('grants swift to both living allies in a 2v2 board and excludes both enemies', () => {
    const max = makePiece({ instanceId: 'max-2v2', templateId: 'max', x: 0, y: 0 }) as any
    const ally = makePiece({ instanceId: 'ally-2v2', templateId: 'ally', x: 5, y: 0 }) as any
    const enemyOne = makePiece({ instanceId: 'enemy-one-2v2', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1 }) as any
    const enemyTwo = makePiece({ instanceId: 'enemy-two-2v2', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 1 }) as any
    const state = makeState({ pieces: [max, ally, enemyOne, enemyTwo], width: 6, height: 2 })
    installSkill(state, max, 'max-full-speed')
    state.players[0].chargePoints = 1

    const next = step(state, { type: 'useChargeSkill', playerId: 'player-red', pieceId: max.instanceId, skillId: 'max-full-speed' })
    for (const pieceId of [max.instanceId, ally.instanceId]) {
      expect(next.pieces.find(piece => piece.instanceId === pieceId)?.statusTags)
        .toContainEqual(expect.objectContaining({
          type: 'deployment-first-move-free',
          grantedTurnNumber: next.turn.turnNumber,
          currentUses: 1,
        }))
    }
    for (const pieceId of [enemyOne.instanceId, enemyTwo.instanceId]) {
      expect(next.pieces.find(piece => piece.instanceId === pieceId)?.statusTags)
        .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    }
  })

  it('grants all living allies, including distant allies, one stackable free move', () => {
    const maxOne = makePiece({ instanceId: 'max-one', templateId: 'max', x: 0, y: 0 }) as any
    const maxTwo = makePiece({ instanceId: 'max-two', templateId: 'max', x: 0, y: 1 }) as any
    const distantAlly = makePiece({ instanceId: 'distant-ally', templateId: 'ally', x: 5, y: 1, moveRange: 1 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1 }) as any
    const deadAlly = makePiece({ instanceId: 'dead-ally', templateId: 'ally', x: 4, y: 4, currentHp: 0 }) as any
    const state = makeState({ pieces: [maxOne, maxTwo, distantAlly, enemy, deadAlly], width: 6, height: 5 })
    installSkill(state, maxOne, 'max-full-speed')
    installSkill(state, maxTwo, 'max-full-speed')
    state.players[0].chargePoints = 2
    state.players[0].actionPoints = 1

    let next = step(state, { type: 'useChargeSkill', playerId: 'player-red', pieceId: maxOne.instanceId, skillId: 'max-full-speed' })
    next = step(next, { type: 'useChargeSkill', playerId: 'player-red', pieceId: maxTwo.instanceId, skillId: 'max-full-speed' })

    const ally = next.pieces.find(piece => piece.instanceId === distantAlly.instanceId)!
    expect(ally.moveRange).toBe(1)
    expect(ally.statusTags.filter(tag => tag.type === 'deployment-first-move-free')).toHaveLength(2)
    expect(ally.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ stacking: 'independent', grantedTurnNumber: next.turn.turnNumber, currentUses: 1 }),
    ]))
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    expect(next.pieces.find(piece => piece.instanceId === deadAlly.instanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    expect(next.pieces.find(piece => piece.instanceId === maxOne.instanceId)?.skills[0].currentCooldown).toBe(1)
    expect(next.players[0]).toMatchObject({ actionPoints: 1, chargePoints: 0 })

    next = step(next, { type: 'move', playerId: 'player-red', pieceId: distantAlly.instanceId, toX: 4, toY: 1 })
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === distantAlly.instanceId)?.statusTags.filter(tag => tag.type === 'deployment-first-move-free')).toHaveLength(1)

    next = step(next, { type: 'move', playerId: 'player-red', pieceId: distantAlly.instanceId, toX: 3, toY: 1 })
    expect(next.players[0].actionPoints).toBe(1)
    expect(next.pieces.find(piece => piece.instanceId === distantAlly.instanceId)?.statusTags.filter(tag => tag.type === 'deployment-first-move-free')).toHaveLength(0)

    next = step(next, { type: 'endTurn', playerId: 'player-red' })
    expect(next.pieces.flatMap(piece => piece.statusTags).filter(tag => tag.type === 'deployment-first-move-free')).toHaveLength(0)
  })
})

describe('RED-213 Death Blossom', () => {
  it('charges 2 AP and 1 charge point', () => {
    const reaper = makePiece({ instanceId: 'reaper', templateId: 'reaper', x: 0, y: 0, attack: 5 }) as any
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 1, currentHp: 20, maxHp: 20 }) as any
    const state = makeState({ pieces: [reaper, enemy], width: 4, height: 4 })
    installSkill(state, reaper, 'death-blossom')
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 1

    const next = step(state, { type: 'useChargeSkill', playerId: 'player-red', pieceId: reaper.instanceId, skillId: 'death-blossom' })

    expect(next.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(next.pieces.find(piece => piece.instanceId === enemy.instanceId)?.currentHp).toBe(10)
  })
})
