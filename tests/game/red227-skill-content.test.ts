/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills are exercised through the runtime. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { executeSkillFunction } from '@/lib/game/skills'
import { previewBattleAction } from '@/lib/game/skill-preview'
import { prepareAction } from '@/lib/game/targeting'
import { RANDOM_STREAM_NAMES, RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction, type BattleState } from '@/lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const DATA_ROOT = join(process.cwd(), 'data')

function loadSkill(skillId: string): any {
  return JSON.parse(readFileSync(join(DATA_ROOT, 'skills', `${skillId}.json`), 'utf8'))
}

function executeSkill(
  skillId: string,
  state: BattleState,
  source: any,
  target: any,
  rootSeed = 227,
) {
  const skill = loadSkill(skillId)
  state.skillsById[skillId] = skill
  const runtime = new RuleRuntime({ rootSeed })
  const result = withRuleRuntime(runtime, () => executeSkillFunction(skill, {
    piece: source,
    target,
    targetPosition: null,
    targets: [{ info: target, pos: null }],
    battle: state,
    skill,
  }, state))
  return { result, runtime, skill }
}

function landingFor(skillId: string, rootSeed: number) {
  const source = makePiece({
    instanceId: `${skillId}-source-${rootSeed}`,
    templateId: skillId.startsWith('sonic') ? 'sonic' : 'blue-kenshin',
    x: 0,
    y: 2,
    attack: 4,
  }) as any
  const target = makePiece({
    instanceId: `${skillId}-target-${rootSeed}`,
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 3,
    y: 2,
    currentHp: 30,
    maxHp: 30,
  }) as any
  const state = makeState({ pieces: [source, target], width: 7, height: 5 })
  const execution = executeSkill(skillId, state, source, target, rootSeed)
  return { ...execution, source, target, state }
}

afterEach(() => globalTriggerSystem.clearRules())

describe('RED-227 deterministic skill landing content', () => {
  it.each(['sonic-homing-attack', 'kenshin-amakakeru'])('chooses among legal adjacent landings with the injected seed: %s', skillId => {
    const first = landingFor(skillId, 227)
    const repeated = landingFor(skillId, 227)
    const alternate = landingFor(skillId, 3)

    expect(first.result).toMatchObject({ success: true })
    expect(repeated.result).toMatchObject({ success: true })
    expect(alternate.result).toMatchObject({ success: true })
    expect({ x: repeated.source.x, y: repeated.source.y }).toEqual({ x: first.source.x, y: first.source.y })
    expect({ x: alternate.source.x, y: alternate.source.y }).not.toEqual({ x: first.source.x, y: first.source.y })
    for (const run of [first, alternate]) {
      expect(Math.abs(run.source.x - run.target.x) + Math.abs(run.source.y - run.target.y)).toBe(1)
      expect(run.target.currentHp).toBe(skillId === 'sonic-homing-attack' ? 28 : 22)
    }
    expect(first.runtime.getCursor('skill/effect')).toBe(1)
  })

  it.each(['sonic-homing-attack', 'kenshin-amakakeru'])('keeps the no-legal-landing cancellation: %s', skillId => {
    const source = makePiece({ instanceId: `${skillId}-source`, x: 0, y: 2, attack: 4 }) as any
    const target = makePiece({
      instanceId: `${skillId}-target`, ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 2,
      currentHp: 30, maxHp: 30,
    }) as any
    const blockers = [[3, 1], [4, 2], [3, 3], [2, 2]].map(([x, y], index) => makePiece({
      instanceId: `${skillId}-blocker-${index}`, x, y,
    }) as any)
    const state = makeState({ pieces: [source, target, ...blockers], width: 7, height: 5 })

    const { result } = executeSkill(skillId, state, source, target)

    expect(result).toMatchObject({ success: false, message: '目标相邻地格没有合法落点' })
    expect(source).toMatchObject({ x: 0, y: 2 })
    expect(target.currentHp).toBe(30)
  })
})

describe('RED-227 random landing preview policy', () => {
  it.each(['sonic-homing-attack', 'kenshin-amakakeru'])('fails closed without consuming the live state or runtime: %s', skillId => {
    const skill = loadSkill(skillId)
    const source = asPieceInstance(makePiece({
      instanceId: `${skillId}-preview-source`,
      templateId: skillId === 'sonic-homing-attack' ? 'sonic' : 'blue-kenshin',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 2,
      attack: 4,
      skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }],
    }))
    const target = asPieceInstance(makePiece({
      instanceId: `${skillId}-preview-target`,
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 2,
      currentHp: 30,
      maxHp: 30,
    }))
    const state = makeState({ pieces: [source, target], width: 7, height: 5 })
    state.pieces = [source, target]
    state.skillsById = { [skillId]: skill }
    state.players[0].chargePoints = 2

    const draft = {
      type: skill.chargeCost ? 'useChargeSkill' as const : 'useBasicSkill' as const,
      playerId: 'player-red',
      pieceId: source.instanceId,
      skillId,
    }
    const prepared = prepareAction(state, draft)
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    const action = {
      ...draft,
      targetPieceId: target.instanceId,
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
    }
    const beforeState = JSON.stringify(state)
    const runtime = new RuleRuntime({
      rootSeed: 227,
      cursors: { [RANDOM_STREAM_NAMES.skillEffect]: 7 },
      tick: 3,
    })
    const beforeRuntime = runtime.snapshot()

    const result = withRuleRuntime(runtime, () => previewBattleAction(state, action, 'player-red'))
    expect(result).toMatchObject({ status: 'unavailable', reason: 'preview-unavailable' })
    expect(JSON.stringify(state)).toBe(beforeState)
    expect(runtime.snapshot()).toEqual(beforeRuntime)
    // Prove this is an executable random action, not an unavailable preview
    // caused by a malformed command or insufficient resources.
    const liveRuntime = new RuleRuntime({ rootSeed: 227 })
    const actual = withRuleRuntime(liveRuntime, () => applyBattleAction(state, action))
    expect(actual.pieces.find(piece => piece.instanceId === target.instanceId)?.currentHp)
      .toBe(skillId === 'sonic-homing-attack' ? 28 : 22)
    expect(liveRuntime.getCursor(RANDOM_STREAM_NAMES.skillEffect)).toBe(1)
  })
})

