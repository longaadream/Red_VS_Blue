/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures exercise JSON-authored definitions through the real hosts. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyGameplayModuleGraph,
  createGameplayModuleGraph,
} from '@/lib/skill-graph/module-document'
import { applyBattleAction } from '@/lib/game/turn'
import {
  clearRuleCache,
  executeCardFunction,
  executeSkillFunction,
  loadRuleById,
  type CardDefinition,
  type SkillDefinition,
} from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>

function moduleOwned<T extends JsonRecord>(base: T, surface: 'skill' | 'card' | 'rule'): T {
  return applyGameplayModuleGraph(base, createGameplayModuleGraph(surface)) as T
}

function explicitResultGraph(surface: 'skill' | 'card' | 'rule', success: boolean): any {
  const starter = createGameplayModuleGraph(surface)
  return {
    ...starter,
    outputs: [{ name: 'result', type: 'record' }],
    body: [
      {
        kind: 'call',
        id: 'result',
        module: 'result.action',
        version: '1',
        inputs: { success: { kind: 'literal', value: success } },
        parameters: {},
      },
      {
        kind: 'return',
        id: 'return-result',
        value: { kind: 'output', node: 'result', port: 'result' },
      },
    ],
  }
}

function skillContext(skill: SkillDefinition, battle: any, piece: any): any {
  return {
    piece,
    target: null,
    targetPosition: null,
    targets: [],
    battle,
    playerId: piece.ownerPlayerId,
    skill: {
      id: skill.id,
      name: skill.name,
      type: skill.type,
      powerMultiplier: skill.powerMultiplier,
    },
  }
}

function runRuleInTemporaryProfile(definition: JsonRecord): unknown {
  const root = mkdtempSync(join(tmpdir(), 'rvb-atomic-natural-success-'))
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  const previousRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  try {
    writeFileSync(join(root, 'data', 'rules', `${definition.id}.json`), JSON.stringify(definition), 'utf8')
    const rule = loadRuleById(definition.id, true, true)
    if (!rule) throw new Error(`Expected rule ${definition.id} to load`)
    const source = makePiece({ instanceId: 'atomic-rule-source' }) as any
    const battle = makeState({ pieces: [source] }) as any
    return rule.effect(battle, {
      type: definition.trigger.type,
      rulePiece: source,
      sourcePiece: source,
      piece: source,
      playerId: 'player-red',
      battle,
    })
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function baseSkill(id: string): JsonRecord {
  return {
    id,
    name: id,
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    range: 'self',
    requiresTarget: false,
    actionPointCost: 0,
  }
}

function baseCard(id: string): JsonRecord {
  return {
    id,
    name: id,
    description: '',
    type: 'active',
    actionPointCost: 0,
  }
}

function baseRule(id: string): JsonRecord {
  return {
    id,
    name: id,
    description: '',
    trigger: { type: 'beginTurn' },
  }
}

describe('gameplay module natural success normalization', () => {
  beforeEach(() => globalTriggerSystem.clearRules())

  afterEach(() => {
    vi.restoreAllMocks()
    globalTriggerSystem.clearRules()
    clearRuleCache()
    delete process.env.RVB_PROFILE_ROOT
  })

  it('treats natural undefined as success only for module-owned cards', () => {
    const card = moduleOwned(baseCard('atomic-module-card'), 'card') as CardDefinition
    const battle = makeState() as any

    expect(executeCardFunction(card, 'player-red', battle)).toEqual({ success: true })

    const explicitFailure = applyGameplayModuleGraph(
      baseCard('atomic-module-card-failure'),
      explicitResultGraph('card', false),
    ) as unknown as CardDefinition
    expect(executeCardFunction(explicitFailure, 'player-red', makeState() as any)).toEqual({ success: false })

    const legacy = {
      ...baseCard('atomic-legacy-card'),
      code: 'function executeCard(context) {}',
    } as CardDefinition
    expect(executeCardFunction(legacy, 'player-red', makeState() as any)).toEqual({
      success: false,
      message: '卡牌效果无返回值',
    })
  })

  it('treats natural undefined as success for skills and fires afterSkillUsed', () => {
    const skill = moduleOwned(baseSkill('atomic-module-skill'), 'skill') as SkillDefinition
    const piece = makePiece({ instanceId: 'atomic-skill-source' }) as any
    const battle = makeState({ pieces: [piece] }) as any
    const checkTriggers = vi.spyOn(globalTriggerSystem, 'checkTriggers')

    expect(executeSkillFunction(skill, skillContext(skill, battle, piece), battle)).toEqual({ success: true })
    expect(checkTriggers.mock.calls.some(([, context]) => context?.type === 'afterSkillUsed')).toBe(true)

    const legacy = {
      ...baseSkill('atomic-legacy-skill'),
      code: 'function executeSkill(context) {}',
    } as SkillDefinition
    const legacyPiece = makePiece({ instanceId: 'atomic-legacy-source' }) as any
    const legacyBattle = makeState({ pieces: [legacyPiece] }) as any
    checkTriggers.mockClear()
    expect(executeSkillFunction(legacy, skillContext(legacy, legacyBattle, legacyPiece), legacyBattle)).toBeUndefined()
    expect(checkTriggers.mock.calls.some(([, context]) => context?.type === 'afterSkillUsed')).toBe(false)
  })

  it('commits the formal skill cost when an owned graph returns naturally', () => {
    const skill = moduleOwned({ ...baseSkill('atomic-paid-skill'), actionPointCost: 1 }, 'skill') as SkillDefinition
    const piece = makePiece({
      instanceId: 'atomic-paid-source',
      skills: [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }],
    }) as any
    const battle = makeState({ pieces: [piece] }) as any
    battle.skillsById[skill.id] = skill
    battle.players[0].actionPoints = 2

    const next = applyBattleAction(battle, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: piece.instanceId,
      skillId: skill.id,
    } as any)

    expect(next.players[0].actionPoints).toBe(1)
    expect(next.actions?.at(-1)).toMatchObject({ type: 'useBasicSkill' })
  })

  it('treats natural undefined as success only for module-owned rule skillCode', () => {
    const moduleRule = moduleOwned(baseRule('atomic-module-rule'), 'rule')
    expect(runRuleInTemporaryProfile(moduleRule)).toEqual({ success: true })

    const legacyRule = {
      ...baseRule('atomic-legacy-rule'),
      skillCode: 'void 0',
    }
    expect(runRuleInTemporaryProfile(legacyRule)).toEqual({ success: false, message: '' })
  })
})
