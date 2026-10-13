import { describe, expect, it, vi } from 'vitest'

import { EffectChainFatalError } from '../../lib/game/effect-batch'
import type { PieceInstance } from '../../lib/game/piece'
import { SuspendableActionPending } from '../../lib/game/suspendable-action-transaction'
import {
  AuthorClusterRuntime,
  recordDirectRuleAdded,
  recordDirectSkillAdded,
  type AuthorClusterDefinition,
  type AuthorClusterRuntimeOptions,
} from '../../lib/game/author-clusters'

type TestDefinition = { id: string }

function fatalSignal(): EffectChainFatalError {
  return new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_STATE_INVALID',
    'Cluster test fatal signal',
    {
      actionId: 'author-cluster-test',
      chainId: 'effect-chain:author-cluster-test',
      kind: null,
      depth: null,
      processed: 0,
      limit: 10,
      turn: 1,
      rootSeed: null,
      detached: false,
      budget: 'state',
    },
  )
}

function pendingSignal(): SuspendableActionPending {
  return new SuspendableActionPending(
    {
      consumerKind: 'rule',
      consumerId: 'author-cluster-test',
      eventType: 'authorClusterTest',
      consumerOrdinal: 0,
    },
    {
      kind: 'option',
      playerId: 'player-red',
      title: 'Continue?',
      options: ['continue'],
    },
  )
}

function piece(instanceId = 'piece-1'): PieceInstance {
  return {
    instanceId,
    templateId: 'template',
    name: '测试棋子',
    ownerPlayerId: 'player-red',
    faction: 'red',
    currentHp: 10,
    maxHp: 10,
    attack: 1,
    defense: 1,
    x: 0,
    y: 0,
    moveRange: 1,
    skills: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
    statusTags: [],
    rules: [],
  }
}

function runtime(
  definitions: { skills?: string[]; rules?: string[] } = {},
  overrides: Partial<AuthorClusterRuntimeOptions> = {},
) {
  const skillIds = new Set(definitions.skills ?? [])
  const ruleIds = new Set(definitions.rules ?? [])
  const installedSkills: string[] = []
  const installedRules: string[] = []
  const removedSkills: string[] = []
  const removedRules: string[] = []
  const options: AuthorClusterRuntimeOptions = {
    resolveSkill: id => skillIds.has(id) ? ({ id } satisfies TestDefinition) : undefined,
    resolveRule: id => ruleIds.has(id) ? ({ id } satisfies TestDefinition) : undefined,
    installSkill: (target, id) => {
      target.skills.push({ skillId: id, currentCooldown: 0 })
      installedSkills.push(id)
      return true
    },
    installRule: (target, id) => {
      target.rules.push({ id })
      installedRules.push(id)
      return true
    },
    removeSkill: (target, id) => {
      target.skills = target.skills.filter(skill => skill.skillId !== id)
      removedSkills.push(id)
      return true
    },
    removeRule: (target, id) => {
      target.rules = target.rules.filter(rule => rule.id !== id)
      removedRules.push(id)
      return true
    },
    nextInstanceId: id => `group-${id}`,
    ...overrides,
  }
  return {
    runtime: new AuthorClusterRuntime(options),
    installedSkills,
    installedRules,
    removedSkills,
    removedRules,
  }
}

function cluster(id: string, skills: string[] = [], rules: string[] = [], extension?: Record<string, unknown>): AuthorClusterDefinition {
  return { id, skills, rules, ...(extension === undefined ? {} : { extension }) }
}

