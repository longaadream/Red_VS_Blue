/* eslint-disable @typescript-eslint/no-explicit-any -- authored summon tests exercise JSON author inputs and trigger contexts. */
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { toPublicBattleState } from '@/lib/game/deployment'
import {
  createDeclaredSummonQueueWriter,
  createEffectChain,
  withEffectChain,
} from '@/lib/game/effect-batch'
import {
  authorOutOfPlayStore,
} from '@/lib/game/author-instance-state'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import {
  drainBattleEffectChain,
} from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const AUTHORED_CAPABILITY = {
  version: 1,
  recipe: 'authored-piece',
  maxSummons: 64,
  modes: ['new-instance', 'return-instance'],
} as const

const TEST_SKILL = {
  id: 'author-summon-test-skill',
  name: 'Author summon test skill',
  description: '',
  kind: 'active',
  type: 'normal',
  cooldownTurns: 3,
  maxCharges: 0,
  powerMultiplier: 1,
  range: 'single',
  actionPointCost: 1,
  code: 'function executeSkill(){ return { success: true }; }',
}

function sourcePiece(instanceId = 'source', x = 0, y = 0): any {
  const piece = asPieceInstance(makePiece({
    instanceId,
    templateId: 'author-source',
    name: 'Author source',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x,
    y,
    currentHp: 80,
    maxHp: 100,
    attack: 12,
    defense: 4,
    moveRange: 3,
  } as any))
  piece.defense = 4
  return piece
}

function newState(pieces: any[] = [sourcePiece()]): any {
  const state = makeState({ pieces }) as any
  state.skillsById = { [TEST_SKILL.id]: TEST_SKILL }
  return state
}

function runAuthoredSummon(
  state: any,
  summons: readonly any[],
  sourceId = 'source',
  contentId = 'author-summon-test',
): any {
  const chain = createEffectChain({
    actionId: contentId + ':action',
    chainId: contentId + ':chain',
    turn: state.turn.turnNumber,
    rootSeed: 252,
  })
  createDeclaredSummonQueueWriter(chain, contentId, AUTHORED_CAPABILITY).push({ sourceId, summons })
  const runtime = new RuleRuntime({ rootSeed: 252, tick: 4 })
  return withRuleRuntime(runtime, () => withEffectChain(state, chain, () => {
    const executions = drainBattleEffectChain(state, chain)
    return executions[0]?.result
  }))
}

function summonTemplate(name: string, x: number, y: number, extension?: Record<string, unknown>): any {
  return {
    mode: 'new-instance',
    x,
    y,
    template: {
      templateId: 'author-' + name.toLowerCase(),
      name,
      maxHp: 30,
      currentHp: 21,
      attack: 8,
      defense: 2,
      moveRange: 2,
      statusTags: [{ id: name + '-status', type: 'author-status', intensity: 2 }],
      ...(extension ? { extension } : {}),
    },
  }
}

