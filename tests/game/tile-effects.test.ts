/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }

vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    checkTriggers: vi.fn(() => TRIGGER_OK),
    updateCooldowns: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
    snapshotTransactionState: vi.fn(() => ({ nextRootEventId: 0, ruleLimits: [] })),
    restoreTransactionState: vi.fn(),
  },
  TriggerType: {},
}))

import { executeSkillFunction, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

function loadSkill(id: string) {
  return JSON.parse(readFileSync(join(process.cwd(), 'data', 'skills', `${id}.json`), 'utf8'))
}

function executeGridSkill(state: any, piece: any, skillId: string, x: number, y: number) {
  const skill = loadSkill(skillId)
  return executeSkillFunction(skill, {
    piece,
    playerId: piece.ownerPlayerId,
    battle: state,
    targetPosition: { x, y },
    skill,
  } as any, state)
}

describe('persistent tile-effect presentation lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('creates and removes Black Widow toxin presentation by matching sourceId', () => {
    const widow = makePiece({
      instanceId: 'widow',
      templateId: 'red-blackwidow',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    })
    const mover = makePiece({
      instanceId: 'mover',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 3,
    })
    const state = makeState({ pieces: [widow, mover] }) as any
    state.extensions.tileEffects = [
      { x: 0, y: 0, sourceId: 'unrelated', tileType: 'amaterasu' },
    ]

    const placed = executeGridSkill(state, widow, 'blackwidow-lethal-toxin', 2, 1)

    expect(placed.success).toBe(true)
    expect(widow).toMatchObject({ x: 2, y: 1 })
    const toxin = state.players
      .find((player: any) => player.playerId === 'player-red')
      .statusTags.find((tag: any) => tag.type === 'lethal-toxin')
    expect(toxin).toBeDefined()
    expect(state.extensions.tileEffects).toContainEqual(expect.objectContaining({
      x: 1,
      y: 1,
      sourceId: toxin.id,
      tileType: 'lethal-toxin',
    }))

    mover.x = 1
    mover.y = 1
    const rule = loadRuleById('rule-blackwidow-toxin-player', true) as any
    const triggered = rule.effect(state, { sourcePiece: mover, playerId: 'player-red' })

    expect(triggered.success).toBe(true)
    expect(state.extensions.tileEffects).toEqual([
      { x: 0, y: 0, sourceId: 'unrelated', tileType: 'amaterasu' },
    ])
  })

  it('keeps the player rule until the final toxin is consumed', () => {
    const widow = makePiece({
      instanceId: 'widow',
      templateId: 'red-blackwidow',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    })
    const mover = makePiece({
      instanceId: 'mover',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 5,
      y: 1,
      currentHp: 12,
      maxHp: 12,
    })
    const state = makeState({ pieces: [widow, mover], width: 6, height: 3 }) as any
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)

    expect(executeGridSkill(state, widow, 'blackwidow-lethal-toxin', 2, 1).success).toBe(true)
    now.mockReturnValue(200)
    expect(executeGridSkill(state, widow, 'blackwidow-lethal-toxin', 3, 1).success).toBe(true)

    const red = state.players.find((player: any) => player.playerId === 'player-red')
    const rule = loadRuleById('rule-blackwidow-toxin-player', true) as any
    expect(red.statusTags.filter((tag: any) => tag.type === 'lethal-toxin')).toHaveLength(2)

    mover.x = 1
    mover.y = 1
    expect(rule.effect(state, { sourcePiece: mover, playerId: 'player-red' }).success).toBe(true)
    expect(mover.currentHp).toBe(8)
    expect(red.statusTags.filter((tag: any) => tag.type === 'lethal-toxin')).toEqual([
      expect.objectContaining({ value: 2, extraValue: 1 }),
    ])
    expect(red.rules).toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(state.extensions.tileEffects).toContainEqual(expect.objectContaining({
      tileType: 'lethal-toxin',
      x: 2,
      y: 1,
    }))

    mover.x = 2
    mover.y = 1
    expect(rule.effect(state, { sourcePiece: mover, playerId: 'player-red' }).success).toBe(true)
    expect(mover.currentHp).toBe(4)
    expect(red.statusTags.filter((tag: any) => tag.type === 'lethal-toxin')).toHaveLength(0)
    expect(red.rules || []).not.toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(state.extensions.tileEffects.filter((effect: any) => effect.tileType === 'lethal-toxin')).toHaveLength(0)
  })
})