describe('author Cluster runtime', () => {
  it('installs a Cluster through host callbacks and stores serializable ownership', () => {
    const harness = runtime({ skills: ['strike'], rules: ['on-hit'] })
    const target = piece()

    const acquired = harness.runtime.acquire(target, cluster('combat', ['strike'], ['on-hit'], { nested: { count: 1 } }))

    expect(acquired).toMatchObject({
      id: 'combat',
      instanceId: 'group-combat',
      skills: ['strike'],
      rules: ['on-hit'],
      extension: { nested: { count: 1 } },
    })
    expect(target.abilityGroups).toEqual([acquired])
    expect(target.abilityGroupOwnership).toEqual({
      skills: { strike: ['group-combat'] },
      rules: { 'on-hit': ['group-combat'] },
    })
    expect(target.skills[0]).toMatchObject({ skillId: 'strike', abilityGroupIds: ['group-combat'] })
    expect(target.rules[0]).toMatchObject({ id: 'on-hit', abilityGroupIds: ['group-combat'] })
    expect(harness.installedSkills).toEqual(['strike'])
    expect(harness.installedRules).toEqual(['on-hit'])
  })

  it('deduplicates repeated acquisition of the same definition and keeps the first extension', () => {
    const harness = runtime({ skills: ['strike'], rules: ['on-hit'] })
    const target = piece()
    const definition = cluster('combat', ['strike'], ['on-hit'], { value: 1 })

    const first = harness.runtime.acquire(target, definition)
    const second = harness.runtime.acquire(target, cluster('combat', ['strike'], ['on-hit'], { value: 2 }))

    expect(second).toBe(first)
    expect(target.abilityGroups).toHaveLength(1)
    expect(first.extension).toEqual({ value: 1 })
    expect(harness.installedSkills).toEqual(['strike'])
    expect(harness.installedRules).toEqual(['on-hit'])
  })

  it('passes the owning piece to scoped resolvers on acquire and remove', () => {
    const resolved: Array<{ id: string; piece: PieceInstance; context?: { clusterInstanceId: string } }> = []
    const harness = runtime({ skills: ['scoped'] }, {
      resolveSkill: (id, source, context?) => {
        resolved.push({ id, piece: source, ...(context ? { context } : {}) })
        return { id }
      },
    })
    const target = piece('source-piece')
    const acquired = harness.runtime.acquire(target, cluster('scoped-group', ['scoped']))

    expect(resolved).toEqual([{ id: 'scoped', piece: target }])
    harness.runtime.remove(target, acquired)
    expect(resolved).toHaveLength(2)
    expect(resolved[1]).toMatchObject({
      id: 'scoped',
      piece: target,
      context: { clusterInstanceId: acquired.instanceId },
    })
  })

  it('adopts existing members without resolving, reinstalling, or resetting them', () => {
    const resolveSkill = vi.fn(() => { throw new Error('resolver must not run') })
    const resolveRule = vi.fn(() => { throw new Error('resolver must not run') })
    const installSkill = vi.fn(() => { throw new Error('skill install must not run') })
    const installRule = vi.fn(() => { throw new Error('rule install must not run') })
    const nextInstanceId = vi.fn((id: string) => `adopt-${id}`)
    const harness = runtime({}, { resolveSkill, resolveRule, installSkill, installRule, nextInstanceId })
    const target = piece('static-piece')
    const existingSkill = {
      skillId: 'static-skill',
      level: 3,
      currentCooldown: 2,
      usesRemaining: 1,
      extension: { untouched: true },
    }
    const existingRule = { id: 'static-rule', marker: 'untouched' }
    target.skills.push(existingSkill)
    target.rules.push(existingRule)

    const adopted = harness.runtime.adopt(target, cluster('static-group', ['static-skill'], ['static-rule'], { source: 'piece-template' }))

    expect(adopted).toMatchObject({
      id: 'static-group',
      instanceId: 'adopt-static-group',
      skills: ['static-skill'],
      rules: ['static-rule'],
      extension: { source: 'piece-template' },
    })
    expect(target.skills[0]).toBe(existingSkill)
    expect(target.skills[0]).toMatchObject({
      skillId: 'static-skill',
      level: 3,
      currentCooldown: 2,
      usesRemaining: 1,
      extension: { untouched: true },
      abilityGroupIds: ['adopt-static-group'],
    })
    expect(target.rules[0]).toBe(existingRule)
    expect(target.rules[0]).toMatchObject({ id: 'static-rule', marker: 'untouched', abilityGroupIds: ['adopt-static-group'] })
    expect(resolveSkill).not.toHaveBeenCalled()
    expect(resolveRule).not.toHaveBeenCalled()
    expect(installSkill).not.toHaveBeenCalled()
    expect(installRule).not.toHaveBeenCalled()
    expect(nextInstanceId).toHaveBeenCalledTimes(1)

    expect(harness.runtime.adopt(target, cluster('static-group', ['static-skill'], ['static-rule'], { source: 'new-definition' }))).toBe(adopted)
    expect(nextInstanceId).toHaveBeenCalledTimes(1)
  })

  it('rejects missing adopted members atomically before allocating an instance', () => {
    const nextInstanceId = vi.fn((id: string) => `adopt-${id}`)
    const harness = runtime({}, { nextInstanceId })
    const target = piece('static-piece')
    const existingSkill = { skillId: 'present', currentCooldown: 4 }
    target.skills.push(existingSkill)
    const before = JSON.stringify(target)

    expect(() => harness.runtime.adopt(target, cluster('incomplete', ['present', 'missing']))).toThrow(/missing/i)

    expect(JSON.stringify(target)).toBe(before)
    expect(target.skills[0]).toBe(existingSkill)
    expect(target.abilityGroups).toBeUndefined()
    expect(target.abilityGroupOwnership).toBeUndefined()
    expect(nextInstanceId).not.toHaveBeenCalled()
  })

  it('shares adopted ownership while preserving members outside the adopted groups', () => {
    const harness = runtime({ skills: ['base', 'shared'], rules: ['base-rule', 'shared-rule'] })
    const target = piece('static-piece')
    const baseSkill = { skillId: 'base', currentCooldown: 7 }
    const sharedSkill = { skillId: 'shared', currentCooldown: 3 }
    const baseRule = { id: 'base-rule', marker: 'base' }
    const sharedRule = { id: 'shared-rule', marker: 'shared' }
    target.skills.push(baseSkill, sharedSkill)
    target.rules.push(baseRule, sharedRule)

    const first = harness.runtime.adopt(target, cluster('static-a', ['shared'], ['shared-rule']))
    const second = harness.runtime.adopt(target, cluster('static-b', ['shared'], ['shared-rule']))

    expect(target.abilityGroupOwnership).toMatchObject({
      skills: { shared: ['group-static-a', 'group-static-b'] },
      rules: { 'shared-rule': ['group-static-a', 'group-static-b'] },
    })
    harness.runtime.remove(target, first)
    expect(target.skills).toEqual([baseSkill, sharedSkill])
    expect(target.rules).toEqual([baseRule, sharedRule])
    expect(harness.removedSkills).toEqual([])
    expect(harness.removedRules).toEqual([])

    harness.runtime.remove(target, second)
    expect(target.skills).toEqual([baseSkill])
    expect(target.rules).toEqual([baseRule])
    expect(harness.removedSkills).toEqual(['shared'])
    expect(harness.removedRules).toEqual(['shared-rule'])
  })

  it('keeps directly protected members when an adopted group is removed', () => {
    const harness = runtime({ skills: ['protected'], rules: ['protected-rule'] })
    const target = piece('static-piece')
    target.skills.push({ skillId: 'protected' })
    target.rules.push({ id: 'protected-rule' })
    recordDirectSkillAdded(target, 'protected')
    recordDirectRuleAdded(target, 'protected-rule')

    const adopted = harness.runtime.adopt(target, cluster('protected-static', ['protected'], ['protected-rule']))
    expect(harness.runtime.remove(target, adopted)).toBe(true)

    expect(target.skills).toHaveLength(1)
    expect(target.rules).toHaveLength(1)
    expect(harness.removedSkills).toEqual([])
    expect(harness.removedRules).toEqual([])
    expect(target.abilityGroupOwnership).toEqual({
      skills: {},
      rules: {},
      protectedSkills: ['protected'],
      protectedRules: ['protected-rule'],
    })
  })

  it('shares members across groups and removes each shared member only with its last owner', () => {
    const harness = runtime({ skills: ['shared', 'only-a', 'only-b'], rules: ['shared-rule'] })
    const target = piece()
    const first = harness.runtime.acquire(target, cluster('a', ['shared', 'only-a'], ['shared-rule']))
    const second = harness.runtime.acquire(target, cluster('b', ['shared', 'only-b'], ['shared-rule']))

    expect(target.abilityGroupOwnership).toMatchObject({
      skills: { shared: ['group-a', 'group-b'], 'only-a': ['group-a'], 'only-b': ['group-b'] },
      rules: { 'shared-rule': ['group-a', 'group-b'] },
    })

    harness.runtime.remove(target, first)
    expect(target.skills.map(skill => skill.skillId)).toEqual(['shared', 'only-b'])
    expect(target.rules.map(rule => rule.id)).toEqual(['shared-rule'])
    expect(harness.removedSkills).toEqual(['only-a'])
    expect(harness.removedRules).toEqual([])

    harness.runtime.remove(target, second)
    expect(target.skills).toEqual([])
    expect(target.rules).toEqual([])
    expect(harness.removedSkills).toEqual(['only-a', 'shared', 'only-b'])
    expect(harness.removedRules).toEqual(['shared-rule'])
    expect(target.abilityGroupOwnership).toEqual({ skills: {}, rules: {} })
  })

  it('preserves members that predate Cluster acquisition', () => {
    const harness = runtime({ skills: ['base', 'added'], rules: ['base-rule', 'added-rule'] })
    const target = piece()
    target.skills.push({ skillId: 'base', currentCooldown: 2 })
    target.rules.push({ id: 'base-rule', marker: 'preexisting' })

    const acquired = harness.runtime.acquire(target, cluster('extra', ['base', 'added'], ['base-rule', 'added-rule']))
    harness.runtime.remove(target, acquired)

    expect(target.skills).toEqual([{ skillId: 'base', currentCooldown: 2 }])
    expect(target.rules).toEqual([{ id: 'base-rule', marker: 'preexisting' }])
    expect(harness.removedSkills).toEqual(['added'])
    expect(harness.removedRules).toEqual(['added-rule'])
    expect(target.abilityGroupOwnership).toEqual({ skills: {}, rules: {} })
  })

  it('clones extension state independently for each acquired piece', () => {
    const harness = runtime({ skills: ['strike'] })
    const sourceExtension = { nested: { values: [1] } }
    const firstPiece = piece('piece-a')
    const secondPiece = piece('piece-b')
    const first = harness.runtime.acquire(firstPiece, cluster('combat', ['strike'], [], sourceExtension))
    const second = harness.runtime.acquire(secondPiece, cluster('combat', ['strike'], [], sourceExtension))

    ;(first.extension!.nested as { values: number[] }).values.push(2)
    expect(second.extension).toEqual({ nested: { values: [1] } })
    expect(sourceExtension).toEqual({ nested: { values: [1] } })
  })

  it('rejects accessor, dangerous, sparse, and unbounded extension fields', () => {
    const harness = runtime()
    const target = piece()
    const accessorExtension: Record<string, unknown> = {}
    Object.defineProperty(accessorExtension, 'value', {
      configurable: true,
      enumerable: true,
      get: () => 1,
    })
    const dangerousExtension: Record<string, unknown> = {}
    Object.defineProperty(dangerousExtension, '__proto__', {
      configurable: true,
      enumerable: true,
      value: 1,
      writable: true,
    })
    const sparseValues: unknown[] = []
    sparseValues.length = 2

    expect(() => harness.runtime.acquire(target, cluster('accessor', [], [], accessorExtension))).toThrow(/accessor|hidden/i)
    expect(() => harness.runtime.acquire(target, cluster('dangerous', [], [], dangerousExtension))).toThrow(/not allowed/i)
    expect(() => harness.runtime.acquire(target, cluster('sparse', [], [], { values: sparseValues }))).toThrow(/sparse|dense/i)
    expect(() => harness.runtime.acquire(target, cluster('unbounded', [], [], { values: new Array(4097).fill(0) }))).toThrow(/limit/i)
    expect(target.abilityGroups).toBeUndefined()
  })

  it('prevalidates every definition before invoking an installation callback', () => {
    const installSkill = vi.fn((target: PieceInstance, id: string) => {
      target.skills.push({ skillId: id })
      return true
    })
    const harness = runtime({ skills: ['present', 'missing'] }, { installSkill })
    const target = piece()
    const before = JSON.stringify(target)
    const resolver = harness.runtime.options.resolveSkill!
    harness.runtime.options.resolveSkill = id => id === 'missing' ? undefined : resolver(id, target)

    expect(() => harness.runtime.acquire(target, cluster('invalid', ['present', 'missing']))).toThrow(/missing/i)
    expect(installSkill).not.toHaveBeenCalled()
    expect(JSON.stringify(target)).toBe(before)
  })

  it('rolls back all affected fields when a later host callback fails', () => {
    const harness = runtime({ skills: ['first'], rules: ['fails'] }, {
      installRule: (target, id) => {
        target.skills[0].currentCooldown = 99
        target.skills = target.skills.slice()
        target.rules.push({ id })
        throw new Error('host failure')
      },
    })
    const target = piece()
    const baseSkill = { skillId: 'base', currentCooldown: 4 }
    const originalSkills = target.skills
    target.skills.push(baseSkill)
    target.abilityGroups = [{ id: 'existing', instanceId: 'existing-1', skills: [], rules: [] }]
    const before = JSON.stringify(target)

    expect(() => harness.runtime.acquire(target, cluster('broken', ['first'], ['fails']))).toThrow(/host failure/i)
    expect(JSON.stringify(target)).toBe(before)
    expect(target.skills).toBe(originalSkills)
    expect(target.skills[0]).toBe(baseSkill)
    expect(target.skills[0].currentCooldown).toBe(4)
    expect(target.abilityGroups).toEqual([{ id: 'existing', instanceId: 'existing-1', skills: [], rules: [] }])
    expect(harness.installedSkills).toEqual(['first'])
  })

  it('restores existing member objects in place when a host callback mutates before a fatal signal', () => {
    const fatal = fatalSignal()
    const harness = runtime({ skills: ['first'], rules: ['fails'] }, {
      installRule: (target, id) => {
        target.skills[0].currentCooldown = 99
        target.skills = target.skills.slice()
        target.rules.push({ id })
        throw fatal
      },
    })
    const target = piece()
    const baseSkill = { skillId: 'base', currentCooldown: 4 }
    const flowHandle = { flow: 'base-skill' }
    const flowHandles = new WeakMap<object, object>([[baseSkill, flowHandle]])
    target.skills.push(baseSkill)

    let caught: unknown
    try {
      harness.runtime.acquire(target, cluster('broken-fatal', ['first'], ['fails']))
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(fatal)
    expect(target.skills[0]).toBe(baseSkill)
    expect(flowHandles.get(target.skills[0])).toBe(flowHandle)
    expect(target.skills[0].currentCooldown).toBe(4)
    expect(target.skills).toEqual([baseSkill])
    expect(target.rules).toEqual([])
    expect(target.abilityGroups).toBeUndefined()
    expect(target.abilityGroupOwnership).toBeUndefined()
  })

  it('rethrows pending EffectChain control signals from resolver and ID callbacks', () => {
    const resolverSignal = pendingSignal()
    const resolverHarness = runtime({ skills: ['first'] }, {
      resolveSkill: () => { throw resolverSignal },
    })
    const resolverTarget = piece()
    let caughtResolver: unknown
    try {
      resolverHarness.runtime.acquire(resolverTarget, cluster('pending-resolver', ['first']))
    } catch (error) {
      caughtResolver = error
    }
    expect(caughtResolver).toBe(resolverSignal)

    const idSignal = pendingSignal()
    const idHarness = runtime({ skills: ['first'] }, {
      nextInstanceId: () => { throw idSignal },
    })
    const idTarget = piece()
    let caughtId: unknown
    try {
      idHarness.runtime.acquire(idTarget, cluster('pending-id', ['first']))
    } catch (error) {
      caughtId = error
    }
    expect(caughtId).toBe(idSignal)
  })

  it('rejects prototype-sensitive member IDs before mutating ownership maps', () => {
    const harness = runtime({ skills: ['__proto__'], rules: ['constructor'] })
    const target = piece()

    expect(() => harness.runtime.acquire(target, cluster('prototype-sensitive', ['__proto__']))).toThrow(/reserved/i)
    expect(() => harness.runtime.acquire(target, cluster('prototype-sensitive', [], ['constructor']))).toThrow(/reserved/i)
    expect(target.abilityGroupOwnership).toBeUndefined()
  })

  it('lets direct host additions protect a shared member from Cluster removal', () => {
    const harness = runtime({ skills: ['shared'], rules: ['shared-rule'] })
    const target = piece()
    const acquired = harness.runtime.acquire(target, cluster('group', ['shared'], ['shared-rule']))

    recordDirectSkillAdded(target, 'shared')
    recordDirectRuleAdded(target, 'shared-rule')
    harness.runtime.remove(target, acquired)

    expect(target.skills).toHaveLength(1)
    expect(target.rules).toHaveLength(1)
    expect(harness.removedSkills).toEqual([])
    expect(harness.removedRules).toEqual([])
    expect(target.abilityGroupOwnership).toEqual({
      skills: {},
      rules: {},
      protectedSkills: ['shared'],
      protectedRules: ['shared-rule'],
    })
  })
})
