import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyGameplayModuleGraph,
  applyGameplayModuleTextBindings,
  createGameplayModuleGraph,
} from '@/lib/skill-graph/module-document'
import {
  assertSkillDefinition,
  clearSkillDefinitionCache,
  loadAllSkillsById,
  loadSkillById,
  type SkillDefinition,
} from '@/lib/game/skills'
import {
  createRuleExecutionContext,
  withRuleExecutionContext,
} from '@/lib/game/rule-runtime'
import { TriggerSystem } from '@/lib/game/triggers'
import { withServerSkills } from '@/lib/game/battle-storage'
import { safeCloneBattleState, type BattleState } from '@/lib/game/turn'
import { convertToTriggerRule } from '@/lib/game/rule-loader'
import { makeState } from '../helpers/minimal-state'

const SKILL_ID = 'loader-cache-probe'

let root: string
let previousProfileRoot: string | undefined
let probePath: string

function baseDefinition(): Record<string, unknown> {
  return {
    id: SKILL_ID,
    name: 'Loader cache probe',
    description: 'Original description',
    kind: 'active',
    type: 'normal',
    actionPointCost: 1,
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
  }
}

function moduleDefinition(): SkillDefinition {
  const graph = {
    ...createGameplayModuleGraph('skill'),
    inputs: [{ name: 'label', type: 'string' as const }],
    inputBindings: { label: 'Original description' },
  }
  const generated = applyGameplayModuleGraph(baseDefinition(), graph)
  return applyGameplayModuleTextBindings(generated, {
    description: {
      template: '{{label}}',
      values: { label: { entry: 'code', input: 'label' } },
    },
    targetText: {
      template: 'Target: {{label}}',
      values: { label: { entry: 'code', input: 'label' } },
    },
  }) as unknown as SkillDefinition
}

function writeProbe(definition: SkillDefinition | Record<string, unknown>): void {
  fs.writeFileSync(probePath, JSON.stringify(definition, null, 2), 'utf8')
}

function probeReadCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => path.resolve(String(call[0])) === probePath).length
}

function executionContext() {
  return createRuleExecutionContext(new TriggerSystem())
}

beforeEach(() => {
  previousProfileRoot = process.env.RVB_PROFILE_ROOT
  root = fs.mkdtempSync(path.join(tmpdir(), 'rvb-skill-loader-cache-'))
  const dataRoot = path.join(root, 'data')
  fs.mkdirSync(path.join(dataRoot, 'skills'), { recursive: true })
  probePath = path.join(dataRoot, 'skills', `${SKILL_ID}.json`)
  process.env.RVB_PROFILE_ROOT = root
  clearSkillDefinitionCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearSkillDefinitionCache()
  if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
  else process.env.RVB_PROFILE_ROOT = previousProfileRoot
  fs.rmSync(root, { recursive: true, force: true })
})

