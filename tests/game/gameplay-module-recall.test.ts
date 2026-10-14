/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host differential fixtures. */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { executeSkillFunction } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { applyGameplayModuleGraph, assertGameplayModuleDocument } from '@/lib/skill-graph/module-document'
import { compileGameplayModuleGraph } from '@/lib/skill-graph/module-compiler'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { buildRecallGraph, migrateRecall, RECALL_SKILL_IDS } from '@/scripts/migrate-semantic-recall'
import { makePiece, makeState } from '../helpers/minimal-state'

const frozen = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

type Scenario = {
  pieces: any[]
  width?: number
  height?: number
  extensions?: Record<string, any>
  pieceId: string
  rulePieceId?: string
  sourcePieceId?: string
  sourcePiece?: any
  playerId?: string
  selectedOption?: unknown
}

function namedPiece(overrides: Record<string, any>): any {
  const piece = makePiece(overrides as any) as any
  piece.name = overrides.name ?? overrides.instanceId
  return piece
}

function sourceDefinition(id: string): any {
  return clone(frozen[`skills/${id}`])
}

function comparableState(battle: any): any {
  const state = clone(battle)
  // The loader cache is an execution detail. Keep rules, players and all other
  // state fields intact so the differential assertion covers the whole battle.
  delete state.skillsById
  return state
}

function run(id: typeof RECALL_SKILL_IDS[number], semantic: boolean, scenario: Scenario): any {
  const original = sourceDefinition(id)
  const skill = semantic ? applyGameplayModuleGraph(original, buildRecallGraph(id)) : original
  const state = makeState({
    pieces: clone(scenario.pieces),
    width: scenario.width ?? 8,
    height: scenario.height ?? 8,
  }) as any
  state.extensions = clone(scenario.extensions ?? {})
  state.skillsById[id] = skill
  const piece = state.pieces.find((candidate: any) => candidate.instanceId === scenario.pieceId)
  if (!piece) throw new Error(`missing holder ${scenario.pieceId}`)
  const rulePiece = state.pieces.find((candidate: any) => candidate.instanceId === (scenario.rulePieceId ?? scenario.pieceId))
  const sourcePiece = scenario.sourcePiece ?? state.pieces.find((candidate: any) => candidate.instanceId === scenario.sourcePieceId)
  const context: any = {
    piece,
    rulePiece,
    sourcePiece,
    playerId: scenario.playerId,
    selectedOption: scenario.selectedOption,
    skill,
    battle: state,
    target: null,
    targetPosition: null,
    targets: [],
  }
  const flowEntry = id === 'recall'
    ? undefined
    : { context, surface: 'triggerSkill' as const }
  const runtime = new RuleRuntime({ rootSeed: 594 })
  const result = recordBattlePresentation(
    state,
    () => withRuleRuntime(runtime, () => executeSkillFunction(skill, context, state, flowEntry)),
    () => state,
  )
  return {
    result: clone(result),
    state: comparableState(state),
    presentation: clone(recordedBattlePresentation(state) ?? []),
    runtime: runtime.snapshot(),
  }
}

function activeScenario(selectedOption: unknown): Scenario {
  const tracer = namedPiece({
    instanceId: 'tracer', templateId: 'tracer', ownerPlayerId: 'player-red', faction: 'red',
    x: 2, y: 3, currentHp: 11, maxHp: 15, name: '追迹者',
  })
  tracer.shield = 7
  tracer.buffs = [{ id: 'haste', stacks: 2 }]
  tracer.debuffs = [{ id: 'slow', currentDuration: 1 }]
  tracer.statusTags = [{ id: 'mark', type: 'mark', stacks: 1 }]
  return {
    pieces: [tracer],
    extensions: {
      recallData: [{
        pieceId: 'other-tracer', ownerPlayerId: 'player-red', targetCount: 1, actionCount: 0,
        snapshot: { x: 0, y: 0, hp: 20 },
      }],
    },
    pieceId: tracer.instanceId,
    selectedOption,
  }
}

