import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyBattleAction } from '@/lib/game/turn'
import { changePiecePositions } from '@/lib/game/position-change'
import { prepareAction } from '@/lib/game/targeting'
import { loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())

describe('RED-209 flight markers do not block entry', () => {
  it.each(['walk', 'dash', 'push', 'pull', 'teleport', 'swap'] as const)('permits %s onto a marked landing', kind => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0 })
    const b = makePiece({ instanceId: 'b', x: 1, y: 0 })
    const state = makeState({ pieces: kind === 'swap' ? [a, b] : [a] })
    state.extensions!.tileEffects = [{ type: 'tails-flight-reservation', x: 1, y: 0 }]
    const changes = [{ pieceId: 'a', x: 1, y: 0 }]
    if (kind === 'swap') changes.push({ pieceId: 'b', x: 0, y: 0 })
    expect(changePiecePositions(state, changes, kind).success).toBe(true)
    expect(a).toMatchObject({ x: 1, y: 0 })
    expect(state.extensions!.tileEffects).toHaveLength(1)
  })

  it('allows walking through a marker even with the legacy player rule attached', () => {
    const a = makePiece({ instanceId: 'a', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [a] })
    state.extensions!.tileEffects = [{ type: 'tails-flight-reservation', x: 1, y: 0 }]
    state.players[0].rules = [loadRuleById('rule-tails-flight-reservation-block')!]
    const next = applyBattleAction(state, { type: 'move', playerId: 'player-red', pieceId: 'a', toX: 2, toY: 0 })
    expect(next.pieces[0]).toMatchObject({ x: 2, y: 0 })
  })

  it.each([false, true])('settles the whole flight using occupancy at expiry (occupant leaves: %s)', leaves => {
    const definition = JSON.parse(readFileSync(resolve('data/skills/tails-twin-flight.json'), 'utf8'))
    const tails = makePiece({ instanceId: 'tails', templateId: 'tails', x: 1, y: 1,
      skills: [{ skillId: definition.id, currentCooldown: 0 }] })
    const ally = makePiece({ instanceId: 'ally', x: 2, y: 1 })
    const intruder = makePiece({ instanceId: 'intruder', ownerPlayerId: 'player-blue', x: 6, y: 4 })
    const initial = makeState({ pieces: [tails, ally, intruder], width: 8, height: 8 })
    initial.skillsById[definition.id] = definition
    const first = prepareAction(initial, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id })
    if (first.kind !== 'needTarget') throw new Error('Expected flight selection')
    let state = applyBattleAction(initial, { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: definition.id,
      targetPieceId: 'ally', extraTargets: [{ x: 4, y: 4 }, { x: 4, y: 5 }],
      selectionId: first.selectionId, stateRevision: first.stateRevision })
    expect(state.players.every(p => !p.rules?.some(r => r.id === 'rule-tails-flight-reservation-block'))).toBe(true)
    expect(changePiecePositions(state, [{ pieceId: 'intruder', x: 4, y: 5 }], 'teleport').success).toBe(true)
    if (leaves) expect(changePiecePositions(state, [{ pieceId: 'intruder', x: 6, y: 4 }], 'teleport').success).toBe(true)
    for (const offset of [0, 2, 2]) {
      state = applyBattleAction({ ...state, turn: { ...state.turn, phase: 'action', currentPlayerId: 'player-red',
        turnNumber: state.turn.turnNumber + offset } }, { type: 'endTurn', playerId: 'player-red' })
    }
    expect(state.pieces.find(p => p.instanceId === 'tails')).toMatchObject(leaves ? { x: 4, y: 4 } : { x: 1, y: 1 })
    expect(state.pieces.find(p => p.instanceId === 'ally')).toMatchObject(leaves ? { x: 4, y: 5 } : { x: 2, y: 1 })
    expect(state.pieces.find(p => p.instanceId === 'intruder')).toMatchObject(leaves ? { x: 6, y: 4 } : { x: 4, y: 5 })
    expect(state.extensions!.tileEffects?.some((e: { type: string }) => e.type === 'tails-flight-reservation')).toBe(false)
    for (const p of state.pieces) expect(p.statusTags.some(t => ['tails-flight-reservation', 'immune', 'inoperable'].includes(t.type))).toBe(false)
  })
})