function triggerRule(id: string, type: string, effect: (battle: any, context: any) => unknown = () => undefined): any {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => ({ success: true, ...(effect(battle, context) as any || {}) }),
  }
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('authored-piece summon batches', () => {
  it('distinguishes the caster from the summoned target in before and after events', () => {
    const state = newState(), observed: any[] = []
    for (const type of ['beforePieceSummoned', 'afterPieceSummoned']) globalTriggerSystem.addRule(triggerRule('observe-' + type, type, (_battle, context) => {
      observed.push({ type, source: context.sourcePiece?.instanceId, target: context.targetPiece?.instanceId })
    }))
    const result = runAuthoredSummon(state, [summonTemplate('New', 1, 1)])
    expect(observed).toEqual(['beforePieceSummoned', 'afterPieceSummoned'].map(type => ({ type, source: 'source', target: result.pieces[0].instanceId })))
  })
  it('does not restore cleaned while-alive state when the original instance returns', () => {
    const departed = sourcePiece('departed', 1, 1), state = newState([sourcePiece(), departed])
    state.extensions.flowState = ['battle', 'while-alive'].map(lifetime => ({ schemaVersion: 1, scope: 'piece', entityId: 'departed', ownerPlayerId: 'player-red', namespace: 'test', name: lifetime, value: 4, lifetime, projectionVisibility: 'owner' }))
    createFlowRuntime(state, { piece: state.pieces[0] }, 'skill', {}).lifecycle.detachActive('departed', 'cleanup')
    runAuthoredSummon(state, [{ mode: 'return-instance', instanceId: 'departed', x: 2, y: 2 }])
    expect(state.extensions.flowState.filter((entry: any) => entry.entityId === 'departed').map((entry: any) => entry.name)).toEqual(['battle'])
  })
  it('creates one new instance with a fixed seed and isolates nested template data', () => {
    const state = newState()
    const extension = { nested: { count: 3 }, list: [{ value: 'original' }] }
    const input = summonTemplate('One', 2, 1, extension)
    const result = runAuthoredSummon(state, [input])

    extension.nested.count = 99
    extension.list[0].value = 'mutated'
    expect(result).toMatchObject({ success: true, results: [{ inputIndex: 0 }] })
    expect(result.pieces).toHaveLength(1)
    expect(result.pieces[0]).toMatchObject({
      instanceId: 'summon-5000000-0',
      templateId: 'author-one',
      name: 'One',
      currentHp: 21,
      maxHp: 30,
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 2,
      y: 1,
      statusTags: [{ id: 'One-status', type: 'author-status', intensity: 2 }],
      extension: { nested: { count: 3 }, list: [{ value: 'original' }] },
    })
    expect(state.pieces.map((piece: any) => piece.instanceId)).toEqual(['source', 'summon-5000000-0'])
  })

  it('commits a same-batch summon before after events and preserves result input alignment', () => {
    const state = newState()
    const afterSnapshots: any[] = []
    globalTriggerSystem.addRule(triggerRule('author-summon-after-observer', 'afterPieceSummoned', battle => {
      afterSnapshots.push({
        ids: battle.pieces.map((piece: any) => piece.instanceId).sort(),
        presentation: battle.extensions?.skillPresentation,
      })
    }))
    const result = runAuthoredSummon(state, [
      summonTemplate('Beta', 3, 1),
      summonTemplate('Alpha', 1, 1),
    ])

    expect(result).toMatchObject({ success: true, results: [
      expect.objectContaining({ inputIndex: 0, piece: expect.objectContaining({ name: 'Beta' }) }),
      expect.objectContaining({ inputIndex: 1, piece: expect.objectContaining({ name: 'Alpha' }) }),
    ] })
    expect(state.pieces).toHaveLength(3)
    expect(afterSnapshots).toHaveLength(2)
    for (const snapshot of afterSnapshots) {
      expect(snapshot.ids).toEqual(state.pieces.map((piece: any) => piece.instanceId).sort())
      expect(snapshot.presentation).toBeUndefined()
    }
  })

  it('installs authored display projection before the first afterPieceSummoned callback', () => {
    const state = newState()
    const observed: any[] = []
    globalTriggerSystem.addRule(triggerRule('author-summon-display-observer', 'afterPieceSummoned', battle => {
      observed.push(toPublicBattleState(battle, 'player-blue').extensions?.skillPresentation)
    }))
    const input = summonTemplate('Masked', 2, 1)
    input.display = { name: 'Public mask', attack: 77, maxHp: 99 }
    const result = runAuthoredSummon(state, [input])
    const summoned = result.pieces[0]

    expect(summoned.name).toBe('Masked')
    expect(summoned.attack).toBe(8)
    expect(observed).toHaveLength(1)
    expect(observed[0].bindings).toEqual([
      expect.objectContaining({
        targetId: summoned.instanceId,
        display: expect.objectContaining({ name: 'Public mask', attack: 77, maxHp: 99 }),
      }),
    ])
  })

  it('rolls back the complete batch when one position is invalid or occupied', () => {
    for (const invalidSummon of [
      summonTemplate('Outside', 99, 1),
      summonTemplate('Occupied', 2, 2),
    ]) {
      const occupant = sourcePiece('occupant', 2, 2)
      const state = newState([sourcePiece(), occupant])
      const before = JSON.stringify(state)
      const valid = summonTemplate('Valid', 1, 1)

      expect(() => runAuthoredSummon(state, [valid, invalidSummon])).toThrow(/Summon position/i)
      expect(JSON.stringify(state)).toBe(before)
      expect(state.pieces.map((piece: any) => piece.instanceId)).toEqual(['source', 'occupant'])
    }
  })

  it('returns the exact detached instance, retaining skills, ownership, core, extension, and flow state', () => {
    const source = sourcePiece('detached', 1, 1)
    source.isCore = true
    source.skills = [{ skillId: TEST_SKILL.id, level: 2, currentCooldown: 2, usesRemaining: 1 }]
    source.displaySkills = [{ skillId: TEST_SKILL.id, level: 2, currentCooldown: 2, usesRemaining: 1 }]
    source.statusTags = [{ id: 'stored-status', type: 'stored', stacks: 4 }]
    source.extension = { nested: { retained: true } }
    source.shield = 7
    source.limitedSkillUses = { [TEST_SKILL.id]: 1 }
    source.spentPassives = ['stored-passive']
    const caller = sourcePiece('caller', 0, 0)
    const state = newState([caller, source])
    state.extensions.flowState = [{
      schemaVersion: 1,
      scope: 'piece',
      entityId: 'detached',
      ownerPlayerId: 'player-red',
      namespace: 'author',
      name: 'marker',
      value: { count: 4 },
      lifetime: 'battle',
      projectionVisibility: 'owner',
    }]

    const flow = createFlowRuntime(state, { piece: caller }, 'skill', {})
    expect(flow.lifecycle.detachActive('detached', 'preserve')).toBe(true)
    expect(state.pieces.map((piece: any) => piece.instanceId)).toEqual(['caller'])
    expect(authorOutOfPlayStore(state).pieces.detached).toBeDefined()
    expect(toPublicBattleState(state, 'player-red').extensions).not.toHaveProperty('authorOutOfPlay')

    const result = runAuthoredSummon(state, [{ mode: 'return-instance', x: 4, y: 3, instanceId: 'detached' }], 'caller')
    const restored = result.pieces[0]
    expect(restored).toMatchObject({
      instanceId: 'detached',
      ownerPlayerId: 'player-red',
      faction: 'red',
      isCore: true,
      currentHp: 80,
      maxHp: 100,
      attack: 12,
      defense: 4,
      moveRange: 3,
      x: 4,
      y: 3,
      skills: [{ skillId: TEST_SKILL.id, level: 2, currentCooldown: 2, usesRemaining: 1 }],
      displaySkills: [{ skillId: TEST_SKILL.id, level: 2, currentCooldown: 2, usesRemaining: 1 }],
      statusTags: [{ id: 'stored-status', type: 'stored', stacks: 4 }],
      extension: { nested: { retained: true } },
      shield: 7,
      limitedSkillUses: { [TEST_SKILL.id]: 1 },
      spentPassives: ['stored-passive'],
    })
    expect(state.extensions.authorOutOfPlay.pieces).not.toHaveProperty('detached')
    expect(state.extensions.flowState).toContainEqual(expect.objectContaining({
      entityId: 'detached',
      name: 'marker',
      value: { count: 4 },
    }))
  })

  it('rejects a missing or duplicate return binding without mutating the board or store', () => {
    const state = newState([sourcePiece('caller', 0, 0)])
    const missingBefore = JSON.stringify(state)
    expect(() => runAuthoredSummon(state, [{ mode: 'return-instance', x: 2, y: 1, instanceId: 'missing' }], 'caller'))
      .toThrow(expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining('原实例已失效') }),
      }))
    expect(JSON.stringify(state)).toBe(missingBefore)

    const detached = sourcePiece('detached', 1, 1)
    const withDetached = newState([sourcePiece('caller', 0, 0), detached])
    createFlowRuntime(withDetached, { piece: withDetached.pieces[0] }, 'skill', {})
      .lifecycle.detachActive('detached', 'preserve')
    const before = JSON.stringify(withDetached)
    expect(() => runAuthoredSummon(withDetached, [
      { mode: 'return-instance', x: 2, y: 1, instanceId: 'detached' },
      { mode: 'return-instance', x: 3, y: 1, instanceId: 'detached' },
    ], 'caller')).toThrow(/instanceId|唯一|unique/i)
    expect(JSON.stringify(withDetached)).toBe(before)
  })
})