function triggerScenario(options: {
  mode: 'endturn' | 'move' | 'skill'
  targetCount?: number
  actionCount?: number
  snapshot?: Record<string, any>
  blocker?: boolean
  invalidPosition?: boolean
  sourceDead?: boolean
  noHistory?: boolean
}): Scenario {
  const tracer = namedPiece({
    instanceId: 'tracer', templateId: 'tracer', ownerPlayerId: 'player-red', faction: 'red',
    x: 5, y: 6, currentHp: 3, maxHp: 15, name: '追迹者',
  })
  tracer.shield = 1
  tracer.statusTags = [{ id: 'now', type: 'now', stacks: 1 }]
  const actor = namedPiece({
    instanceId: 'actor', templateId: 'actor', ownerPlayerId: 'player-blue', faction: 'blue',
    x: 6, y: 6, currentHp: 20, maxHp: 20, name: '敌方行动者',
  })
  const pieces = [tracer, actor]
  if (options.blocker) pieces.push(namedPiece({ instanceId: 'blocker', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 3, name: '占位棋子' }))
  const snapshot = options.snapshot ?? {
    x: options.invalidPosition ? 99 : 2,
    y: options.invalidPosition ? 99 : 3,
    hp: 11,
    shield: 7,
    statusTags: [{ id: 'saved', type: 'saved', stacks: 2 }],
    buffs: [{ id: 'saved-buff', stacks: 1 }],
    debuffs: [{ id: 'saved-debuff', currentDuration: 2 }],
  }
  const scenario: Scenario = {
    pieces,
    width: 8,
    height: 8,
    extensions: {
      recallData: [{
        pieceId: tracer.instanceId,
        ownerPlayerId: tracer.ownerPlayerId,
        targetCount: options.targetCount ?? 1,
        actionCount: options.actionCount ?? 0,
        snapshot,
      }],
    },
    pieceId: tracer.instanceId,
    rulePieceId: tracer.instanceId,
    sourcePieceId: actor.instanceId,
    playerId: options.mode === 'endturn' ? actor.ownerPlayerId : undefined,
  }
  if (options.noHistory) scenario.extensions = {}
  if (options.sourceDead) {
    scenario.sourcePiece = { ...clone(actor), currentHp: 0 }
    scenario.pieces = [tracer]
  }
  return scenario
}

function pulseScenario(): Scenario {
  const caster = namedPiece({ instanceId: 'caster', templateId: 'caster', ownerPlayerId: 'player-red', faction: 'red', x: 0, y: 0, attack: 10, name: '脉冲手枪持有者' })
  const trigger = namedPiece({ instanceId: 'trigger', templateId: 'trigger', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 5, name: '移动来源' })
  const enemyA = namedPiece({ instanceId: 'enemy-a', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0, currentHp: 30, name: '敌人甲' })
  const enemyB = namedPiece({ instanceId: 'enemy-b', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 30, name: '敌人乙' })
  return {
    pieces: [caster, trigger, enemyA, enemyB],
    width: 8,
    height: 8,
    pieceId: caster.instanceId,
    rulePieceId: caster.instanceId,
    sourcePieceId: trigger.instanceId,
    playerId: trigger.ownerPlayerId,
  }
}

function graphStatements(graph: any): any[] {
  const result: any[] = []
  const visit = (statements: any[]): void => {
    for (const statement of statements) {
      result.push(statement)
      if (statement.kind === 'if') {
        visit(statement.then)
        if (statement.else) visit(statement.else)
      } else if (statement.kind === 'foreach' || statement.kind === 'collection') {
        visit(statement.body)
      } else if (statement.kind === 'while') {
        visit(statement.condition.body)
        visit(statement.body)
      }
    }
  }
  visit(graph.body)
  return result
}

