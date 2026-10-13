/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyGameplayModuleGraph, assertGameplayModuleDocument } from '@/lib/skill-graph/module-document'
import { clearRuleCache, getRuleDynamicCodeRuntime, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeRuleContinuation } from '@/lib/game/pending-continuation'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { buildFollowupRuleGraph, FOLLOWUP_RULE_IDS } from '@/scripts/migrate-semantic-followup-rules'
import { buildShishioVelenColtGraph } from '@/scripts/migrate-semantic-shishio-velen-colt'
import { buildKyokaRewriteGraph } from '@/scripts/migrate-semantic-kyoka'
import { buildMinatoAnchorEndTurnGraph } from '@/scripts/migrate-semantic-pending-skills'
import { makePiece as makeRawPiece, makeState } from '../helpers/minimal-state'

type RuleId = typeof FOLLOWUP_RULE_IDS[number] | 'rule-minato-anchor-end-turn' | 'rule-aizen-kyoka-rewrite' | 'rule-colt-big-stride'
const entries = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function makePiece(overrides: Record<string, any> = {}): any {
  const piece = makeRawPiece(overrides) as any
  if (typeof overrides.name === 'string') piece.name = overrides.name
  if (overrides.defense !== undefined) piece.defense = overrides.defense
  return piece
}

function comparableState(battle: any): any {
  const state = clone(battle)
  delete state.skillsById
  return state
}

function writeRule(root: string, id: string, semantic: boolean): void {
  const original = entries['rules/' + id]
  const document = semantic ? applyGameplayModuleGraph(original, id === 'rule-colt-big-stride' ? buildShishioVelenColtGraph(id) : id === 'rule-minato-anchor-end-turn' ? buildMinatoAnchorEndTurnGraph() : id === 'rule-aizen-kyoka-rewrite' ? buildKyokaRewriteGraph() : buildFollowupRuleGraph(id as typeof FOLLOWUP_RULE_IDS[number]), 'skillCode') : original
  writeFileSync(join(root, 'data/rules', id + '.json'), JSON.stringify(document), 'utf8')
}

function runRule(id: RuleId, semantic: boolean, setup: () => { battle: any; context: any }, resume?: (prompt: any, battle: any, context: any, runtime: RuleRuntime, rule: any) => any): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-followup-rules-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  mkdirSync(join(root, 'data/rules'), { recursive: true })
  try {
    process.env.RVB_PROFILE_ROOT = root
    writeRule(root, id, semantic)
    clearRuleCache()
    getRuleDynamicCodeRuntime().clear()
    const rule = loadRuleById(id, true, true)!
    const { battle, context } = setup()
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const rawResult = withRuleRuntime(runtime, () => rule.effect(battle, context))
    const finalResult = resume ? resume(rawResult, battle, context, runtime, rule) : rawResult
    return { result: clone(finalResult), rawResult: clone(finalResult), state: comparableState(battle), runtime: runtime.snapshot() }
  } finally {
    clearRuleCache()
    getRuleDynamicCodeRuntime().clear()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function expectEquivalent(id: RuleId, setup: () => { battle: any; context: any }): any {
  const semantic = runRule(id, true, setup)
  const legacy = runRule(id, false, setup)
  expect(semantic).toEqual(legacy)
  return semantic
}

function runPendingContinuation(id: RuleId, semantic: boolean, killSource: boolean): any {
  let presentation: any[] = []
  const result = runRule(id, semantic, () => {
    const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', name: '葛力姆乔', x: 1, y: 1, attack: 10 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
    return {
      battle: makeState({ pieces: [grimm, enemy] }),
      context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, {
        playerId: 'player-red', selectedTargets: [], reservedCells: [],
      }),
    }
  }, (prompt, battle, context, runtime, rule) => {
    const pending = prompt.pendingTargetSelection
    const grimm = battle.pieces.find((piece: any) => piece.instanceId === 'grimm')
    const enemy = battle.pieces.find((piece: any) => piece.instanceId === 'enemy')
    if (!grimm || !enemy) throw new Error(`${id} fixture is missing its source pieces`)
    if (killSource) {
      const index = battle.pieces.findIndex((piece: any) => piece.instanceId === enemy.instanceId)
      const [removed] = index >= 0 ? battle.pieces.splice(index, 1) : []
      if (removed) { removed.currentHp = 0; battle.graveyard.push(removed) }
    }
    const answer = { selectedTargets: [{ type: 'cell', x: 2, y: 1 }] }
    const rawResult = recordBattlePresentation(battle, () => withRuleRuntime(runtime, () => {
      if (pending?.effectCode) return executeRuleContinuation(battle, pending, answer, context, grimm.instanceId, id)
      context.selectedTargets = answer.selectedTargets
      return rule.effect(battle, context)
    }), () => battle)
    presentation = clone([...(recordedBattlePresentation(battle) || [])])
    return rawResult
  })
  return { ...result, presentation }
}

