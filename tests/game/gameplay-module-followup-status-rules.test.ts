/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyGameplayModuleGraph, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildFollowupStatusRulesGraph, FOLLOWUP_STATUS_RULE_IDS } from '@/scripts/migrate-semantic-followup-status-rules'
import { makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>

type Execution = { state: any; contexts: any[] }

function testPiece(options: Record<string, any> = {}): any {
  const { name = options.instanceId || '测试棋子', defense = 4, ...pieceOptions } = options
  const piece: any = makePiece(pieceOptions)
  piece.name = name
  piece.defense = defense
  return piece
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshot(state: any): any {
  const plain = clone(state)
  return plain
}

function installFixtureContent(root: string): void {
  for (const [key, document] of Object.entries(fixture)) {
    if (!key.startsWith('rules/') && !key.startsWith('skills/')) continue
    const file = join(root, 'data', `${key}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(document))
  }
}

function execute(id: string, semantic: boolean, build: () => Execution): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-followup-status-rules-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  try {
    process.env.RVB_PROFILE_ROOT = root
    installFixtureContent(root)
    const source = fixture[`rules/${id}`]
    const document = semantic ? applyGameplayModuleGraph(source, buildFollowupStatusRulesGraph(id), 'skillCode') : source
    const file = join(root, 'data', 'rules', `${id}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(document))
    clearRuleCache()
    const rule = loadRuleById(id, true, true)
    if (!rule) throw new Error(`rule ${id} did not load`)
    const execution = build()
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const results = withRuleRuntime(runtime, () => execution.contexts.map(context => rule.effect(execution.state, context)))
    return { results: clone(results), state: snapshot(execution.state), runtime: runtime.snapshot() }
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function expectEquivalent(id: string, build: () => Execution): any {
  const semantic = execute(id, true, build)
  const legacy = execute(id, false, build)
  expect(semantic, id).toEqual(legacy)
  return semantic
}

describe('follow-up status rule semantic graphs', () => {
  it('registers all three graphs through the central registry', () => {
    for (const id of FOLLOWUP_STATUS_RULE_IDS) {
      const graph = buildFollowupStatusRulesGraph(id)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY), id).not.toThrow()
      expect(graph).not.toHaveProperty('code')
      const document = applyGameplayModuleGraph(fixture[`rules/${id}`], graph, 'skillCode')
      expect(document.contentGraph).toBeUndefined()
      expect((document.gameplayModules as any)?.entries?.skillCode?.graph).toEqual(graph)
    }
  })

  it('preserves Ulquiorra resurrection success and guards', () => {
    const result = expectEquivalent('rule-ulquiorra-resurreccion', () => {
      const piece = testPiece({
        instanceId: 'ulquiorra', templateId: 'ulquiorra', ownerPlayerId: 'player-red', name: '乌尔奇奥拉',
        currentHp: 20, maxHp: 40, attack: 6, moveRange: 3,
        statusTags: [{ id: 'progress', type: 'ulquiorra-resurreccion-progress', intensity: 3, stacks: 3, currentDuration: -1, currentUses: -1 }],
      })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'beginTurn', rulePiece: piece, playerId: 'player-red' }] }
    })
    expect(result.results[0]).toMatchObject({ success: true, message: '乌尔奇奥拉归刃为黑翼大魔' })
    expect(result.state.pieces[0]).toMatchObject({ attack: 7, moveRange: 4 })
    expect(result.state.pieces[0].skills.map((skill: any) => skill.skillId)).toContain('ulquiorra-black-cero')

    for (const build of [
      () => {
        const piece = testPiece({ instanceId: 'dead', ownerPlayerId: 'player-red', currentHp: 0, statusTags: [{ id: 'progress', type: 'ulquiorra-resurreccion-progress', intensity: 3 }] })
        return { state: makeState({ pieces: [piece] }), contexts: [{ type: 'beginTurn', rulePiece: piece, playerId: 'player-red' }] }
      },
      () => {
        const piece = testPiece({ instanceId: 'not-ready', ownerPlayerId: 'player-red', statusTags: [{ id: 'progress', type: 'ulquiorra-resurreccion-progress', intensity: 2 }] })
        return { state: makeState({ pieces: [piece] }), contexts: [{ type: 'beginTurn', rulePiece: piece, playerId: 'player-red' }] }
      },
      () => {
        return { state: makeState({ pieces: [] }), contexts: [{ type: 'beginTurn', rulePiece: undefined, playerId: 'player-red' }] }
      },
    ]) expectEquivalent('rule-ulquiorra-resurreccion', build)
  })

  it('preserves Kenshin first status creation and existing counter reset', () => {
    const first = expectEquivalent('rule-kenshin-tenken', () => {
      const piece = testPiece({ instanceId: 'kenshin', templateId: 'kenshin', ownerPlayerId: 'player-red' })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterMove', rulePiece: piece, sourcePiece: piece }] }
    })
    expect(first.results[0]).toMatchObject({ success: true })
    expect(first.state.pieces[0].statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tenken-charge-kenshin', remainingUses: 1, currentUses: 1 })]))

    const updated = expectEquivalent('rule-kenshin-tenken', () => {
      const piece = testPiece({
        instanceId: 'kenshin', templateId: 'kenshin', ownerPlayerId: 'player-red',
        statusTags: [{ id: 'tenken-charge-kenshin', type: 'damage-multiplier', currentDuration: -1, currentUses: 1, remainingUses: 0, intensity: 1.5, stacks: 1 }],
      })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterMove', rulePiece: piece, sourcePiece: piece }] }
    })
    expect(updated.state.pieces[0].statusTags[0].remainingUses).toBe(1)

    expectEquivalent('rule-kenshin-tenken', () => {
      const piece = testPiece({ instanceId: 'kenshin-dead', ownerPlayerId: 'player-red', currentHp: 0 })
      const other = testPiece({ instanceId: 'other', ownerPlayerId: 'player-red' })
      const state: any = makeState({ pieces: [piece, other] })
      return { state, contexts: [{ type: 'afterMove', rulePiece: piece, sourcePiece: other }] }
    })
  })

  it('preserves Illidan use fallback, decrement, and exhaustion cleanup', () => {
    const remaining = expectEquivalent('rule-illidan-demon-strike', () => {
      const piece = testPiece({
        instanceId: 'illidan', templateId: 'illidan', ownerPlayerId: 'player-red', name: '伊利丹',
        skills: [{ skillId: 'illidan-demon-strike', currentCooldown: 0 }],
        rules: [{ id: 'rule-illidan-demon-strike' }],
        statusTags: [{ id: 'demon-strike-charges', type: 'demon-strike-charges', currentUses: 2, intensity: 2, stacks: 1 }],
      })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: piece, skillId: 'illidan-demon-strike' }] }
    })
    expect(remaining.results[0]).toMatchObject({ success: true, message: '伊利丹恶魔冲击剩余1次' })
    expect(remaining.state.pieces[0].statusTags[0].remainingUses).toBe(1)

    const exhausted = expectEquivalent('rule-illidan-demon-strike', () => {
      const piece = testPiece({
        instanceId: 'illidan', templateId: 'illidan', ownerPlayerId: 'player-red', name: '伊利丹',
        skills: [{ skillId: 'illidan-demon-strike', currentCooldown: 0 }],
        rules: [{ id: 'rule-illidan-demon-strike' }],
        statusTags: [{ id: 'demon-strike-charges', type: 'demon-strike-charges', remainingUses: 1, currentUses: 2, intensity: 2, stacks: 1 }],
      })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: piece, skillId: 'illidan-demon-strike' }] }
    })
    expect(exhausted.results[0]).toMatchObject({ success: true, message: '伊利丹的恶魔冲击次数耗尽，技能已移除' })
    expect(exhausted.state.pieces[0].statusTags).toEqual([])
    expect(exhausted.state.pieces[0].skills).toEqual([])
    expect(exhausted.state.pieces[0].rules).toEqual([])

    const fallbackZero = expectEquivalent('rule-illidan-demon-strike', () => {
      const piece = testPiece({ instanceId: 'illidan-zero', ownerPlayerId: 'player-red', name: '伊利丹', statusTags: [{ id: 'demon-strike-charges', type: 'demon-strike-charges', currentUses: 0, intensity: 2, stacks: 1 }] })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: piece, skillId: 'illidan-demon-strike' }] }
    })
    expect(fallbackZero.results[0]).toMatchObject({ success: true, message: '伊利丹恶魔冲击剩余1次' })

    expectEquivalent('rule-illidan-demon-strike', () => {
      const piece = testPiece({ instanceId: 'illidan-missing-tag', ownerPlayerId: 'player-red' })
      const state: any = makeState({ pieces: [piece] })
      return { state, contexts: [{ type: 'afterSkillUsed', rulePiece: piece, skillId: 'illidan-demon-strike' }] }
    })
    expectEquivalent('rule-illidan-demon-strike', () => ({
      state: makeState({ pieces: [] }),
      contexts: [{ type: 'afterSkillUsed', rulePiece: undefined, skillId: 'illidan-demon-strike' }],
    }))
  }, 15000)
})
