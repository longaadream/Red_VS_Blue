/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise trusted dynamic piece fields. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyPieceInstance,
  capturePieceInstance,
} from '@/lib/game/author-instance-state'
import { clearRuleCache, clearSkillDefinitionCache } from '@/lib/game/skills'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { withPositionWriteGuard } from '@/lib/game/position-write-guard'

const profileRoot = mkdtempSync(join(tmpdir(), 'rvb-author-instance-state-'))
const previousProfileRoot = process.env.RVB_PROFILE_ROOT

const skill = {
  id: 'author-instance-skill',
  name: 'Author instance skill',
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

function makeLivePiece(instanceId: string, overrides: Record<string, unknown> = {}): any {
  return asPieceInstance(makePiece({
    instanceId,
    templateId: 'author-instance-piece',
    name: 'Author instance piece',
    ownerPlayerId: 'player-red',
    faction: 'red',
    currentHp: 80,
    maxHp: 120,
    attack: 14,
    defense: 7,
    moveRange: 4,
    x: instanceId === 'source' ? 1 : 4,
    y: instanceId === 'source' ? 1 : 3,
    ...overrides,
  } as any))
}

function makeBattle() {
  const external = makeLivePiece('external', { x: 2, y: 2 })
  const source = makeLivePiece('source', {
    currentHp: 47,
    skills: [{ skillId: skill.id, level: 2, currentCooldown: 2, usesRemaining: 1 }],
    statusTags: [{ id: 'author-status', type: 'author-state', intensity: 3, relatedRules: ['author-instance-rule'] }],
    rules: [{ id: 'author-instance-rule', limits: { currentCooldown: 2, uses: 1, remainingDuration: 3 }, effect: () => ({ success: true }) }],
  })
  const target = makeLivePiece('target', {
    currentHp: 63,
    skills: [{ skillId: skill.id, level: 1, currentCooldown: 0, usesRemaining: -1 }],
    statusTags: [{ id: 'stale', type: 'stale' }],
    rules: [],
    x: 5,
    y: 4,
  })
  source.shield = 22
  source.defense = 7
  source.rules[0].customRef = external
  source.buffs = [{ type: 'power', value: 2, duration: 3, source: 'external' }]
  source.debuffs = [{ type: 'slow', value: 1, duration: 2, source: 'external' }]
  source.ruleTags = ['author-instance-rule']
  source.displaySkills = [{ skillId: skill.id, level: 2, currentCooldown: 2, usesRemaining: 1 }]
  source.limitedSkillUses = { [skill.id]: 1 }
  source.spentPassives = ['author-passive']
  source.initialDefinition = {
    stats: { maxHp: 120, attack: 14, defense: 7, moveRange: 4 },
    skills: [{ skillId: skill.id, level: 1 }],
    rules: ['author-instance-rule'],
    statusTags: [],
  }
  source.teamId = 'red'
  source.isCore = true
  source.dynamicExtension = { nested: { counter: 4 }, externalId: 'external' }
  source.externalRef = external
  target.ownerPlayerId = 'player-blue'
  target.teamId = 'blue'
  target.isCore = false
  target.shield = 99
  target.staleDynamic = { shouldBeCleared: true }
  target.externalRef = { stale: true }
  const battle: any = makeState({ pieces: [source, target, external] })
  battle.skillsById = { [skill.id]: skill }
  battle.extensions.flowState = [
    {
      schemaVersion: 1,
      scope: 'piece',
      entityId: 'source',
      ownerPlayerId: 'player-red',
      namespace: 'author',
      name: 'marker',
      value: { count: 4 },
      lifetime: 'while-alive',
      projectionVisibility: 'owner',
    },
    {
      schemaVersion: 1,
      scope: 'piece',
      entityId: 'target',
      ownerPlayerId: 'player-blue',
      namespace: 'author',
      name: 'stale',
      value: { count: 9 },
      lifetime: 'battle',
      projectionVisibility: 'owner',
    },
    {
      schemaVersion: 1,
      scope: 'player',
      entityId: 'player-red',
      ownerPlayerId: 'player-red',
      namespace: 'author',
      name: 'player-marker',
      value: { count: 7 },
      lifetime: 'battle',
      projectionVisibility: 'owner',
    },
  ]
  return { battle, source, target, external }
}

beforeAll(() => {
  mkdirSync(join(profileRoot, 'data', 'rules'), { recursive: true })
  writeFileSync(join(profileRoot, 'data', 'rules', 'author-instance-rule.json'), JSON.stringify({
    id: 'author-instance-rule',
    name: 'Author instance rule',
    description: 'test rule',
    trigger: { type: 'afterMove' },
    skillCode: 'return { success: true };',
    limits: { cooldownTurns: 4, maxUses: 5 },
  }))
  process.env.RVB_PROFILE_ROOT = profileRoot
  clearRuleCache()
  clearSkillDefinitionCache()
})
afterAll(() => {
  clearRuleCache()
  clearSkillDefinitionCache()
  if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
  else process.env.RVB_PROFILE_ROOT = previousProfileRoot
  rmSync(profileRoot, { recursive: true, force: true })
})

describe('generic author piece instance state', () => {
  it('restores supported legacy status records that have a type but no instance id', () => {
    const { battle, source, target } = makeBattle()
    source.statusTags = [{ type: 'momentum-core', stacks: 3 }]
    const saved = capturePieceInstance(battle, source.instanceId)
    expect(applyPieceInstance(battle, target.instanceId, saved)).toBe(true)
    expect(target.statusTags).toEqual([{ type: 'momentum-core', stacks: 3 }])
  })

  it('preserves literal reference-shaped extension data and only restores captured rules', () => {
    const { battle, source, target, external } = makeBattle()
    source.rules = []
    source.dynamicExtension = {
      literalRef: { $ref: { kind: 'piece', id: external.instanceId } },
      unavailableLiteralRef: { $ref: { kind: 'piece', id: 'absent' } },
      literalWrapper: { $literal: { $ref: { kind: 'player', id: 'player-red' } } },
      actualRef: external,
    }
    const saved = capturePieceInstance(battle, source.instanceId)
    expect(applyPieceInstance(battle, target.instanceId, saved)).toBe(true)
    expect(target.rules).toEqual([])
    expect(target.statusTags[0].relatedRules).toEqual(['author-instance-rule'])
    expect(target.dynamicExtension.literalRef).toEqual({ $ref: { kind: 'piece', id: external.instanceId } })
    expect(target.dynamicExtension.unavailableLiteralRef).toEqual({ $ref: { kind: 'piece', id: 'absent' } })
    expect(target.dynamicExtension.literalWrapper).toEqual({ $literal: { $ref: { kind: 'player', id: 'player-red' } } })
    expect(target.dynamicExtension.actualRef).toBe(external)
  })

  it('rejects a non-extensible destination before removing any field', () => {
    const { battle, source, target } = makeBattle()
    const saved = capturePieceInstance(battle, source.instanceId)
    const before = Object.getOwnPropertyDescriptors(target)
    Object.preventExtensions(target)
    expect(applyPieceInstance(battle, target.instanceId, saved)).toBe(false)
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(before)
  })

  it('keeps instance application independent of a preceding blocked displacement', () => {
    const { battle, source, target } = makeBattle()
    const flow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    const saved = flow.instances.copy(source.instanceId)
    const position = { x: source.x, y: source.y }
    source.currentHp = 2

    const moved = flow.effects.displace([{ pieceId: source.instanceId, x: target.x, y: target.y }], 'teleport')
    expect(moved.success).toBe(false)
    expect(flow.instances.apply(source.instanceId, saved)).toBe(true)
    expect(source.currentHp).toBe(47)
    expect({ x: source.x, y: source.y }).toEqual(position)
  })

  it('round-trips through a player extension without recursively copying that player store', () => {
    const { battle, source } = makeBattle()
    const flow = createFlowRuntime(battle, { piece: source }, 'skill', {})
    flow.extension.declareValue('piece', source.instanceId, 'content', '层数', 'number', [], 4)
    const saved = flow.instances.copy(source.instanceId)
    flow.extension.declareValue('player', source.ownerPlayerId, 'content', 'saved', 'record', [], saved)
    source.currentHp = 2
    flow.extension.writeValue('piece', source.instanceId, 'content', '层数', '', 'number', [], 99)
    const position = { x: source.x, y: source.y }
    flow.instances.apply(source.instanceId, flow.extension.readValue('player', source.ownerPlayerId, 'content', 'saved', '', 'record', []))
    expect(source.currentHp).toBe(47)
    expect({ x: source.x, y: source.y }).toEqual(position)
    expect(flow.extension.readValue('piece', source.instanceId, 'content', '层数', '', 'number', [])).toBe(4)
    expect(flow.instances.copy(source.instanceId).flowState.some(item => item.name === 'saved')).toBe(false)
    expect(() => flow.instances.apply('absent', saved)).toThrow('无法应用棋子实例信息')
  })

  it('captures and applies complete mutable state while preserving identity, position, and external references', () => {
    const { battle, source, target, external } = makeBattle()
    const snapshot = capturePieceInstance(battle, source.instanceId)

    expect((snapshot.fields.rules as any[])[0]).not.toHaveProperty('effect')
    expect(snapshot.fields.externalRef).toEqual({ $ref: { kind: 'piece', id: external.instanceId } })
    expect(snapshot.flowState[0]).toMatchObject({ entityId: 'source', name: 'marker' })

    const sourcePosition = { x: source.x, y: source.y }
    const targetIdentity = { id: target.instanceId }
    const actionsBefore = battle.actions
    expect(applyPieceInstance(battle, target.instanceId, snapshot)).toBe(true)

    expect(target.instanceId).toBe(targetIdentity.id)
    expect(target.ownerPlayerId).toBe('player-red')
    expect(target.teamId).toBe('red')
    expect(target.isCore).toBe(true)
    expect(target.x).toBe(sourcePosition.x + 4)
    expect(target.y).toBe(sourcePosition.y + 3)
    expect(target.currentHp).toBe(47)
    expect(target.maxHp).toBe(120)
    expect(target.attack).toBe(14)
    expect(target.defense).toBe(7)
    expect(target.moveRange).toBe(4)
    expect(target.shield).toBe(22)
    expect(target.skills).toEqual([{ skillId: skill.id, level: 2, currentCooldown: 2, usesRemaining: 1 }])
    expect(target.displaySkills).toEqual(target.skills)
    expect(target.statusTags).toEqual([{ id: 'author-status', type: 'author-state', intensity: 3, relatedRules: ['author-instance-rule'] }])
    expect(target.buffs).toEqual([{ type: 'power', value: 2, duration: 3, source: 'external' }])
    expect(target.debuffs).toEqual([{ type: 'slow', value: 1, duration: 2, source: 'external' }])
    expect(target.limitedSkillUses).toEqual({ [skill.id]: 1 })
    expect(target.spentPassives).toEqual(['author-passive'])
    expect(target.dynamicExtension).toEqual({ nested: { counter: 4 }, externalId: 'external' })
    expect(target.externalRef).toBe(external)
    expect(target.staleDynamic).toBeUndefined()
    expect(target.rules).toHaveLength(1)
    expect(target.rules[0].effect).toBeTypeOf('function')
    expect(target.rules[0].limits).toMatchObject({ cooldownTurns: 4, maxUses: 5, currentCooldown: 2, uses: 1, remainingDuration: 3 })
    expect(target.rules[0].customRef).toBe(external)
    expect(target.rules[0]).not.toBe(source.rules[0])
    expect(battle.actions).toBe(actionsBefore)

    const records = battle.extensions.flowState as any[]
    expect(records).toContainEqual(expect.objectContaining({ scope: 'piece', entityId: 'source', name: 'marker' }))
    expect(records).toContainEqual(expect.objectContaining({ scope: 'piece', entityId: 'target', name: 'marker', value: { count: 4 } }))
    expect(records).not.toContainEqual(expect.objectContaining({ scope: 'piece', entityId: 'target', name: 'stale' }))
    expect(records).toContainEqual(expect.objectContaining({ scope: 'player', entityId: 'player-red', name: 'player-marker' }))
  })

  it('captures and applies within the position guard without touching protected coordinates', () => {
    const { battle, source, target } = makeBattle()
    const positions = [source.x, source.y, target.x, target.y]
    withPositionWriteGuard(battle, () => {
      const positionGetter = Object.getOwnPropertyDescriptor(target, 'x')?.get
      expect(positionGetter).toBeTypeOf('function')
      const snapshot = capturePieceInstance(battle, source.instanceId)
      expect(snapshot.fields).not.toHaveProperty('x')
      expect(snapshot.fields).not.toHaveProperty('y')
      expect(applyPieceInstance(battle, target.instanceId, snapshot)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(target, 'x')?.get).toBe(positionGetter)
    })
    expect([source.x, source.y, target.x, target.y]).toEqual(positions)
    let invoked = false
    Object.defineProperty(source, 'unsafe', { configurable: true, get: () => { invoked = true; return 1 } })
    expect(() => capturePieceInstance(battle, source.instanceId)).toThrow('does not allow accessors')
    expect(invoked).toBe(false)
  })

  it('makes mutable snapshots independent and resets absent optional fields', () => {
    const { battle, source, target } = makeBattle()
    source.shield = undefined
    const snapshot = capturePieceInstance(battle, source.instanceId)
    source.dynamicExtension.nested.counter = 99
    snapshot.fields.dynamicExtension = { nested: { counter: 8 } }

    expect(applyPieceInstance(battle, target.instanceId, snapshot)).toBe(true)
    expect(target.shield).toBeUndefined()
    expect(target.dynamicExtension).toEqual({ nested: { counter: 8 } })
    ;(snapshot.fields.dynamicExtension as any).nested.counter = 11
    expect(target.dynamicExtension.nested.counter).toBe(8)
  })

  it('rejects invalid, cross-owner, dead, or position-forging snapshots without mutation', () => {
    const { battle, source, target } = makeBattle()
    const snapshot = capturePieceInstance(battle, source.instanceId)
    const before = {
      hp: target.currentHp,
      x: target.x,
      y: target.y,
      fields: { skills: target.skills, statusTags: target.statusTags, staleDynamic: target.staleDynamic },
      flowState: JSON.stringify(battle.extensions.flowState),
    }
    const invalid = (mutate: (copy: any) => void) => {
      const copy = JSON.parse(JSON.stringify(snapshot))
      mutate(copy)
      expect(applyPieceInstance(battle, target.instanceId, copy)).toBe(false)
      expect(target.currentHp).toBe(before.hp)
      expect(target.x).toBe(before.x)
      expect(target.y).toBe(before.y)
      expect(target.skills).toBe(before.fields.skills)
      expect(target.statusTags).toBe(before.fields.statusTags)
      expect(target.staleDynamic).toBe(before.fields.staleDynamic)
      expect(JSON.stringify(battle.extensions.flowState)).toBe(before.flowState)
    }
    invalid(copy => { copy.fields.currentHp = 0 })
    invalid(copy => { copy.fields.x = 99 })
    invalid(copy => { copy.ownerPlayerId = 'player-blue' })
    invalid(copy => { copy.fields.rules[0].effect = 'forged' })
    invalid(copy => { copy.fields.maxHp = Number.NaN })

    target.currentHp = 0
    expect(applyPieceInstance(battle, target.instanceId, snapshot)).toBe(false)
    expect(target.currentHp).toBe(0)
  })
})