describe('RED-252 semantic Recall graphs', () => {
  it('compiles each closed graph and emits an executable module document', () => {
    for (const id of RECALL_SKILL_IDS) {
      const graph = buildRecallGraph(id)
      expect(() => compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)).not.toThrow()
      const document = applyGameplayModuleGraph(sourceDefinition(id), graph) as any
      assertGameplayModuleDocument(document)
      expect(document.gameplayModules.entries.code.graph.surface).toBe(id === 'recall' ? 'skill' : 'triggerSkill')
      expect(document.code).toEqual(expect.any(String))
    }
  })

  it('preserves an authored graph and unknown document metadata on dry and write reruns', () => {
    const root = mkdtempSync(join(tmpdir(), 'red252-recall-'))
    try {
      mkdirSync(join(root, 'tests/game/fixtures'), { recursive: true })
      mkdirSync(join(root, 'data/skills'), { recursive: true })
      cpSync('tests/game/fixtures/RED-252-legacy-content.json', join(root, 'tests/game/fixtures/RED-252-legacy-content.json'))
      for (const id of RECALL_SKILL_IDS) cpSync(`data/skills/${id}.json`, join(root, 'data/skills', `${id}.json`))

      const file = join(root, 'data/skills/recall.json')
      const current = JSON.parse(readFileSync(file, 'utf8')) as any
      const authoredGraph = clone(current.gameplayModules.entries.code.graph) as any
      authoredGraph.body.push({
        kind: 'call',
        id: 'author-extra-node',
        module: 'text.concat',
        version: '1',
        inputs: {
          left: { kind: 'literal', value: '作者' },
          right: { kind: 'literal', value: '节点' },
        },
        parameters: {},
      })
      const authored = applyGameplayModuleGraph(current, authoredGraph) as any
      authored.authoringNotes = { keep: true, source: 'editor' }
      writeFileSync(file, JSON.stringify(authored, null, 2) + '\n')
      const before = readFileSync(file, 'utf8')

      migrateRecall(root, false)
      expect(readFileSync(file, 'utf8')).toBe(before)
      migrateRecall(root, true)
      expect(readFileSync(file, 'utf8')).toBe(before)
      const after = JSON.parse(readFileSync(file, 'utf8')) as any
      expect(after.authoringNotes).toEqual({ keep: true, source: 'editor' })
      expect(after.gameplayModules.entries.code.graph.body).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'author-extra-node', module: 'text.concat' }),
      ]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps Recall fields independently editable instead of restoring one snapshot atomically', () => {
    const active = graphStatements(buildRecallGraph('recall'))
    const trigger = graphStatements(buildRecallGraph('recall-endturn-trigger'))
    const countedTrigger = graphStatements(buildRecallGraph('recall-move-trigger'))
    const calls = [...active, ...trigger, ...countedTrigger].filter(statement => statement.kind === 'call')
    const modules = calls.map(statement => statement.module)
    expect(modules).not.toContain('recall.capture')
    expect(modules).not.toContain('recall.restore')

    const recordCreate = active.find(statement => statement.kind === 'record.create')
    expect(recordCreate?.schema).toBe('recall-record@1')
    expect(Object.keys(recordCreate?.fields ?? {})).toEqual(expect.arrayContaining([
      'x', 'y', 'hp', 'shield', 'statusTags', 'buffs', 'debuffs',
    ]))
    const recordGets = [...trigger, ...countedTrigger].filter(statement => statement.kind === 'record.get').map(statement => statement.field)
    expect(recordGets).toEqual(expect.arrayContaining(['x', 'y', 'hp', 'shield', 'statusTags', 'buffs', 'debuffs']))
    expect(modules).toEqual(expect.arrayContaining([
      'recall.store-record', 'recall.replace-count', 'recall.restore-hp',
      'recall.restore-shield', 'recall.restore-status-tags', 'recall.restore-buffs',
      'recall.restore-debuffs', 'recall.remove',
    ]))
    expect(countedTrigger.some(statement => statement.kind === 'record.with')).toBe(true)
  })

  it('preserves active Recall success, snapshot replacement, and invalid option behavior', () => {
    expect(run('recall', true, activeScenario(4))).toEqual(run('recall', false, activeScenario(4)))
    expect(run('recall', true, activeScenario('invalid'))).toEqual(run('recall', false, activeScenario('invalid')))
  })

  it.each([
    ['recall-endturn-trigger', 'endturn', {}],
    ['recall-endturn-trigger', 'endturn', { blocker: true }],
    ['recall-endturn-trigger', 'endturn', { invalidPosition: true }],
    ['recall-move-trigger', 'move', { targetCount: 2, actionCount: 0 }],
    ['recall-skill-trigger', 'skill', { targetCount: 2, actionCount: 0 }],
    ['recall-move-trigger', 'move', { sourceDead: true }],
  ] as const)('preserves trigger behavior for %s (%s)', (id, mode, options) => {
    const scenario = triggerScenario({ mode, ...options })
    const semantic = run(id, true, scenario)
    const legacy = run(id, false, scenario)
    expect(semantic).toEqual(legacy)
  })

  it('preserves the second counted trigger and consumes its record', () => {
    for (const id of ['recall-move-trigger', 'recall-skill-trigger'] as const) {
      const scenario = triggerScenario({ mode: id === 'recall-move-trigger' ? 'move' : 'skill', targetCount: 2 })
      const semanticFirst = run(id, true, scenario)
      const legacyFirst = run(id, false, scenario)
      expect(semanticFirst).toEqual(legacyFirst)
      expect(semanticFirst.state.extensions.recallData[0].actionCount).toBe(1)
      // A second event is represented by a fresh equivalent scenario with the
      // first count carried forward; this also keeps both sides on root seed 594.
      const second = triggerScenario({ mode: id === 'recall-move-trigger' ? 'move' : 'skill', targetCount: 2, actionCount: 1 })
      const semanticSecond = run(id, true, second)
      const legacySecond = run(id, false, second)
      expect(semanticSecond).toEqual(legacySecond)
      expect(semanticSecond.state.extensions.recallData).toEqual([])
      expect(semanticSecond.state.pieces.find((piece: any) => piece.instanceId === 'tracer')).toMatchObject({ x: 2, y: 3, currentHp: 11 })
    }
  })

  it('keeps trigger no-history calls side-effect free', () => {
    for (const [id, mode] of [
      ['recall-endturn-trigger', 'endturn'],
      ['recall-move-trigger', 'move'],
      ['recall-skill-trigger', 'skill'],
    ] as const) {
      const scenario = triggerScenario({ mode, noHistory: true })
      expect(run(id, true, scenario)).toEqual(run(id, false, scenario))
    }
  })

  it('preserves deterministic pulse-pistol target selection, damage, RNG cursor, and presentation', () => {
    const scenario = pulseScenario()
    const semantic = run('pulse-pistol-move', true, scenario)
    const legacy = run('pulse-pistol-move', false, scenario)
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toMatchObject({ success: true, message: expect.stringContaining('脉冲手枪触发') })
    expect(semantic.runtime.cursors['skill/effect']).toBe(1)
  })
})
