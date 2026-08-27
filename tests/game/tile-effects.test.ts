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

  it('creates a ground sticky-bomb presentation and removes it on explosion', () => {
    const tracer = makePiece({
      instanceId: 'tracer',
      templateId: 'tracer',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    })
    const state = makeState({ pieces: [tracer] }) as any
    state.extensions.tileEffects = [
      { x: 0, y: 0, sourceId: 'unrelated', tileType: 'shadow-step' },
    ]

    const placed = executeGridSkill(state, tracer, 'sticky-bomb', 2, 1)

    expect(placed.success).toBe(true)
    const bomb = state.extensions.stickyBombs[0]
    expect(bomb.id).toMatch(/^sticky-bomb-/)
    expect(state.extensions.tileEffects).toContainEqual(expect.objectContaining({
      x: 2,
      y: 1,
      sourceId: bomb.id,
      tileType: 'sticky-bomb',
    }))

    const explode = loadSkill('sticky-bomb-explode')
    const exploded = executeSkillFunction(explode, {
      piece: tracer,
      playerId: 'player-blue',
      skill: explode,
    } as any, state)

    expect(exploded.success).toBe(true)
    expect(state.extensions.stickyBombs).toHaveLength(0)
    expect(state.extensions.tileEffects).toEqual([
      { x: 0, y: 0, sourceId: 'unrelated', tileType: 'shadow-step' },
    ])
  })

  it('does not create a tile effect when sticky bomb attaches to a piece', () => {
    const tracer = makePiece({
      instanceId: 'tracer',
      templateId: 'tracer',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 1,
    })
    const target = makePiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
    })
    const state = makeState({ pieces: [tracer, target] }) as any

    const placed = executeGridSkill(state, tracer, 'sticky-bomb', 2, 1)

    expect(placed.success).toBe(true)
    expect(state.extensions.stickyBombs[0].attachedPieceId).toBe('target')
    expect(state.extensions.tileEffects ?? []).not.toContainEqual(
      expect.objectContaining({ tileType: 'sticky-bomb' }),
    )
  })
})
