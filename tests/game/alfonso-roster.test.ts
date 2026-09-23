import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyBattleAction } from '@/lib/game/turn'
import { type SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

function loadSkill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(resolve(process.cwd(), `data/skills/${id}.json`), 'utf8')) as SkillDefinition
}

function alfonsoState(
  skillIds: string[],
  enemyPositions: Array<{ instanceId: string; x: number; y: number }>,
) {
  const alfonso = makePiece({
    instanceId: 'alfonso',
    templateId: 'alfonso',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    attack: 6,
    skills: skillIds.map(skillId => ({ skillId, currentCooldown: 0, usesRemaining: -1 })),
  })
  const enemies = enemyPositions.map(enemy => makePiece({
    ...enemy,
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    currentHp: 20,
    maxHp: 20,
  }))
  const state = makeState({ pieces: [alfonso, ...enemies], width: 40, height: 8 })
  for (const skillId of skillIds) state.skillsById[skillId] = loadSkill(skillId)
  return { state, alfonso, enemies }
}

function selectedCellAction(
  state: ReturnType<typeof makeState>,
  skillId: string,
  x: number,
  y: number,
) {
  const type = skillId === 'alfonso-water-dash' ? 'useChargeSkill' : 'useBasicSkill'
  const base = { type, playerId: 'player-red', pieceId: 'alfonso', skillId } as const
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return {
    ...base,
    targetX: x,
    targetY: y,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as const
}

describe('Alfonso roster skills', () => {
  it.each([
    { skillId: 'alfonso-kick', range: 6 },
    { skillId: 'alfonso-water-dash', range: 30 },
  ])('$skillId declares a cardinal grid target', ({ skillId, range }) => {
    const { state } = alfonsoState([skillId], [])
    if (skillId === 'alfonso-water-dash') state.players[0].chargePoints = 2

    const type = skillId === 'alfonso-water-dash' ? 'useChargeSkill' : 'useBasicSkill'
    const prepared = prepareAction(state, {
      type,
      playerId: 'player-red',
      pieceId: 'alfonso',
      skillId,
    })

    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.targetType).toBe('cell')
    expect(prepared.range).toBe(range)
    expect(prepared.candidates).toContainEqual({ type: 'cell', x: 1 + range, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 1, y: 1 })
    expect(prepared.candidates).not.toContainEqual({ type: 'cell', x: 2, y: 2 })
    expect(() => applyBattleAction(state, selectedCellAction(state, skillId, 2, 2))).toThrow()
  })

  it('kicks the first enemy and adds half attack damage at adjacent range', () => {
    const { state, enemies } = alfonsoState(['alfonso-kick'], [
      { instanceId: 'near', x: 2, y: 1 },
      { instanceId: 'far', x: 4, y: 1 },
    ])

    const next = applyBattleAction(state, selectedCellAction(state, 'alfonso-kick', 6, 1))

    expect(next.pieces.find(piece => piece.instanceId === enemies[0].instanceId)?.currentHp).toBe(15)
    expect(next.pieces.find(piece => piece.instanceId === enemies[1].instanceId)?.currentHp).toBe(20)
  })

  it('dashes through the path and repeats damage for nearby unhit enemies', () => {
    const { state, alfonso, enemies } = alfonsoState(['alfonso-water-dash'], [
      { instanceId: 'near', x: 4, y: 1 },
      { instanceId: 'far', x: 6, y: 1 },
    ])
    state.players[0].chargePoints = 2

    const next = applyBattleAction(state, selectedCellAction(state, 'alfonso-water-dash', 9, 1))

    expect(next.pieces.find(piece => piece.instanceId === enemies[0].instanceId)?.currentHp).toBe(8)
    expect(next.pieces.find(piece => piece.instanceId === enemies[1].instanceId)?.currentHp).toBe(8)
    const landed = next.pieces.find(piece => piece.instanceId === alfonso.instanceId)!
    expect(Math.abs(landed.x - enemies[1].x) + Math.abs(landed.y - enemies[1].y)).toBe(1)
  })

  it('freezes nearby enemies and installs both freeze rules', () => {
    const { state, enemies } = alfonsoState(['alfonso-freeze'], [
      { instanceId: 'in-range', x: 3, y: 1 },
      { instanceId: 'out-of-range', x: 4, y: 1 },
    ])
    const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 2 })
    state.pieces.push(ally)

    const cast = applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'alfonso', skillId: 'alfonso-freeze',
    })
    const frozen = cast.pieces.find(piece => piece.instanceId === enemies[0].instanceId)!

    expect(frozen.statusTags).toContainEqual(expect.objectContaining({
      type: 'freeze', currentDuration: 1,
      relatedRules: ['rule-freeze-prevent-move', 'rule-freeze-prevent-skill'],
    }))
    expect(frozen.rules.map(rule => rule.id)).toEqual(expect.arrayContaining([
      'rule-freeze-prevent-move', 'rule-freeze-prevent-skill',
    ]))
    expect(frozen.skills.map(skill => skill.skillId)).toContain('freeze-prevent')
    expect(cast.pieces.find(piece => piece.instanceId === enemies[1].instanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'freeze' }))
    expect(cast.pieces.find(piece => piece.instanceId === ally.instanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'freeze' }))
  })
})
