/* eslint-disable @typescript-eslint/no-explicit-any -- legacy host parity uses battle-shaped fixtures. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_COMPILER_VERSION,
  GAMEPLAY_MODULE_GRAPH_VERSION,
  GAMEPLAY_MODULE_REGISTRY,
} from '@/lib/skill-graph/module-document'
import { executeSkillFunction, clearRuleCache, clearSkillDefinitionCache, loadRuleById, loadSkillById } from '@/lib/game/skills'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { buildRemainingAuthoringGraph, REMAINING_AUTHORING_IDS, runRemainingAuthoringMigrations } from '@/scripts/migrate-semantic-remaining-authoring'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord>; baseSha: string }
type RuntimePair = { expected: any; actual: any }

const BASE_SHA = '082166c6b803b2e838bce5f0f6824c5bbc714dd6'
const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as Fixture

const SKILL_IDS = [
  'arthas-howling-blast',
  'blackwidow-toxin-damage',
  'elune-guidance-trigger',
  'elune-protection-trigger',
  'grimmjow-gran-rey-cero',
  'holy-shield-defense',
  'obito-kamui',
  'reap-heal',
  'venom-corrosion',
] as const

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function authoringPiece(overrides: Parameters<typeof makePiece>[0] = {}): ReturnType<typeof makePiece> {
  const piece = makePiece(overrides)
  if (Object.prototype.hasOwnProperty.call(overrides, 'name')) piece.name = overrides.name
  return piece
}

function baseline(relative: string): JsonRecord {
  return JSON.parse(execFileSync('git', ['show', `${BASE_SHA}:${relative}`], { encoding: 'utf8' })) as JsonRecord
}

function writeJson(root: string, relative: string, value: unknown): void {
  const filename = join(root, 'data', relative)
  mkdirSync(join(filename, '..'), { recursive: true })
  writeFileSync(filename, JSON.stringify(value), 'utf8')
}

function withProfile<T>(files: Readonly<Record<string, unknown>>, callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-remaining-authoring-'))
  const previousRoot = process.env.RVB_PROFILE_ROOT
  try {
    for (const [relative, value] of Object.entries(files)) writeJson(root, relative, value)
    process.env.RVB_PROFILE_ROOT = root
    clearRuleCache()
    clearSkillDefinitionCache()
    return callback(root)
  } finally {
    clearRuleCache()
    clearSkillDefinitionCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function comparable(battle: any, result: unknown, runtime: RuleRuntime): unknown {
  const state = clone(battle)
  delete state.skillsById
  return {
    state,
    result: clone(result),
    presentation: recordedBattlePresentation(battle),
    random: runtime.snapshot(),
  }
}

function runSkillDefinition(definition: JsonRecord, scenario: JsonRecord): any {
  const source = scenario.source as any
  const battle = makeState({ pieces: scenario.pieces as any }) as any
  battle.skillsById[definition.id] = definition
  const runtime = new RuleRuntime({ rootSeed: 252 })
  const context = {
    piece: source,
    skill: definition,
    battle,
    target: scenario.target ?? null,
    targetPosition: null,
    targets: scenario.target ? [{ info: scenario.target, pos: null }] : [],
    playerId: source.ownerPlayerId,
    ...(scenario.context ?? {}),
  }
  const result = withRuleRuntime(runtime, () => recordBattlePresentation(
    battle,
    () => executeSkillFunction(definition as any, context as any, battle, scenario.trigger
      ? { context, surface: 'triggerSkill' }
      : undefined),
    () => battle,
  ))
  return comparable(battle, result, runtime)
}

function freshSkillScenario(factory: () => JsonRecord): JsonRecord {
  const original = factory()
  const pieces = clone(original.pieces) as any[]
  const byId = new Map(pieces.map(piece => [piece.instanceId, piece]))
  const sourceId = original.source?.instanceId
  const targetId = original.target?.instanceId
  return {
    ...clone(original),
    pieces,
    source: sourceId && byId.has(sourceId) ? byId.get(sourceId) : clone(original.source),
    target: targetId && byId.has(targetId) ? byId.get(targetId) : original.target === undefined ? undefined : clone(original.target),
  }
}

function runSkillPair(relative: string, scenarioFactory: () => JsonRecord, dependencies: readonly string[] = []): RuntimePair {
  const semanticRaw = JSON.parse(readFileSync(relative, 'utf8')) as JsonRecord
  // The parent compiler pass may be re-emitting preview fields while this
  // focused runtime test runs.  Keep the skill graph under test and remove
  // unrelated stale preview artifacts from the temporary semantic document.
  const semanticBase = clone(semanticRaw)
  const semanticEntries = semanticBase.gameplayModules?.entries
  if (semanticEntries?.previewCode) {
    delete semanticBase.previewCode
    delete semanticEntries.previewCode
  }
  const semantic = applyGameplayModuleGraph(
    semanticBase,
    semanticBase.id === 'elune-protection-trigger'
      ? buildRemainingAuthoringGraph('elune-protection-trigger')
      : semanticEntries.code.graph,
    'code',
  ) as JsonRecord
  const legacy = baseline(relative.replaceAll('\\', '/'))
  const files: Record<string, unknown> = {}
  for (const dependency of dependencies) files[dependency.replace(/^data[\\/]/, '')] = baseline(dependency)
  return withProfile(files, root => {
    writeJson(root, `skills/${semantic.id}.json`, legacy)
    const expected = runSkillDefinition(loadSkillById(semantic.id, true)!, freshSkillScenario(scenarioFactory))
    writeJson(root, `skills/${semantic.id}.json`, semantic)
    clearSkillDefinitionCache()
    const actual = runSkillDefinition(loadSkillById(semantic.id, true)!, freshSkillScenario(scenarioFactory))
    return { expected, actual }
  })
}

function runRulePair(relative: string, scenarioFactory: () => { state: any; context: any }): RuntimePair {
  const semanticRaw = JSON.parse(readFileSync(relative, 'utf8')) as JsonRecord
  const semantic = applyGameplayModuleGraph(
    semanticRaw,
    semanticRaw.gameplayModules.entries.skillCode.graph,
    'skillCode',
  ) as JsonRecord
  const legacy = baseline(relative.replaceAll('\\', '/'))
  return withProfile({}, root => {
    writeJson(root, `rules/${semantic.id}.json`, legacy)
    const expectedRule = loadRuleById(semantic.id, true, true)!
    const expectedInput = scenarioFactory()
    const expectedResult = expectedRule.effect(expectedInput.state, expectedInput.context)
    const expected = { state: clone(expectedInput.state), result: clone(expectedResult) }
    writeJson(root, `rules/${semantic.id}.json`, semantic)
    clearRuleCache()
    const actualRule = loadRuleById(semantic.id, true, true)!
    const actualInput = scenarioFactory()
    const actualResult = actualRule.effect(actualInput.state, actualInput.context)
    const actual = { state: clone(actualInput.state), result: clone(actualResult) }
    return { expected, actual }
  })
}

function skillScenario(source: any, pieces: any[], target?: any, context: JsonRecord = {}, trigger = false): JsonRecord {
  return { source, pieces, target, context, trigger }
}

function roster(...pieces: any[]): any[] {
  return pieces
}

describe('RED-252 remaining authoring migrations', () => {
  it('preflights every owned legacy field and validates each newly generated artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-remaining-preflight-'))
    try {
      for (const id of [...SKILL_IDS, 'hand-cannon']) writeJson(root, `skills/${id}.json`, baseline(`data/skills/${id}.json`))
      writeJson(root, 'rules/rule-lucky-coin-gamestart.json', baseline('data/rules/rule-lucky-coin-gamestart.json'))
      const run = runRemainingAuthoringMigrations(root, fixture)
      expect(run.reports).toHaveLength(14)
      expect(run.reports.every(report => report.status === 'ready')).toBe(true)
      expect(run.documents.size).toBe(11)
      for (const [filename, document] of run.documents) {
        expect(filename).toMatch(/(?:data[\\/](?:skills|rules)[\\/])/)
        assertGameplayModuleDocument(document)
        for (const [field, entry] of Object.entries(document.gameplayModules.entries as JsonRecord)) {
          if (filename.endsWith(`${join('skills', 'hand-cannon.json')}`) && field === 'code') continue
          expect(entry.compilerVersion).toBe(GAMEPLAY_MODULE_COMPILER_VERSION)
          expect(document[field]).toBe(compileGameplayModuleGraph(entry.graph, GAMEPLAY_MODULE_REGISTRY).code)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects a tampered source when the legacy fixture has no entry', () => {
    expect(fixture.entries['skills/reap-heal']).toBeUndefined()
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-remaining-tamper-'))
    const filename = join(root, 'data', 'skills', 'reap-heal.json')
    try {
      const tampered = baseline('data/skills/reap-heal.json')
      expect(typeof tampered.code).toBe('string')
      tampered.code = `${tampered.code}\n// tampered after the frozen baseline`
      writeJson(root, 'skills/reap-heal.json', tampered)
      const before = readFileSync(filename, 'utf8')

      const run = runRemainingAuthoringMigrations(root, fixture, ['reap-heal.code'])
      expect(run.reports).toHaveLength(1)
      expect(run.reports[0].status).toBe('blocked')
      expect(run.reports[0].reason).toContain('author executable differs from frozen baseline')
      expect(run.documents.size).toBe(0)
      expect(readFileSync(filename, 'utf8')).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes typed graphs without raw script or whole-skill wrappers', () => {
    for (const id of REMAINING_AUTHORING_IDS.filter(value => !['blackwidow-toxin-damage', 'venom-corrosion', 'hand-cannon', 'rule-lucky-coin-gamestart'].includes(value))) {
      const graph = buildRemainingAuthoringGraph(id)
      expect(graph.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
      const serialized = JSON.stringify(graph)
      expect(serialized).not.toMatch(/"module":"(?:raw|script|whole-skill)/)
      expect(serialized).not.toContain('executeSkill')
      expect(serialized).not.toContain('whole-skill')
    }
  })

  it('keeps Arthas normal and empty-area state, result, presentation, and RNG parity', () => {
    const makeScenario = (empty: boolean) => {
      const caster = authoringPiece({ instanceId: 'caster', name: '阿尔萨斯', attack: 10, x: 2, y: 2, ownerPlayerId: 'player-red', moveRange: 3 }) as any
      const enemy = authoringPiece({ instanceId: 'enemy', name: '敌人', ownerPlayerId: 'player-blue', x: 3, y: 2, currentHp: 20, maxHp: 20, moveRange: 3 }) as any
      return skillScenario(caster, roster(caster, ...(empty ? [] : [enemy])), undefined)
    }
    const relative = 'data/skills/arthas-howling-blast.json'
    const normal = runSkillPair(relative, () => makeScenario(false), ['data/rules/rule-arthas-slow-restore.json']) as any
    expect(normal.actual).toEqual(normal.expected)
    const empty = runSkillPair(relative, () => makeScenario(true), ['data/rules/rule-arthas-slow-restore.json'])
    expect(empty.actual).toEqual(empty.expected)
  })

  it('keeps Grimmjow normal line damage and invalid diagonal selection parity', () => {
    const run = (diagonal: boolean) => {
      const caster = authoringPiece({ instanceId: 'caster', name: '葛力姆乔', attack: 4, x: 1, y: 1, ownerPlayerId: 'player-red' }) as any
      const target = authoringPiece({ instanceId: 'target', name: '目标', ownerPlayerId: 'player-blue', x: diagonal ? 2 : 4, y: diagonal ? 2 : 1, currentHp: 20, maxHp: 20 }) as any
      const blocker = authoringPiece({ instanceId: 'blocker', name: '沿线敌人', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 20, maxHp: 20 }) as any
      return runSkillPair('data/skills/grimmjow-gran-rey-cero.json', () => skillScenario(caster, roster(caster, blocker, target), target))
    }
    const normal = run(false) as any
    // Normal/true is the approved author damage contract. Only the two legacy
    // magical labels change; both actual hits and all other runtime channels
    // remain under the full differential assertion below.
    const legacyHits = normal.expected.state.actions.filter((action: any) => action.type === 'damage')
    expect(legacyHits).toHaveLength(2)
    for (const hit of legacyHits) {
      expect(hit.payload).toMatchObject({ skillId: 'grimmjow-gran-rey-cero', damageType: 'magical', sourceId: 'caster' })
      hit.payload.damageType = 'physical'
    }
    expect(normal.actual).toEqual(normal.expected)
    const invalid = run(true) as any
    expect(invalid.actual).toEqual(invalid.expected)
  })

  it('keeps Obito activation and existing-shield status parity', () => {
    const run = (shielded: boolean) => {
      const statusTags = shielded ? [{ id: 'existing-shield', type: 'kamui-shield' }] : []
      const caster = authoringPiece({ instanceId: 'caster', name: '带土', ownerPlayerId: 'player-red', statusTags }) as any
      return runSkillPair('data/skills/obito-kamui.json', () => skillScenario(caster, [caster]), ['data/rules/rule-obito-kamui-block.json'])
    }
    const active = run(false) as any
    expect(active.actual).toEqual(active.expected)
    const already = run(true) as any
    expect(already.actual).toEqual(already.expected)
  })

  it('keeps trigger skill normal, empty, invalid, and status branches in parity', () => {
    const guidance = (cardId: string, stacks: number, targetHp = 4) => {
      const source = authoringPiece({ instanceId: 'source', name: '事件来源', ownerPlayerId: 'player-red' }) as any
      const tyrande = authoringPiece({ instanceId: 'tyrande', templateId: 'tyrande', name: '泰兰德', ownerPlayerId: 'player-red', currentHp: 20, maxHp: 20, faction: 'red', statusTags: stacks ? [{ id: 'moon-glow', type: 'buff', stacks }] : [] }) as any
      const ally = authoringPiece({ instanceId: 'ally', name: '友军', ownerPlayerId: 'player-red', currentHp: targetHp, maxHp: 20 }) as any
      return runSkillPair('data/skills/elune-guidance-trigger.json', () => skillScenario(source, roster(source, tyrande, ally), undefined, { cardId, playerId: 'player-red' }, true))
    }
    for (const [cardId, stacks] of [['holy-light', 0], ['holy-light', 1], ['dark-curse', 0]] as const) {
      const pair = guidance(cardId, stacks)
      expect(pair.actual, `${cardId}:${stacks}`).toEqual(pair.expected)
    }

    const protection = (damage: number, protectedAlready: boolean) => {
      const target = authoringPiece({ instanceId: 'target', name: '目标', ownerPlayerId: 'player-red', faction: 'red', currentHp: 5, maxHp: 20, statusTags: protectedAlready ? [{ id: 'elune-protection-used', type: 'buff' }] : [] }) as any
      const tyrande = authoringPiece({ instanceId: 'tyrande', templateId: 'tyrande', name: '泰兰德', ownerPlayerId: 'player-blue', faction: 'red', currentHp: 10, maxHp: 20 }) as any
      return runSkillPair('data/skills/elune-protection-trigger.json', () => skillScenario(target, roster(target, tyrande), undefined, { damage }, true))
    }
    for (const [damage, protectedAlready] of [[5, false], [1, false], [5, true]] as const) {
      const pair = protection(damage, protectedAlready)
      expect(pair.actual, `protection:${damage}:${protectedAlready}`).toEqual(pair.expected)
    }
  }, 30_000)

  it('keeps Holy Shield, Reap, and constant trigger outcomes in parity', () => {
    const shield = (damage: number) => {
      const target = authoringPiece({ instanceId: 'target', name: '圣盾目标', ownerPlayerId: 'player-red', statusTags: [{ id: 'holy-shield', type: 'holy-shield' }] }) as any
      return runSkillPair('data/skills/holy-shield-defense.json', () => skillScenario(target, [target], undefined, { damage }, true))
    }
    const shieldPair = shield(7)
    expect(shieldPair.actual).toEqual(shieldPair.expected)
    const reap = (damage: number, currentHp: number) => {
      const source = authoringPiece({ instanceId: 'source', name: '收割者', ownerPlayerId: 'player-red', currentHp, maxHp: 20 }) as any
      return runSkillPair('data/skills/reap-heal.json', () => skillScenario(source, [source], undefined, { damage }, true))
    }
    for (const currentHp of [5, 20]) {
      const pair = reap(9, currentHp)
      expect(pair.actual, `reap:${currentHp}`).toEqual(pair.expected)
    }
    for (const id of ['blackwidow-toxin-damage', 'venom-corrosion'] as const) {
      const source = makePiece({ instanceId: 'source', ownerPlayerId: 'player-red' }) as any
      const pair = runSkillPair(`data/skills/${id}.json`, () => skillScenario(source, [source], undefined, {}, true))
      expect(pair.actual, id).toEqual(pair.expected)
    }
  })

  it('keeps lucky coin game-start state and message parity for player and empty contexts', () => {
    const run = (playerId?: string) => runRulePair('data/rules/rule-lucky-coin-gamestart.json', () => {
      const state = makeState() as any
      const player = playerId ? state.players.find((candidate: any) => candidate.playerId === playerId) : undefined
      const context = { type: 'gameStart', playerId, player, rulePiece: null, piece: null }
      return { state, context }
    })
    const playerPair = run('player-blue')
    expect(playerPair.actual).toEqual(playerPair.expected)
    const emptyPair = run(undefined)
    expect(emptyPair.actual).toEqual(emptyPair.expected)
  })
})
