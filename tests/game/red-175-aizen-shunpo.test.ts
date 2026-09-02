/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills expose dynamic runtime fields. */
import { describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { loadAllSkillsById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 175

function shunpoFixture() {
  const aizen = makePiece({
    instanceId: 'aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red',
    x: 0, y: 0, attack: 4,
  }) as any
  aizen.name = '蓝染惣右介'
  aizen.skills = [{ skillId: 'aizen-shunpo', currentCooldown: 0, usesRemaining: -1 }]

  const enemy = makePiece({
    instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue',
    x: 4, y: 0, attack: 3,
  }) as any

  const state = makeState({ pieces: [aizen, enemy], currentPlayerId: 'player-red' }) as any
  state.players[0].actionPoints = 1
  state.players[0].maxActionPoints = 1
  state.skillsById['aizen-shunpo'] = loadAllSkillsById()['aizen-shunpo']
  return { state: state as BattleState, aizen, enemy }
}

function selectedShunpoAction(state: BattleState, enemyId: string, x: number, y: number): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'aizen',
    skillId: 'aizen-shunpo',
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected Shunpo target selection, received ${prepared.kind}`)
  }
  return {
    ...draft,
    targetPieceId: enemyId,
    extraTargets: [{ x, y }],
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

describe('RED-175 Aizen Shunpo temporary action points', () => {
  it('authoritatively grants two temporary action points after a legal teleport', () => {
    const { state, enemy } = shunpoFixture()
    const result = runBattleAction(
      state,
      selectedShunpoAction(state, enemy.instanceId, 3, 1),
      { rootSeed: ROOT_SEED },
    ).state as any

    expect(result.pieces.find((piece: any) => piece.instanceId === 'aizen')).toMatchObject({ x: 3, y: 1 })
    expect(result.players[0]).toMatchObject({ actionPoints: 2, maxActionPoints: 1 })
    expect(result.actions).toContainEqual(expect.objectContaining({
      type: 'useBasicSkill',
      payload: expect.objectContaining({
        skillId: 'aizen-shunpo',
        message: expect.stringContaining('获得2点临时行动点'),
      }),
    }))
  })

  it('keeps unfinished and illegal target submissions atomic', () => {
    const unfinished = shunpoFixture()
    const draft = {
      type: 'useBasicSkill' as const,
      playerId: 'player-red',
      pieceId: 'aizen',
      skillId: 'aizen-shunpo',
    }
    expect(prepareAction(unfinished.state, draft).kind).toBe('needTarget')
    expect(unfinished.state.players[0].actionPoints).toBe(1)
    expect(unfinished.aizen).toMatchObject({ x: 0, y: 0 })

    const illegal = shunpoFixture()
    const action = selectedShunpoAction(illegal.state, illegal.enemy.instanceId, 0, 4)
    expect(() => runBattleAction(illegal.state, action, { rootSeed: ROOT_SEED })).toThrow()
    expect(illegal.state.players[0].actionPoints).toBe(1)
    expect(illegal.aizen).toMatchObject({ x: 0, y: 0 })
  })
})
