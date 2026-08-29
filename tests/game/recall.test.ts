import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { executeSkillFunction, type SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function loadSkill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(join(process.cwd(), 'data', 'skills', id + '.json'), 'utf8')) as SkillDefinition
}

function loadRecall(): SkillDefinition {
  return loadSkill('recall')
}

describe('Tracer Recall option resolution', () => {
  it('records the selected enemy action count through the authoritative action path', () => {
    const recall = loadRecall()
    const tracer = makePiece({
      instanceId: 'tracer',
      templateId: 'tracer',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 3,
      currentHp: 11,
      maxHp: 15,
    }) as any
    tracer.skills = [{
      skillId: 'recall',
      level: 1,
      currentCooldown: 0,
    }]
    const state = makeState({
      pieces: [tracer],
      currentPlayerId: 'player-red',
      phase: 'action',
    })
    state.skillsById.recall = recall

    const base = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: tracer.instanceId,
      skillId: recall.id,
    } satisfies Partial<BattleAction>
    const prompt = prepareAction(state, base as BattleAction)
    expect(prompt).toMatchObject({ kind: 'needOption', min: 1, max: 1 })
    if (prompt.kind !== 'needOption') throw new Error('Expected Recall option prompt')
    const action = {
      ...base,
      selectedOption: 4,
      selectionId: prompt.selectionId,
      stateRevision: prompt.stateRevision,
    } as BattleAction
    expect(prepareAction(state, action)).toEqual({ kind: 'ready' })

    const result = runBattleAction(state, action, { rootSeed: 127 }).state

    expect((result.extensions as any).recallData).toEqual([expect.objectContaining({
      pieceId: tracer.instanceId,
      ownerPlayerId: 'player-red',
      targetCount: 4,
      actionCount: 0,
      snapshot: expect.objectContaining({ x: 2, y: 3, hp: 11 }),
    })])
  })
  it('restores the saved snapshot after the selected number of enemy actions', () => {
    const recall = loadRecall()
    const moveTrigger = loadSkill('recall-move-trigger')
    const tracer = makePiece({
      instanceId: 'tracer',
      templateId: 'tracer',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 3,
      currentHp: 11,
      maxHp: 15,
    }) as any
    const enemy = makePiece({
      instanceId: 'enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 7,
      y: 7,
    }) as any
    tracer.skills = [{
      skillId: 'recall',
      level: 1,
      currentCooldown: 0,
    }]
    const state = makeState({
      pieces: [tracer, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
    })
    state.skillsById.recall = recall

    const base = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: tracer.instanceId,
      skillId: recall.id,
    } satisfies Partial<BattleAction>
    const prompt = prepareAction(state, base as BattleAction)
    if (prompt.kind !== 'needOption') throw new Error('Expected Recall option prompt')
    const configured = runBattleAction(state, {
      ...base,
      selectedOption: 2,
      selectionId: prompt.selectionId,
      stateRevision: prompt.stateRevision,
    } as BattleAction, { rootSeed: 127 }).state

    const activeTracer = configured.pieces.find(piece => piece.instanceId === tracer.instanceId)!
    const activeEnemy = configured.pieces.find(piece => piece.instanceId === enemy.instanceId)!
    activeTracer.x = 5
    activeTracer.y = 6
    activeTracer.currentHp = 3

    const triggerContext = {
      piece: activeTracer,
      sourcePiece: activeEnemy,
      target: null,
      playerId: activeEnemy.ownerPlayerId,
      battle: configured,
    } as any
    executeSkillFunction(moveTrigger, triggerContext, configured)
    expect((configured.extensions as any).recallData[0]).toMatchObject({ actionCount: 1 })
    expect(activeTracer).toMatchObject({ x: 5, y: 6, currentHp: 3 })

    executeSkillFunction(moveTrigger, triggerContext, configured)
    expect(activeTracer).toMatchObject({ x: 2, y: 3, currentHp: 11 })
    expect((configured.extensions as any).recallData).toEqual([])
  })

})
