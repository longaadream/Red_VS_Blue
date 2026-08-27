/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }
vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    addRule: vi.fn(),
    checkTriggers: vi.fn(() => TRIGGER_OK),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
    snapshotTransactionState: vi.fn(() => ({ nextRootEventId: 0, ruleLimits: [] })),
    restoreTransactionState: vi.fn(),
    removeRule: vi.fn(),
    updateCooldowns: vi.fn(),
  },
  TriggerType: {},
}))

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import type { SkillDefinition } from '@/lib/game/skills'
import { executeSkillFunction } from '@/lib/game/skills'
import { traceProjectile } from '@/lib/game/spatial'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

const PROJECTILE_SKILL_IDS = [
  'sleep-dart',
  'blackwidow-lethal-strike',
  'hellfire-shotgun',
] as const
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())


function loadSkill(skillId: string): SkillDefinition {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'skills', `${skillId}.json`), 'utf8'))
}

function namedPiece(overrides: Parameters<typeof makePiece>[0]) {
  const piece = makePiece(overrides) as any
  piece.name = overrides?.instanceId || piece.instanceId
  return piece
}

function setTerrain(state: any, x: number, type: 'floor' | 'wall' | 'cover' | 'hole', bulletPassable: boolean) {
  const tile = state.map.tiles.find((candidate: any) => candidate.x === x && candidate.y === 0)
  tile.props = { ...tile.props, type, walkable: type === 'floor' || type === 'cover', bulletPassable }
}

function runProjectileSkill(
  skillId: typeof PROJECTILE_SKILL_IDS[number],
  pieces: any[],
  configure?: (state: any) => void,
) {
  const skill = loadSkill(skillId)
  const state = makeState({ pieces, width: 6, height: 1, currentPlayerId: 'player-red', phase: 'action' }) as any
  for (let x = 0; x < state.map.width; x += 1) setTerrain(state, x, 'floor', true)
  configure?.(state)
  const caster = state.pieces[0]
  const result = withRuleRuntime(new RuleRuntime({ rootSeed: 32, tick: 1 }), () => executeSkillFunction(skill, {
    piece: caster,
    target: null,
    targetPosition: { x: 5, y: 0 },
    battle: state,
    skill,
  } as any, state))
  return { result, state }
}

function expectSkillAffected(skillId: typeof PROJECTILE_SKILL_IDS[number], piece: any) {
  if (skillId === 'sleep-dart') {
    expect(piece.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'sleep' })]))
  } else {
    expect(piece.currentHp).toBeLessThan(100)
  }
}