describe('RED-227 Edgar Fisticuffs content', () => {
  it('publishes the two-hit physical damage and per-hit recovery preview', () => {
    const skill = loadSkill('edgar-fisticuffs')

    expect(skill).toMatchObject({ powerMultiplier: 0.5 })
    expect(skill.description).toContain('2次0.5倍物理伤害')
    expect(skill.description).toContain('每次实际造成伤害回复1')
    expect(skill.previewCode).toContain('2次0.5倍物理伤害')
    expect(skill.previewCode).toContain('每次实际造成伤害回复1')
  })

  it('deals two half physical hits and heals once for each actual hit', () => {
    const source = makePiece({ instanceId: 'edgar-two-hit', templateId: 'edgar', attack: 10, currentHp: 50, maxHp: 100, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-two-hit-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 30, maxHp: 30, x: 1, y: 0 }) as any
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })

    const { result } = executeSkill('edgar-fisticuffs', state, source, target)

    expect(result).toMatchObject({ success: true })
    expect(target.currentHp).toBe(20)
    expect(source.currentHp).toBe(52)
    expect(state.actions?.filter(action => action.type === 'damage' && action.payload?.targetId === target.instanceId)).toHaveLength(2)
  })

  it('does not heal twice when the first hit kills the target', () => {
    const source = makePiece({ instanceId: 'edgar-first-hit-kill', templateId: 'edgar', attack: 10, currentHp: 50, maxHp: 100, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-first-hit-kill-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 5, maxHp: 5, x: 1, y: 0 }) as any
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })

    const { result } = executeSkill('edgar-fisticuffs', state, source, target)

    expect(result).toMatchObject({ success: true })
    expect(source.currentHp).toBe(51)
    expect(state.pieces.some(piece => piece.instanceId === target.instanceId)).toBe(false)
    expect(state.graveyard.filter(piece => piece.instanceId === target.instanceId)).toHaveLength(1)
  })

  it('does not heal when a numeric shield absorbs both hits', () => {
    const source = makePiece({ instanceId: 'edgar-blocked', templateId: 'edgar', attack: 10, currentHp: 50, maxHp: 100, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-blocked-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 30, maxHp: 30, x: 1, y: 0 }) as any
    target.shield = 20
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })

    const { result } = executeSkill('edgar-fisticuffs', state, source, target)

    expect(result).toMatchObject({ success: true })
    expect(source.currentHp).toBe(50)
    expect(target.currentHp).toBe(30)
    expect(target.shield).toBe(10)
  })

  it('uses the engine minimum one damage after high defense reduction', () => {
    const source = makePiece({ instanceId: 'edgar-high-defense', templateId: 'edgar', attack: 10, currentHp: 50, maxHp: 100, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-high-defense-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 30, maxHp: 30, x: 1, y: 0 }) as any
    target.defense = 99
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })

    executeSkill('edgar-fisticuffs', state, source, target)

    expect(source.currentHp).toBe(52)
    expect(target.currentHp).toBe(28)
    expect(state.actions?.filter(action => action.type === 'damage' && action.payload?.targetId === target.instanceId).map(action => action.payload?.finalDamage)).toEqual([1, 1])
  })

  it('caps recovery at full health', () => {
    const source = makePiece({ instanceId: 'edgar-full-health', templateId: 'edgar', attack: 10, currentHp: 100, maxHp: 100, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-full-health-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 30, maxHp: 30, x: 1, y: 0 }) as any
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })

    executeSkill('edgar-fisticuffs', state, source, target)

    expect(source.currentHp).toBe(100)
    expect(target.currentHp).toBe(20)
  })

  it('does not revive Edgar after a lethal reflected hit', () => {
    const source = makePiece({ instanceId: 'edgar-reflected', templateId: 'edgar', attack: 10, currentHp: 3, maxHp: 10, x: 0, y: 0 }) as any
    const target = makePiece({ instanceId: 'edgar-reflected-target', ownerPlayerId: 'player-blue', faction: 'blue', currentHp: 30, maxHp: 30, x: 1, y: 0 }) as any
    const state = makeState({ pieces: [source, target], width: 4, height: 2 })
    let reflected = false
    globalTriggerSystem.addRule({
      id: 'red227-reflect-once',
      name: 'red227-reflect-once',
      description: '',
      trigger: { type: 'afterDamageTaken' },
      effect: (_battle: BattleState, context: any) => {
        if (reflected || context.piece?.instanceId !== target.instanceId) return { success: true }
        reflected = true
        context.damageQueue.push({ attacker: target, target: source, damage: 99, damageType: 'true', skillId: 'red227-reflect' })
        return { success: true }
      },
    } as any)

    const { result } = executeSkill('edgar-fisticuffs', state, source, target)

    expect(result).toMatchObject({ success: true })
    expect(reflected).toBe(true)
    expect(source.currentHp).toBe(0)
    expect(state.pieces.some(piece => piece.instanceId === source.instanceId)).toBe(false)
    expect(state.graveyard.filter(piece => piece.instanceId === source.instanceId)).toHaveLength(1)
  })
})
