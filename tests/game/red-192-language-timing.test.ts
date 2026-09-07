/* eslint-disable @typescript-eslint/no-explicit-any -- Validate authored rules through authoritative fixtures. */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runBattleAction } from '../../lib/game/battle-runner'
import { loadAllSkillsById, executeSkillFunction } from '../../lib/game/skills'
import { prepareAction } from '../../lib/game/targeting'
import { globalTriggerSystem } from '../../lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

beforeEach(() => globalTriggerSystem.clearRules())
describe('confirmed language-review timing corrections', () => {
  it('lands on the second subsequent owner turn end and preserves unrelated immunity', () => {
    let state = makeState({ width: 10, height: 6, pieces: [
      makePiece({ instanceId: 'tails', x: 0, y: 0 }), makePiece({ instanceId: 'ally', x: 1, y: 0 }),
      makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 9, y: 5 }),
    ] })
    state.skillsById = loadAllSkillsById()
    state.pieces[0].skills = [{ skillId: 'tails-twin-flight', currentCooldown: 0, usesRemaining: -1 } as any]
    state.pieces[1].statusTags.push({ id: 'unrelated-immune', type: 'immune', currentDuration: -1 } as any)
    const action = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'tails', skillId: 'tails-twin-flight' } as const
    const ready = prepareAction(state, action)
    if (ready.kind !== 'needTarget') throw new Error('expected target')
    state = runBattleAction(state, { ...action, targetPieceId: 'ally', extraTargets: [{ x: 4, y: 1 }, { x: 4, y: 2 }], selectionId: ready.selectionId, stateRevision: ready.stateRevision } as any, { rootSeed: 192 }).state
    for (let ended = 0; ended < 4; ended++) {
      state = runBattleAction(state, { type: 'endTurn', playerId: state.turn.currentPlayerId }, { rootSeed: 192 }).state
      expect(state.pieces.find(piece => piece.instanceId === 'tails')).toMatchObject({ x: 0, y: 0 })
      for (const id of ['tails', 'ally']) expect(state.pieces.find(piece => piece.instanceId === id)!.statusTags.some(tag => tag.type === 'inoperable')).toBe(true)
      state = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: 192 }).state
    }
    state = runBattleAction(state, { type: 'endTurn', playerId: state.turn.currentPlayerId }, { rootSeed: 192 }).state
    expect(state.pieces.find(piece => piece.instanceId === 'tails'), JSON.stringify({ turn: state.turn, tags: state.pieces[0].statusTags, actions: state.actions?.slice(-5) })).toMatchObject({ x: 4, y: 1 })
    expect(state.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ x: 4, y: 2 })
    expect(state.pieces[1].statusTags).toContainEqual(expect.objectContaining({ id: 'unrelated-immune' }))
    expect(state.pieces.flatMap(piece => piece.statusTags).some(tag => tag.type === 'inoperable')).toBe(false)
    expect(state.extensions?.tileEffects?.some((effect: any) => effect.type === 'tails-flight-reservation')).toBe(false)
  })
  it('Blizzard applies one turn of freeze through the production skill helper', () => {
    const state = makeState({ currentPlayerId: 'player-blue', pieces: [makePiece(), makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 })] })
    state.skillsById = loadAllSkillsById()
    const player = state.players[0] as any
    player.statusTags = [{ id: 'blizzard-test', type: 'blizzard', centerX: 1, centerY: 0, damage: 3 }]
    const skill = state.skillsById['blizzard-damage']
    executeSkillFunction(skill, { piece: state.pieces[0], skill, battle: state, player, playerId: player.playerId } as any, state)
    expect(state.pieces[1].statusTags).toContainEqual(expect.objectContaining({ type: 'freeze', currentDuration: 1 }))
  })
  it('audits every skill without changing unrelated mechanics', () => {
    const report = JSON.parse(readFileSync('docs/qa/RED-192-skill-language-audit.json', 'utf8'))
    const skills = loadAllSkillsById()
    expect(report.entries.map((entry: any) => entry.id).sort()).toEqual(Object.keys(skills).sort())
    for (const entry of report.entries) expect(skills[entry.id].description).toBe(entry.after)
    expect(skills['hashirama-edo-regen'].description).toContain('恢复2点生命')
    expect(skills['rocket-punch'].description).toContain('首个棋子或障碍前')
  })
})
