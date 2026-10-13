/* eslint-disable @typescript-eslint/no-explicit-any -- real-host semantic graph fixtures. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction, type SkillDefinition } from '@/lib/game/skills'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { assertGameplayModuleDocument } from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { buildIchigoGraph, ICHIGO_IDS, migrateIchigo } from '@/scripts/migrate-semantic-ichigo'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT = process.cwd()
const readJson = (file: string): any => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))

function calls(value: unknown): any[] {
  if (Array.isArray(value)) return value.flatMap(calls)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [
    ...(record.kind === 'call' ? [record] : []),
    ...Object.values(record).flatMap(calls),
  ]
}

function runSkill(skill: SkillDefinition, state: any, piece: any, targetPosition: { x: number; y: number } | null = null): any {
  return withRuleRuntime(new RuleRuntime({ rootSeed: 594, tick: 1 }), () => executeSkillFunction(skill, {
    piece,
    target: null,
    targetPosition,
    targets: [],
    playerId: piece.ownerPlayerId,
    battle: state,
    skill,
  } as any, state))
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

describe('Ichigo gameplay module migration', () => {
  it('compiles all three generic author graphs and keeps the continuation explicit', () => {
    for (const id of ICHIGO_IDS) {
      const graph = buildIchigoGraph(id)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
      expect(calls(graph).some(call => String(call.module).startsWith('ichigo.'))).toBe(false)
    }

    const ruleGraph = buildIchigoGraph('rule-ichigo-black-getsuga-teleport')
    expect(ruleGraph.continuations?.map(item => item.id)).toEqual(['ichigo-black-getsuga-teleport-complete'])
    expect(ruleGraph.body.some(statement => statement.kind === 'defer-choice')).toBe(true)
  })

  it('preserves the preview entry and is a no-op after generated entries are authored', () => {
    const black = readJson('data/skills/ichigo-black-getsuga-tensho.json')
    const bankai = readJson('data/skills/ichigo-bankai-tensa-zangetsu.json')
    const rule = readJson('data/rules/rule-ichigo-black-getsuga-teleport.json')
    expect(Object.keys(black.gameplayModules.entries)).toEqual(['previewCode', 'code'])
    expect(bankai.gameplayModules.entries.code).toBeDefined()
    expect(rule.gameplayModules.entries.skillCode).toBeDefined()
    assertGameplayModuleDocument(black)
    assertGameplayModuleDocument(bankai)
    assertGameplayModuleDocument(rule)
    expect(migrateIchigo(ROOT, false)).toEqual([])
  })

  it('still applies Bankai mutations when its owner player is no longer present', () => {
    const piece = makePiece({
      instanceId: 'ichigo',
      ownerPlayerId: 'missing-player',
      attack: 5,
      moveRange: 4,
      skills: [
        { skillId: 'ichigo-bankai-tensa-zangetsu', currentCooldown: 0, usesRemaining: -1 },
        { skillId: 'ichigo-getsuga-tensho', currentCooldown: 0, usesRemaining: -1 },
      ],
    }) as any
    piece.name = '黑崎一护'
    const state = makeState({ pieces: [piece], width: 6, height: 3 }) as any
    state.players = []
    const skill = readJson('data/skills/ichigo-bankai-tensa-zangetsu.json') as SkillDefinition
    state.skillsById[skill.id] = skill

    const result = runSkill(skill, state, piece)

    expect(result).toMatchObject({ success: true })
    expect(piece).toMatchObject({ attack: 6, moveRange: 6 })
    expect(piece.skills.map((entry: any) => entry.skillId)).toContain('ichigo-black-getsuga-tensho')
    expect(piece.skills.map((entry: any) => entry.skillId)).not.toContain('ichigo-getsuga-tensho')
    expect(piece.statusTags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ichigo-bankai-ichigo', type: 'ichigo-bankai' }),
    ]))
  })

  it('damages ordered enemies and stores only legal adjacent landing cells', () => {
    const caster = makePiece({ instanceId: 'ichigo', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 5 }) as any
    caster.name = '黑崎一护'
    const enemyA = makePiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 30 }) as any
    const enemyB = makePiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', x: 4, y: 1, currentHp: 30 }) as any
    const state = makeState({ pieces: [caster, enemyA, enemyB], width: 8, height: 4 }) as any
    const skill = readJson('data/skills/ichigo-black-getsuga-tensho.json') as SkillDefinition
    state.skillsById[skill.id] = skill

    const result = runSkill(skill, state, caster, { x: 6, y: 1 })

    expect(result).toMatchObject({ success: true })
    expect(enemyA.currentHp).toBe(20)
    expect(enemyB.currentHp).toBe(20)
    expect(state.extensions.ichigoBlackGetsugaTeleportByCaster.ichigo).toEqual([
      { type: 'cell', x: 2, y: 1 },
      { type: 'cell', x: 3, y: 2 },
      { type: 'cell', x: 3, y: 0 },
    ])
  })
})
