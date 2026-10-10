import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { aiEnvironmentV1, listLegalAIActions } from '@/lib/game/ai-environment'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { PieceInstance } from '@/lib/game/piece'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 0x8b0253
type FixturePiece = PieceInstance & { masterPieceId?: string }

describe('RED-253 real Naruto clone projection fixture', () => {
  it('keeps the real source-mirror recipe and covers spectator projection fallback', () => {
    const naruto = Object.assign(makePiece({
      instanceId: 'naruto',
      templateId: 'blue-naruto',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 1,
      y: 1,
      currentHp: 67,
      maxHp: 123,
      attack: 11,
      moveRange: 5,
    }), { isCore: true })
    naruto.name = '鸣人'
    naruto.skills = [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({
      pieces: [naruto],
      currentPlayerId: 'player-blue',
      width: 6,
      height: 5,
    })
    state.players.find(player => player.playerId === 'player-blue')!.actionPoints = 10
    state.skillsById['naruto-shadow-clone'] = JSON.parse(
      readFileSync(resolve(process.cwd(), 'data/skills/naruto-shadow-clone.json'), 'utf8'),
    )

    const action = listLegalAIActions(state, 'player-blue').find(candidate => (
      candidate.kind === 'basic-skill'
      && candidate.action.type === 'useBasicSkill'
      && candidate.action.skillId === 'naruto-shadow-clone'
      && candidate.action.selectedOption === 'summon'
      && candidate.action.targetX === 2
      && candidate.action.targetY === 1
    ))
    expect(action).toBeDefined()
    if (!action) return

    const result = aiEnvironmentV1.simulate(state, action, { rootSeed: ROOT_SEED })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return

    const source = result.state.pieces.find(piece => piece.instanceId === naruto.instanceId) as FixturePiece | undefined
    const clone = result.state.pieces.find(piece => (piece as FixturePiece).masterPieceId === naruto.instanceId) as FixturePiece | undefined
    if (!source || !clone) throw new Error('RED-253 Naruto clone fixture did not produce source and clone')
    expect(source).toMatchObject({ instanceId: 'naruto', isCore: true })
    expect(clone).toMatchObject({
      templateId: 'blue-naruto',
      isCore: false,
      masterPieceId: 'naruto',
      currentHp: 99,
    })

    const enemy = toPublicBattleState(result.state, 'player-red')
    expect(enemy.pieces.find(piece => piece.instanceId === clone.instanceId)).toMatchObject({
      isCore: false,
      masterPieceId: 'naruto',
    })
    expect(enemy.pieces.find(piece => piece.instanceId === source.instanceId)).toMatchObject({ isCore: true })

    const spectator = toPublicBattleState(result.state, 'red253-spectator')
    const spectatorNaruto = spectator.pieces
    expect(spectatorNaruto).toHaveLength(2)
    expect(spectatorNaruto.every(piece => piece.isCore === true)).toBe(true)
    expect(spectatorNaruto.every(piece => !('masterPieceId' in piece))).toBe(true)
    expect(result.state.terminalResult).toBeUndefined()
  })
})