describe('deterministic projectile trace facts', () => {
  it('returns ordered cells, living pieces, terrain, and the first boundary without mutating state', () => {
    const caster = namedPiece({ instanceId: 'caster', x: 0, y: 0 })
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0 })
    const dead = namedPiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 0 })
    const summon = namedPiece({ instanceId: 'summon', templateId: 'summoned-unit', ownerPlayerId: 'player-blue', x: 2, y: 0 })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 0 })
    const state = makeState({ pieces: [enemy, dead, caster, summon, ally], width: 5, height: 1 }) as any
    for (let x = 0; x < state.map.width; x += 1) setTerrain(state, x, 'floor', true)
    setTerrain(state, 2, 'hole', true)
    setTerrain(state, 3, 'cover', false)
    const before = JSON.stringify(state)

    const events = traceProjectile(state, { x: 0, y: 0 }, { x: 1, y: 0 }, { excludePieceId: 'caster' })
    const summary = events.map((event: any) => {
      if (event.type === 'piece') return `piece:${event.piece.instanceId}@${event.distance}`
      if (event.type === 'terrain') return `terrain:${event.tile.props.type}:${event.blocksProjectile}@${event.distance}`
      return `${event.type}:${event.x},${event.y}@${event.distance}`
    })

    expect(summary).toEqual([
      'cell:1,0@1',
      'piece:ally@1',
      'terrain:floor:false@1',
      'cell:2,0@2',
      'piece:summon@2',
      'terrain:hole:false@2',
      'cell:3,0@3',
      'piece:enemy@3',
      'terrain:cover:true@3',
      'cell:4,0@4',
      'terrain:floor:false@4',
      'boundary:5,0@5',
    ])
    expect(JSON.stringify(state)).toBe(before)
  })

  it('uses wall, cover, and hole defaults when no projectile-passability field is present', () => {
    const blocksByType = (type: 'wall' | 'cover' | 'hole') => {
      const caster = namedPiece({ instanceId: 'caster', x: 0, y: 0 })
      const state = makeState({ pieces: [caster], width: 3, height: 1 }) as any
      const tile = state.map.tiles.find((candidate: any) => candidate.x === 1 && candidate.y === 0)
      tile.props = { type, walkable: type === 'cover' }

      const terrain = traceProjectile(
        state,
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { maxDistance: 1 },
      ).find(event => event.type === 'terrain')
      return terrain?.type === 'terrain' ? terrain.blocksProjectile : undefined
    }

    expect(blocksByType('wall')).toBe(true)
    expect(blocksByType('cover')).toBe(true)
    expect(blocksByType('hole')).toBe(false)
  })

  it('lets skill code continue after piece and terrain facts for penetration or special behavior', () => {
    const caster = namedPiece({ instanceId: 'caster', x: 0, y: 0 })
    const first = namedPiece({ instanceId: 'first', ownerPlayerId: 'player-blue', x: 1, y: 0 })
    const second = namedPiece({ instanceId: 'second', ownerPlayerId: 'player-blue', x: 3, y: 0 })
    const state = makeState({ pieces: [caster, first, second], width: 5, height: 1 }) as any

    const penetrated = traceProjectile(state, { x: 0, y: 0 }, { x: 1, y: 0 })
      .filter((event: any) => event.type === 'piece')
      .map((event: any) => event.piece.instanceId)

    expect(penetrated).toEqual(['first', 'second'])
  })

  it('rejects non-cardinal directions and reports boundaries in every cardinal direction', () => {
    const state = makeState({ width: 3, height: 3 }) as any
    expect(() => traceProjectile(state, { x: 1, y: 1 }, { x: 1, y: 1 })).toThrow(/cardinal/i)

    const boundaries = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ].map(direction => traceProjectile(state, { x: 1, y: 1 }, direction).at(-1))

    expect(boundaries).toEqual([
      expect.objectContaining({ type: 'boundary', x: 3, y: 1, distance: 2 }),
      expect.objectContaining({ type: 'boundary', x: -1, y: 1, distance: 2 }),
      expect.objectContaining({ type: 'boundary', x: 1, y: 3, distance: 2 }),
      expect.objectContaining({ type: 'boundary', x: 1, y: -1, distance: 2 }),
    ])
  })
})

describe.each(PROJECTILE_SKILL_IDS)('%s migrated projectile behavior', (skillId) => {
  it('hits a living enemy and a living summon', () => {
    for (const target of [
      namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 }),
      namedPiece({ instanceId: 'summon', templateId: 'summoned-unit', ownerPlayerId: 'player-blue', x: 1, y: 0 }),
    ]) {
      const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 })
      const { state } = runProjectileSkill(skillId, [caster, target])
      expectSkillAffected(skillId, state.pieces.find((piece: any) => piece.instanceId === target.instanceId))
    }
  })

  it('uses skill-owned friendly-fire behavior while every living ally blocks the line', () => {
    const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 })
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 1, y: 0 })
    const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0 })
    const { state } = runProjectileSkill(skillId, [caster, ally, enemy])

    expect(enemy.currentHp).toBe(100)
    expect(enemy.statusTags).toEqual([])
    if (skillId === 'hellfire-shotgun') expect(ally.currentHp).toBeLessThan(100)
    else {
      expect(ally.currentHp).toBe(100)
      expect(ally.statusTags).toEqual([])
    }
    expect(state.pieces.find((piece: any) => piece.instanceId === 'caster')).toBeTruthy()
  })

  it('lets a hole pass, stops at an empty cover or wall, and sees an occupant before cover termination', () => {
    const makeLine = () => [
      namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 }),
      namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 0 }),
    ]

    const throughHole = runProjectileSkill(skillId, makeLine(), state => setTerrain(state, 1, 'hole', true)).state
    expectSkillAffected(skillId, throughHole.pieces.find((piece: any) => piece.instanceId === 'enemy'))

    for (const [terrain, bulletPassable] of [['cover', false], ['wall', false]] as const) {
      const blocked = runProjectileSkill(skillId, makeLine(), state => setTerrain(state, 1, terrain, bulletPassable)).state
      const enemy = blocked.pieces.find((piece: any) => piece.instanceId === 'enemy')
      expect(enemy.currentHp).toBe(100)
      expect(enemy.statusTags).toEqual([])
    }

    const occupiedCoverPieces = [
      namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 }),
      namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 }),
    ]
    const occupiedCover = runProjectileSkill(skillId, occupiedCoverPieces, state => setTerrain(state, 1, 'cover', false)).state
    expectSkillAffected(skillId, occupiedCover.pieces.find((piece: any) => piece.instanceId === 'enemy'))
  })
})