function contextFor(type: string, rulePiece: any, sourcePiece?: any, extra: Record<string, any> = {}): any {
  return { type, rulePiece, sourcePiece, playerId: rulePiece?.ownerPlayerId, ...extra }
}

describe('semantic follow-up rule migrations', () => {
  for (const id of ['rule-colt-big-stride', 'rule-grimmjow-hunt-after-move', 'rule-grimmjow-hunt-after-skill'] as const) {
    it.each([
      [{ type: 'piece', pieceId: 'enemy' }],
      [{ type: 'piece', pieceId: 'enemy' }, { type: 'cell', x: 2, y: 1 }],
    ])(`rejects ${id} invalid first selection without finding a later valid cell %j`, (...selectedTargets) => {
      const actual = expectEquivalent(id, () => {
        const holder = makePiece({ instanceId: 'holder', ownerPlayerId: 'player-red', x: 1, y: 1 })
        const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
        return { battle: makeState({ pieces: [holder, enemy] }), context: contextFor(id.endsWith('skill') ? 'afterSkillUsed' : 'afterMove', holder, enemy, { playerId: 'player-blue', selectedTargets, reservedCells: [] }) }
      })
      expect(actual.result.success).toBe(false)
      expect(actual.state.pieces[0]).toMatchObject({ x: 1, y: 1 })
    })
  }

  it.each([
    {}, { cancelled: true }, { isSinglePieceTargetAction: false }, { sourceHp: 0 },
    { selectedTargets: [{ type: 'piece', pieceId: 'replacement' }] },
    { selectedTargets: [{ type: 'piece', pieceId: 'missing' }] },
    { selectedTargets: [{ type: 'cell', x: 1, y: 1 }, { type: 'piece', pieceId: 'replacement' }] },
    { selectedTargets: [{ type: 'piece', pieceId: 'replacement' }, { type: 'piece', pieceId: 'enemy' }] },
  ])('preserves Kyoka rewrite raw pending protocol and first selected entry %j', (answer) => {
    const actual = expectEquivalent('rule-aizen-kyoka-rewrite', () => {
      const aizen = makePiece({ instanceId: 'aizen', ownerPlayerId: 'player-red', name: '蓝染', x: 1, y: 1,
        statusTags: [{ id: 'secret', type: 'aizen-kyoka-secret', targetPieceId: 'enemy', opponentPlayerId: 'player-blue' }, { id: 'active', type: 'aizen-kyoka-active' }] })
      const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2, y: 1, ...('sourceHp' in answer ? { currentHp: answer.sourceHp } : {}) })
      const replacement = makePiece({ instanceId: 'replacement', ownerPlayerId: 'player-blue', x: 3, y: 1 })
      return { battle: makeState({ pieces: [aizen, replacement, enemy] }), context: contextFor('beforeSkillUse', aizen, enemy, { targetPiece: enemy, isSinglePieceTargetAction: true, ...answer }) }
    })
    expect(actual.rawResult).not.toHaveProperty('effectCode')
    expect(actual.rawResult).not.toHaveProperty('range')
  })

  it.each([
    {}, { targetX: 3, targetY: 3 }, { targetX: 99, targetY: 99 },
    { targetX: null, targetY: null }, { targetX: 3 }, { cancelled: true },
  ])('preserves Minato anchor initial selection and direct coordinate replay %j', (answer) => {
    const actual = expectEquivalent('rule-minato-anchor-end-turn', () => {
      const minato = makePiece({ instanceId: 'minato', ownerPlayerId: 'player-red', name: '水门', x: 1, y: 1 })
      const battle = makeState({ pieces: [minato] })
      battle.map.tiles.reverse()
      return { battle, context: contextFor('endTurn', minato, undefined, { ...answer }) }
    })
    if (!('targetX' in answer) || !('targetY' in answer)) {
      expect(actual.rawResult.needsTargetSelection).toBe(true)
      expect(actual.rawResult).not.toHaveProperty('effectCode')
      expect(actual.rawResult).not.toHaveProperty('selectionMode')
    }
  })

  it('registers all six frozen rules as typed module documents', () => {
    for (const id of FOLLOWUP_RULE_IDS) {
      const source = entries['rules/' + id]
      const document = applyGameplayModuleGraph(source, buildFollowupRuleGraph(id), 'skillCode') as any
      assertGameplayModuleDocument(document)
      expect(document.contentGraph).toBeUndefined()
      expect(document.gameplayModules.entries.skillCode.graph.surface).toBe('rule')
      expect(document.gameplayModules.entries.skillCode.graph.body.length).toBeGreaterThan(0)
      expect(document.skillCode).toEqual(expect.any(String))
      if (id === 'rule-grimmjow-hunt-after-move' || id === 'rule-grimmjow-hunt-after-skill') {
        const graph = document.gameplayModules.entries.skillCode.graph
        expect(graph.composites ?? []).toEqual([])
        expect(JSON.stringify(graph)).not.toContain('followup.grimm-hunt-resolve')
      }
    }
  })

  it('preserves Black Coffin delayed damage, cleanup, messages, and damage runtime', () => {
    const setup = () => {
      const aizen = makePiece({ instanceId: 'aizen', templateId: 'aizen', ownerPlayerId: 'player-red', name: '蓝染', x: 0, y: 0 })
      const target = makePiece({
        instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', name: '目标', x: 2, y: 0, currentHp: 30, maxHp: 30,
        statusTags: [
          { id: 'coffin-1', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 7 },
          { id: 'coffin-current-turn', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 3, appliedTurn: 1 },
        ],
      })
      const battle: any = makeState({ pieces: [aizen, target], turnNumber: 1 })
      return { battle, context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    }
    const actual = expectEquivalent('rule-aizen-black-coffin-end', setup)
    expect(actual.result).toMatchObject({ success: true, message: '黑棺终结，对目标造成7点魔法伤害' })
    expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'target').currentHp).toBe(23)
  })

  it('keeps lethal delayed damage messages after the target leaves battle, including multiple coffins', () => {
    const lethal = expectEquivalent('rule-aizen-black-coffin-end', () => {
      const aizen = makePiece({ instanceId: 'aizen', templateId: 'aizen', ownerPlayerId: 'player-red', name: '蓝染' })
      const target = makePiece({
        instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', name: '目标', currentHp: 1, maxHp: 30,
        statusTags: [{ id: 'coffin-1', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 7 }],
      })
      return { battle: makeState({ pieces: [aizen, target], turnNumber: 2 }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    expect(lethal.result).toEqual({ success: true, message: '黑棺终结，对目标造成1点魔法伤害' })
    expect(lethal.state.pieces.some((piece: any) => piece.instanceId === 'target')).toBe(false)
    expect(lethal.state.graveyard.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(0)

    const multiple = expectEquivalent('rule-aizen-black-coffin-end', () => {
      const aizen = makePiece({ instanceId: 'aizen', templateId: 'aizen', ownerPlayerId: 'player-red', name: '蓝染' })
      const target = makePiece({
        instanceId: 'target', templateId: 'target', ownerPlayerId: 'player-blue', name: '目标', currentHp: 3, maxHp: 30,
        statusTags: [
          { id: 'coffin-1', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 7 },
          { id: 'coffin-2', type: 'aizen-black-coffin', sourceId: 'aizen', delayedDamage: 4 },
        ],
      })
      return { battle: makeState({ pieces: [aizen, target], turnNumber: 2 }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    expect(multiple.result).toEqual({ success: true, message: '黑棺终结，对目标造成3点魔法伤害' })
    expect(multiple.state.pieces.some((piece: any) => piece.instanceId === 'target')).toBe(false)
    expect(multiple.state.graveyard.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(0)
  })

  it('preserves Black Coffin cleanup, current-turn filtering, and missing-source failure', () => {
    const noCoffin = expectEquivalent('rule-aizen-black-coffin-end', () => {
      const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', rules: [{ id: 'rule-aizen-black-coffin-end' }] })
      return { battle: makeState({ pieces: [target] }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    expect(noCoffin.result).toEqual({ success: false, message: '' })
    expect(noCoffin.state.pieces[0].rules).toEqual([])

    const currentTurnOnly = expectEquivalent('rule-aizen-black-coffin-end', () => {
      const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', statusTags: [{ id: 'coffin', type: 'aizen-black-coffin', sourceId: 'missing', delayedDamage: 7, appliedTurn: 1 }] })
      return { battle: makeState({ pieces: [target], turnNumber: 1 }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    expect(currentTurnOnly.result).toEqual({ success: false, message: '' })

    const missingSource = () => runRule('rule-aizen-black-coffin-end', true, () => {
      const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', statusTags: [{ id: 'coffin', type: 'aizen-black-coffin', sourceId: 'missing', delayedDamage: 7, appliedTurn: 0 }] })
      return { battle: makeState({ pieces: [target] }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    const legacyMissingSource = () => runRule('rule-aizen-black-coffin-end', false, () => {
      const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', statusTags: [{ id: 'coffin', type: 'aizen-black-coffin', sourceId: 'missing', delayedDamage: 7, appliedTurn: 0 }] })
      return { battle: makeState({ pieces: [target] }), context: contextFor('endTurn', target, undefined, { playerId: 'player-blue' }) }
    })
    const diagnostics: any[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      if (args[0] === '[gameplay-module-diagnostic]') diagnostics.push(args[1])
    })
    const semanticFailure = missingSource()
    consoleError.mockRestore()
    const legacyFailure = legacyMissingSource()
    expect(semanticFailure.result).toEqual({ success: false, message: '' })
    expect(semanticFailure.state.pieces.find((piece: any) => piece.instanceId === 'target')).toMatchObject({ currentHp: 100, statusTags: [] })
    expect(semanticFailure.state.actions).toEqual([])
    expect(diagnostics).toEqual([
      expect.objectContaining({
        statementId: 'damage',
        moduleId: 'followup.damage-status',
        message: 'Black coffin damage source is unavailable',
        surface: 'rule',
        contentId: 'rule-aizen-black-coffin-end',
        actorPlayerId: 'player-blue',
        turn: 1,
        phase: 'action',
        rootSeed: 594,
      }),
    ])

    // v1 keeps the original abort result and leaves the invalid status in
    // place; only the v2 branch isolates the faulty statement.
    expect(legacyFailure.result).toEqual({ success: false, message: '规则执行失败' })
    expect(legacyFailure.state.pieces.find((piece: any) => piece.instanceId === 'target')?.statusTags).toEqual([
      { id: 'coffin', type: 'aizen-black-coffin', sourceId: 'missing', delayedDamage: 7, appliedTurn: 0 },
    ])
  })

  it('preserves Kyoka hidden status expiry and owner guard', () => {
    const setup = () => {
      const aizen = makePiece({
        instanceId: 'aizen', templateId: 'aizen', ownerPlayerId: 'player-red', name: '蓝染',
        statusTags: [
          { id: 'active', type: 'aizen-kyoka-active' },
          { id: 'secret', type: 'aizen-kyoka-secret', opponentPlayerId: 'player-blue' },
          { id: 'keep', type: 'unrelated', stacks: 2 },
        ],
      })
      const battle: any = makeState({ pieces: [aizen] })
      return { battle, context: contextFor('endTurn', aizen, undefined, { playerId: 'player-blue' }) }
    }
    const actual = expectEquivalent('rule-aizen-kyoka-expire', setup)
    expect(actual.result).toEqual({ success: true, message: '蓝染的镜花水月失效' })
    expect(actual.state.pieces[0].statusTags).toEqual([{ id: 'keep', type: 'unrelated', stacks: 2 }])

    const wrongPlayer = runRule('rule-aizen-kyoka-expire', true, () => {
      const aizen = makePiece({ instanceId: 'aizen', ownerPlayerId: 'player-red', statusTags: [{ id: 'secret', type: 'aizen-kyoka-secret', opponentPlayerId: 'player-blue' }] })
      return { battle: makeState({ pieces: [aizen] }), context: contextFor('endTurn', aizen, undefined, { playerId: 'player-red' }) }
    })
    expect(wrongPlayer.result).toEqual({ success: false, message: '' })
  })

  it('preserves Elune Guidance stack and full-stack healing branches', () => {
    const setup = () => {
      const tyrande = makePiece({ instanceId: 'tyrande', templateId: 'tyrande', ownerPlayerId: 'player-red', name: '泰兰德', x: 0, y: 0, currentHp: 20, maxHp: 30 })
      const ally = makePiece({ instanceId: 'ally', templateId: 'ally', ownerPlayerId: 'player-red', name: '友军', x: 1, y: 0, currentHp: 10, maxHp: 30 })
      const enemy = makePiece({ instanceId: 'enemy', templateId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 0, currentHp: 20, maxHp: 20 })
      const battle: any = makeState({ pieces: [tyrande, ally, enemy] })
      return { battle, context: contextFor('afterCardPlay', tyrande, undefined, { playerId: 'player-red', cardId: 'holy-guidance' }) }
    }
    const first = expectEquivalent('rule-elune-guidance', setup)
    expect(first.result).toEqual({ success: true, message: '艾露恩的指引：获得1层月华' })
    expect(first.state.pieces[0].statusTags).toEqual([expect.objectContaining({ id: 'moon-glow', stacks: 1 })])

    const setupAtOne = () => {
      const scenario = setup()
      scenario.battle.pieces[0].statusTags = [{ id: 'moon-glow', type: 'buff', stacks: 1, currentDuration: -1, currentUses: -1, intensity: 1, maxStacks: 2 }]
      return scenario
    }
    const second = expectEquivalent('rule-elune-guidance', setupAtOne)
    expect(second.result).toEqual({ success: true, message: '艾露恩的指引：月华满层，为友军恢复5点生命' })
    expect(second.state.pieces.find((piece: any) => piece.instanceId === 'ally').currentHp).toBe(15)
    expect(second.state.pieces.find((piece: any) => piece.instanceId === 'tyrande').statusTags).toEqual([])

    const notHoly = expectEquivalent('rule-elune-guidance', () => {
      const scenario = setup()
      scenario.context.cardId = 'fireball'
      return scenario
    })
    expect(notHoly.result).toEqual({ success: false })
  })

  it('preserves Mangekyo witness ordering, counter, action payload, and turn', () => {
    const setup = () => {
      const witness = makePiece({ instanceId: 'a-witness', templateId: 'mangekyo', ownerPlayerId: 'player-red', name: '见证者', statusTags: [{ id: 'witness', type: 'mangekyo-witness' }] })
      const laterWitness = makePiece({ instanceId: 'z-witness', templateId: 'mangekyo', ownerPlayerId: 'player-red', statusTags: [{ id: 'witness-z', type: 'mangekyo-witness' }] })
      const dead = makePiece({ instanceId: 'dead', templateId: 'fallen', ownerPlayerId: 'player-red', name: '牺牲者', currentHp: 0 })
      const battle: any = makeState({ pieces: [witness, laterWitness, dead], turnNumber: 4 })
      return { battle, context: contextFor('onPieceDied', witness, dead, { playerId: 'player-red' }) }
    }
    const actual = expectEquivalent('rule-mangekyo-friendly-death', setup)
    expect(actual.result).toEqual({ success: true, message: '牺牲者的死亡令【万花筒】充能消耗降低1' })
    expect(actual.state.extensions.contentCounters.mangekyoDeaths['player-red']).toBe(1)
    expect(actual.state.actions).toEqual([expect.objectContaining({ type: 'mangekyoDeath', turn: 4, payload: expect.objectContaining({ pieceId: 'dead', pieceTemplateId: 'fallen', mangekyoDeathCount: 1 }) })])

    const nonPrimary = expectEquivalent('rule-mangekyo-friendly-death', () => {
      const witness = makePiece({ instanceId: 'z-witness', ownerPlayerId: 'player-red', statusTags: [{ id: 'witness', type: 'mangekyo-witness' }] })
      const first = makePiece({ instanceId: 'a-witness', ownerPlayerId: 'player-red', statusTags: [{ id: 'witness-a', type: 'mangekyo-witness' }] })
      const dead = makePiece({ instanceId: 'dead', ownerPlayerId: 'player-red', currentHp: 0 })
      return { battle: makeState({ pieces: [witness, first, dead] }), context: contextFor('onPieceDied', witness, dead, { playerId: 'player-red' }) }
    })
    expect(nonPrimary.result).toEqual({ success: false, message: '' })
  })

  for (const id of ['rule-grimmjow-hunt-after-move', 'rule-grimmjow-hunt-after-skill'] as const) {
    it(`preserves ${id} selected teleport and two-hit follow-up`, () => {
      const setup = () => {
        const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', name: '葛力姆乔', x: 1, y: 1, attack: 10 })
        const enemy = makePiece({ instanceId: 'enemy', templateId: 'enemy', ownerPlayerId: 'player-blue', name: '敌人', x: 3, y: 1, currentHp: 40, maxHp: 40 })
        const battle: any = makeState({ pieces: [grimm, enemy] })
        return {
          battle,
          context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, {
            playerId: 'player-red', selectedTargets: [{ type: 'cell', x: 2, y: 1 }], reservedCells: [], cancelled: false,
          }),
        }
      }
      const actual = expectEquivalent(id, setup)
      expect(actual.result).toEqual({ success: true, message: '葛力姆乔发动狩猎本能并攻击2次' })
      expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'grimm')).toEqual(expect.objectContaining({ x: 2, y: 1 }))
      expect(actual.state.pieces.find((piece: any) => piece.instanceId === 'enemy').currentHp).toBe(26)
    })

    it(`preserves ${id} candidate selection and invalid/cancelled guards`, () => {
      const pending = expectEquivalent(id, () => {
        const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', x: 1, y: 1 })
        const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
        return { battle: makeState({ pieces: [grimm, enemy] }), context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, { playerId: 'player-red', selectedTargets: [], reservedCells: [] }) }
      })
      expect(pending.rawResult).toEqual(pending.result)
      expect(pending.result).toMatchObject({ success: false, needsTargetSelection: true, targetType: 'cell', playerId: 'player-red', targetCandidates: expect.any(Array) })
      expect(pending.result.targetCandidates.length).toBeGreaterThan(0)

      const invalid = expectEquivalent(id, () => {
        const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', x: 1, y: 1 })
        const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
        return { battle: makeState({ pieces: [grimm, enemy] }), context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, { playerId: 'player-red', selectedTargets: [{ type: 'cell', x: 99, y: 99 }], reservedCells: [] }) }
      })
      expect(invalid.result).toEqual({ success: false, message: '狩猎本能落点已失效' })

      const cancelled = expectEquivalent(id, () => {
        const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', x: 1, y: 1 })
        const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
        return { battle: makeState({ pieces: [grimm, enemy] }), context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, { playerId: 'player-red', selectedTargets: [], reservedCells: [], cancelled: true }) }
      })
      expect(cancelled.result).toEqual({ success: false, message: '' })

      const blocked = expectEquivalent(id, () => {
        const grimm = makePiece({ instanceId: 'grimm', templateId: 'grimmjow', ownerPlayerId: 'player-red', x: 1, y: 1, statusTags: [{ id: 'imprisoned', type: 'imprisoned' }] })
        const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 3, y: 1 })
        return { battle: makeState({ pieces: [grimm, enemy] }), context: contextFor(id.endsWith('move') ? 'afterMove' : 'afterSkillUsed', grimm, enemy, { playerId: 'player-red', selectedTargets: [{ type: 'cell', x: 2, y: 1 }], reservedCells: [] }) }
      })
      expect(blocked.result).toEqual({ success: true, message: '位移被阻挡，本次位移效果取消' })
    })

    it(`preserves ${id} pending source-death guard without a phantom movement`, () => {
      const semantic = runPendingContinuation(id, true, true)
      const legacy = runPendingContinuation(id, false, true)
      expect(semantic).toEqual(legacy)
      expect(semantic.result).toEqual({ success: false, message: '' })
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'grimm')).toEqual(expect.objectContaining({ x: 1, y: 1 }))
      expect(semantic.state.pieces.some((piece: any) => piece.instanceId === 'enemy')).toBe(false)
      expect(semantic.state.graveyard.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(0)
      expect(semantic.presentation).toEqual([])
    })

    it(`records ${id} pending resume movement presentation when the source remains alive`, () => {
      const semantic = runPendingContinuation(id, true, false)
      const legacy = runPendingContinuation(id, false, false)
      expect(semantic).toEqual(legacy)
      expect(semantic.result).toEqual({ success: true, message: '葛力姆乔发动狩猎本能并攻击2次' })
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'grimm')).toEqual(expect.objectContaining({ x: 2, y: 1 }))
      expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(86)
      expect(semantic.presentation).toContainEqual(expect.objectContaining({ kind: 'forceMove', targetPieceIds: ['grimm'] }))
    })
  }
})