describe('skill loader source cache', () => {
  it('resolves the profile once for a catalog load instead of once per definition', () => {
    for (const id of [SKILL_ID, 'catalog-second', 'catalog-third']) {
      fs.writeFileSync(path.join(root, 'data', 'skills', `${id}.json`), JSON.stringify({
        ...baseDefinition(), id,
        code: 'function executeSkill() { return { success: true } }',
      }), 'utf8')
    }
    const exists = vi.spyOn(fs, 'existsSync')
    const loaded = withRuleExecutionContext(executionContext(), () => loadAllSkillsById())
    expect(Object.keys(loaded).sort()).toEqual([SKILL_ID, 'catalog-second', 'catalog-third'].sort())
    expect(exists.mock.calls.filter(([file]) => path.resolve(String(file)) === path.join(root, 'data'))).toHaveLength(1)
  })

  it('keeps unread triggered skills executable after hydrated state cloning', () => {
    writeProbe({
      ...baseDefinition(),
      code: 'function executeSkill() { return { success: true, message: "unread-trigger-ran" } }',
    })
    const hydrated = withServerSkills(makeState()) as BattleState
    // No property access to SKILL_ID before cloning: passive rules can be its
    // first consumer, so a lazily populated map must not lose it here.
    const cloned = safeCloneBattleState(hydrated)
    const rule = convertToTriggerRule({
      id: 'unread-trigger-rule', name: 'Unread trigger', description: '',
      trigger: { type: 'onTurnStart' },
      effect: { type: 'triggerSkill', skillId: SKILL_ID, message: 'fallback' },
    })
    expect(rule.effect(cloned, { type: 'onTurnStart', playerId: 'player-red' }))
      .toMatchObject({ success: true, message: 'unread-trigger-ran' })
    expect(cloned.skillsById[SKILL_ID]).not.toBe(hydrated.skillsById[SKILL_ID])
    cloned.skillsById[SKILL_ID].powerMultiplier = 99
    expect(hydrated.skillsById[SKILL_ID].powerMultiplier).toBe(1)
  })

  it('reuses validated source across contexts without sharing mutable definitions', () => {
    const definition = moduleDefinition()
    writeProbe(definition)
    const readSpy = vi.spyOn(fs, 'readFileSync')

    const firstContext = executionContext()
    const first = withRuleExecutionContext(firstContext, () => loadSkillById(SKILL_ID, true))
    expect(first).toBeDefined()
    const readsAfterFirst = probeReadCount(readSpy)
    expect(readsAfterFirst).toBe(1)

    const second = withRuleExecutionContext(executionContext(), () => loadSkillById(SKILL_ID, true))
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(probeReadCount(readSpy)).toBe(readsAfterFirst)

    first!.powerMultiplier = 99
    const firstDocument = first as SkillDefinition & { gameplayModules: {
      entries: Record<string, { graph: { body: unknown[] } }>
    } }
    const firstGraph = firstDocument.gameplayModules.entries.code.graph
    firstGraph.body.push({ kind: 'return', id: 'tampered' })
    expect(() => withRuleExecutionContext(firstContext, () => loadSkillById(SKILL_ID, true)))
      .toThrow()

    const secondContext = executionContext()
    const secondFresh = withRuleExecutionContext(secondContext, () => loadSkillById(SKILL_ID, true))
    expect(secondFresh).toBeDefined()
    secondFresh!.code = 'function executeSkill() { return { corrupted: true } }'
    expect(() => withRuleExecutionContext(secondContext, () => loadSkillById(SKILL_ID, true)))
      .toThrow('does not match')

    const third = withRuleExecutionContext(executionContext(), () => loadSkillById(SKILL_ID, true))
    expect(third?.powerMultiplier).toBe(definition.powerMultiplier)
    expect(third?.code).toBe(definition.code)
    expect(probeReadCount(readSpy)).toBe(readsAfterFirst)
  })

  it('rereads changed files and honors explicit cache clearing', () => {
    const definition = moduleDefinition()
    writeProbe(definition)
    const readSpy = vi.spyOn(fs, 'readFileSync')

    const first = withRuleExecutionContext(executionContext(), () => loadSkillById(SKILL_ID, true))
    expect(first?.powerMultiplier).toBe(1)
    expect(probeReadCount(readSpy)).toBe(1)

    const changed = { ...definition, powerMultiplier: 12345 }
    writeProbe(changed)
    const reloaded = withRuleExecutionContext(executionContext(), () => loadSkillById(SKILL_ID, true))
    expect(reloaded?.powerMultiplier).toBe(12345)
    expect(probeReadCount(readSpy)).toBe(2)

    const afterClear = withRuleExecutionContext(executionContext(), () => {
      clearSkillDefinitionCache()
      return loadSkillById(SKILL_ID, true)
    })
    expect(afterClear?.powerMultiplier).toBe(12345)
    expect(probeReadCount(readSpy)).toBe(3)
  })

  it('rechecks warm generated text ownership when authored wording changes', () => {
    const definition = moduleDefinition()
    writeProbe(definition)
    const loaded = loadSkillById(SKILL_ID, true)
    expect(loaded).toBeDefined()

    expect(() => {
      const tampered = { ...loaded, description: 'Tampered description' }
      return assertSkillDefinition(SKILL_ID, tampered)
    }).toThrow('does not match its text binding')
    expect(() => {
      const tampered = { ...loaded, targetText: 'Tampered target' }
      return assertSkillDefinition(SKILL_ID, tampered)
    }).toThrow('does not match its text binding')
  })

  it('takes strict validation for inherited owner fields and accessors', () => {
    const definition = moduleDefinition()
    writeProbe(definition)
    const loaded = loadSkillById(SKILL_ID, true)
    expect(loaded).toBeDefined()

    const inherited = Object.assign(Object.create({ skillGraph: {} }), loaded)
    expect(() => assertSkillDefinition(SKILL_ID, inherited)).toThrow('legacy skillGraph')

    const accessor = { ...loaded }
    Object.defineProperty(accessor, 'gameplayModules', {
      enumerable: true,
      get: () => { throw new Error('gameplayModules getter invoked') },
    })
    expect(() => assertSkillDefinition(SKILL_ID, accessor)).toThrow('gameplayModules getter invoked')
  })

  it('bypasses the shared source cache when force reload is enabled', async () => {
    const definition = moduleDefinition()
    writeProbe(definition)
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const previousForceReload = process.env.RVB_FORCE_RULE_RELOAD
    process.env.RVB_FORCE_RULE_RELOAD = '1'
    vi.resetModules()
    try {
      const forcedSkills = await import('@/lib/game/skills')
      const readsBeforeForcedLoads = probeReadCount(readSpy)
      expect(forcedSkills.loadSkillById(SKILL_ID, true)).toBeDefined()
      expect(forcedSkills.loadSkillById(SKILL_ID, true)).toBeDefined()
      expect(probeReadCount(readSpy) - readsBeforeForcedLoads).toBe(2)
    } finally {
      if (previousForceReload === undefined) delete process.env.RVB_FORCE_RULE_RELOAD
      else process.env.RVB_FORCE_RULE_RELOAD = previousForceReload
      vi.resetModules()
    }
  })
})