describe('projectile targeting and presentation contract', () => {
  it.each(PROJECTILE_SKILL_IDS)('declares orthogonal non-source candidates for %s without engine ID whitelists', (skillId) => {
    const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const state = makeState({ pieces: [caster], width: 6, height: 5 }) as any
    const skill = loadSkill(skillId)
    state.skillsById[skillId] = skill
    caster.skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId,
    } as any)

    expect(prepared.kind).toBe('needTarget')
    const keys = new Set(prepared.kind === 'needTarget' ? prepared.candidates.map(targetRefKey) : [])
    expect(keys.has('cell:2,2')).toBe(false)
    expect(keys.has('cell:3,3')).toBe(false)
    if (skillId !== 'hellfire-shotgun') expect(keys.has('cell:3,2')).toBe(true)
  })

  it('only highlights shotgun directions containing a piece before blocking terrain', () => {
    const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2 })
    const rightTarget = namedPiece({ instanceId: 'right-target', ownerPlayerId: 'player-blue', x: 4, y: 2 })
    const state = makeState({ pieces: [caster, rightTarget], width: 6, height: 5 }) as any
    const skill = loadSkill('hellfire-shotgun')
    state.skillsById[skill.id] = skill
    caster.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: skill.id,
    } as any)
    expect(prepared.kind).toBe('needTarget')
    const candidates = prepared.kind === 'needTarget' ? prepared.candidates : []

    expect(candidates).not.toHaveLength(0)
    expect(candidates.every(ref => ref.type === 'cell' && ref.y === 2 && ref.x > 2)).toBe(true)
  })

  it('contains no migrated projectile skill IDs in engine or authoritative targeting code', () => {
    const formalCode = [
      readFileSync(resolve(process.cwd(), 'lib', 'game', 'turn.ts'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'lib', 'game', 'targeting.ts'), 'utf8'),
    ].join('\n')

    for (const skillId of PROJECTILE_SKILL_IDS) expect(formalCode).not.toContain(skillId)
    expect(loadSkill('blackwidow-lethal-strike').form).toBe('projectile')
  })
})

describe('death blossom approved area behavior', () => {
  it('damages only living enemies in the caster-centered 3×3 area and ignores projectile blockers', () => {
    const skill = loadSkill('death-blossom')
    const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2, attack: 10 })
    const enemyCorner = namedPiece({ instanceId: 'enemy-corner', ownerPlayerId: 'player-blue', x: 1, y: 1 })
    const enemyEdge = namedPiece({ instanceId: 'enemy-edge', ownerPlayerId: 'player-blue', x: 2, y: 3 })
    const ally = namedPiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 3, y: 3 })
    const outside = namedPiece({ instanceId: 'outside', ownerPlayerId: 'player-blue', x: 0, y: 2 })
    const defeated = namedPiece({ instanceId: 'defeated', ownerPlayerId: 'player-blue', x: 3, y: 2, currentHp: 0 })
    const state = makeState({ pieces: [caster, enemyCorner, enemyEdge, ally, outside, defeated], width: 5, height: 5 }) as any
    const cover = state.map.tiles.find((tile: any) => tile.x === 1 && tile.y === 1)
    cover.props = { ...cover.props, type: 'cover', bulletPassable: false }

    const result = withRuleRuntime(new RuleRuntime({ rootSeed: 32, tick: 1 }), () => executeSkillFunction(skill, {
      piece: caster, target: null, targetPosition: null, battle: state, skill,
    } as any, state))

    expect(result.success).toBe(true)
    expect(enemyCorner.currentHp).toBe(80)
    expect(enemyEdge.currentHp).toBe(80)
    expect(ally.currentHp).toBe(100)
    expect(outside.currentHp).toBe(100)
    expect(defeated.currentHp).toBe(0)
    expect(skill.form).toBe('area')
    expect(skill.description).toBe('对以自身为中心的3×3范围内所有敌人造成200%攻击力的物理伤害。')
    expect((skill as any).targetText).toBe('以自身为中心的3×3范围内所有敌人')
    expect(skill.previewCode).toContain('以自身为中心的3×3范围内所有敌人')
  })
})

describe('fixed-seed projectile determinism', () => {

  it('produces the same sleep status and state from the same state, seed, and direction', () => {
    const run = () => {
      const caster = namedPiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
      const enemy = namedPiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 })
      return runProjectileSkill('sleep-dart', [caster, enemy]).state
    }

    expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
  })
})
