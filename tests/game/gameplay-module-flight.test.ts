/* eslint-disable @typescript-eslint/no-explicit-any -- host parity fixtures intentionally use battle-shaped records. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_GRAPH_VERSION,
} from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  buildTailsFlightResolveGraph,
  buildTailsTwinFlightGraph,
  FLIGHT_MOVE_COMPOSITE,
  FLIGHT_RECORD_SCHEMAS,
  FLIGHT_RULE_ID,
  FLIGHT_SKILL_ID,
  runSemanticFlightMigrations,
  SEMANTIC_FLIGHT_MIGRATIONS,
} from '@/scripts/migrate-semantic-flight'
import { applyBattleAction } from '@/lib/game/turn'
import { changePiecePositions } from '@/lib/game/position-change'
import { prepareAction } from '@/lib/game/targeting'
import { loadRuleById, loadSkillById, clearRuleCache } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord>; baseSha?: string }

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as Fixture
const approvedDescription = '选择其他友军（4）。在自身7格内选择2个上下左右相邻的空地或掩体，分别标记为双方落点。标记格可被进入。双方获得免疫[2]与不可操作[2]。此后的第2个己方回合结束时分别传送至标记格。落点被占或无法落脚时，仅取消对应棋子的传送。结束飞行状态。'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function modules(graph: any): string[] {
  const result: string[] = []
  const visit = (body: readonly any[]) => body.forEach(node => {
    if (node.kind === 'call') result.push(node.module)
    if (node.kind === 'if') { visit(node.then); visit(node.else ?? []) }
    if (node.kind === 'foreach') visit(node.body)
  })
  visit(graph.body)
  for (const composite of graph.composites ?? []) visit(composite.body)
  return result
}

function migratedDocument(id: typeof FLIGHT_SKILL_ID | typeof FLIGHT_RULE_ID): JsonRecord {
  const entry = SEMANTIC_FLIGHT_MIGRATIONS.find(item => item.id === id)
  if (!entry) throw new Error(`Unknown flight migration ${id}`)
  return applyGameplayModuleGraph(clone(fixture.entries[id]), entry.build(), entry.field) as JsonRecord
}

function writeJson(root: string, relative: string, value: unknown): void {
  const filename = join(root, 'data', relative)
  mkdirSync(join(filename, '..'), { recursive: true })
  writeFileSync(filename, JSON.stringify(value), 'utf8')
}

function writeFlightFiles(root: string, skill: JsonRecord, rule: JsonRecord, guardRules: 'legacy' | 'semantic' = 'legacy'): void {
  writeJson(root, 'skills/tails-twin-flight.json', skill)
  writeJson(root, 'rules/rule-tails-flight-resolve.json', rule)
  const ids = [
    'rule-tails-flight-immune',
    'rule-tails-flight-immune-target',
    'rule-tails-flight-inoperable',
    'rule-tails-flight-inoperable-skill',
  ]
  for (const id of ids) {
    const key = `rules/${id}`
    const value = guardRules === 'legacy'
      ? fixture.entries[key]
      : JSON.parse(readFileSync(`data/rules/${id}.json`, 'utf8'))
    writeJson(root, `rules/${id}.json`, value)
  }
}

function withProfile<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-semantic-flight-'))
  mkdirSync(join(root, 'data'), { recursive: true })
  const previousRoot = process.env.RVB_PROFILE_ROOT
  try {
    process.env.RVB_PROFILE_ROOT = root
    return callback(root)
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

type LandingScenario = 'both-valid' | 'tails-invalid' | 'ally-invalid' | 'both-invalid'
type RuleScenario = LandingScenario | 'ally-dead'

function landingSnapshot(state: any, result?: unknown): unknown {
  const copy = clone(state)
  delete copy.skillsById
  return { state: copy, result }
}

function assertFlightCommitted(state: any): void {
  expect(state.extensions?.flowState).toBeUndefined()
  const tails = state.pieces.find((piece: any) => piece.instanceId === 'tails')
  const ally = state.pieces.find((piece: any) => piece.instanceId === 'ally')
  expect(tails?.statusTags?.some((tag: any) => tag.type === 'tails-flight-reservation' && tag.ownerId === 'tails')).toBe(true)
  expect(tails?.statusTags?.some((tag: any) => tag.type === 'immune' && tag.flightId)).toBe(true)
  expect(tails?.statusTags?.some((tag: any) => tag.type === 'inoperable' && tag.flightId)).toBe(true)
  expect(ally?.statusTags?.some((tag: any) => tag.type === 'immune' && tag.flightId)).toBe(true)
  expect(ally?.statusTags?.some((tag: any) => tag.type === 'inoperable' && tag.flightId)).toBe(true)
  expect((state.extensions?.tileEffects ?? []).filter((effect: any) => effect.type === 'tails-flight-reservation')).toHaveLength(2)
}

function assertFlightSettled(state: any, scenario: LandingScenario): void {
  expect(state.extensions?.flowState).toBeUndefined()
  const tails = state.pieces.find((piece: any) => piece.instanceId === 'tails')
  const ally = state.pieces.find((piece: any) => piece.instanceId === 'ally')
  const tailsLands = scenario === 'both-valid' || scenario === 'ally-invalid'
  const allyLands = scenario === 'both-valid' || scenario === 'tails-invalid'
  expect(tails).toMatchObject(tailsLands ? { x: 4, y: 4 } : { x: 1, y: 1 })
  expect(ally).toMatchObject(allyLands ? { x: 4, y: 5 } : { x: 2, y: 1 })
  expect((state.extensions?.tileEffects ?? []).some((effect: any) => effect.type === 'tails-flight-reservation')).toBe(false)
  expect(state.pieces.every((piece: any) => !(piece.statusTags ?? []).some((tag: any) => tag.flightId))).toBe(true)
  expect((tails?.rules ?? []).some((rule: any) => rule.id === FLIGHT_RULE_ID.slice('rules/'.length))).toBe(false)
}

function runSkillScenario(root: string, skill: JsonRecord, rule: JsonRecord, scenario: LandingScenario): unknown {
  writeFlightFiles(root, skill, rule)
  clearRuleCache()
  const definition = loadSkillById('tails-twin-flight', true)
  if (!definition) throw new Error('Failed to load tails-twin-flight')
  const tails = makePiece({ instanceId: 'tails', templateId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1, skills: [{ skillId: definition.id, currentCooldown: 0 }] }) as any
  const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1 }) as any
  const blockerA = makePiece({ instanceId: 'blocker-a', ownerPlayerId: 'player-blue', x: 7, y: 6 }) as any
  const blockerB = makePiece({ instanceId: 'blocker-b', ownerPlayerId: 'player-blue', x: 7, y: 7 }) as any
  let state = makeState({ pieces: [tails, ally, blockerA, blockerB], width: 8, height: 8 }) as any
  state.skillsById[definition.id] = definition
  const first = prepareAction(state, {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: tails.instanceId, skillId: definition.id,
  })
  if (first.kind !== 'needTarget') throw new Error('Expected flight selection')
  state = applyBattleAction(state, {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: tails.instanceId, skillId: definition.id,
    targetPieceId: ally.instanceId, extraTargets: [{ x: 4, y: 4 }, { x: 4, y: 5 }],
    selectionId: first.selectionId, stateRevision: first.stateRevision,
  })
  assertFlightCommitted(state)
  const committedSnapshot = landingSnapshot(state)
  const occupied: Array<{ pieceId: string; x: number; y: number }> = []
  if (scenario === 'tails-invalid' || scenario === 'both-invalid') occupied.push({ pieceId: blockerA.instanceId, x: 4, y: 4 })
  if (scenario === 'ally-invalid' || scenario === 'both-invalid') occupied.push({ pieceId: blockerB.instanceId, x: 4, y: 5 })
  if (occupied.length && !changePiecePositions(state, occupied, 'teleport').success) throw new Error('Failed to place expiry blocker')
  for (const offset of [0, 2, 2]) {
    state = applyBattleAction({ ...state, turn: { ...state.turn, phase: 'action', currentPlayerId: 'player-red', turnNumber: state.turn.turnNumber + offset } }, {
      type: 'endTurn', playerId: 'player-red',
    })
  }
  assertFlightSettled(state, scenario)
  return { committed: committedSnapshot, settled: landingSnapshot(state) }
}

function runRuleScenario(root: string, rule: JsonRecord, scenario: RuleScenario): unknown {
  writeFlightFiles(root, fixture.entries[FLIGHT_SKILL_ID], rule)
  clearRuleCache()
  const loaded = loadRuleById('rule-tails-flight-resolve', true, true)
  if (!loaded) throw new Error('Failed to load rule-tails-flight-resolve')
  const tails = makePiece({ instanceId: 'tails', ownerPlayerId: 'player-red', x: 1, y: 1 }) as any
  const ally = makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: scenario === 'ally-dead' ? 0 : 100 }) as any
  const blockerA = makePiece({ instanceId: 'blocker-a', ownerPlayerId: 'player-blue', x: 7, y: 6 }) as any
  const blockerB = makePiece({ instanceId: 'blocker-b', ownerPlayerId: 'player-blue', x: 7, y: 7 }) as any
  const flightId = 'tails-flight-tails-1-4-4-4-5'
  const related = ['rule-tails-flight-resolve']
  tails.statusTags = [
    { id: flightId, type: 'tails-flight-reservation', flightId, ownerId: tails.instanceId, allyId: ally.instanceId, x: 4, y: 4, allyX: 4, allyY: 5, currentDuration: 1, appliedTurn: 1, relatedRules: related },
    { id: `${flightId}-immune-tails`, type: 'immune', flightId, currentDuration: 1, relatedRules: ['rule-tails-flight-immune'] },
    { id: `${flightId}-inoperable-tails`, type: 'inoperable', flightId, currentDuration: 1, relatedRules: ['rule-tails-flight-inoperable'] },
  ]
  ally.statusTags = [
    { id: `${flightId}-immune-ally`, type: 'immune', flightId, currentDuration: 1, relatedRules: ['rule-tails-flight-immune-target'] },
    { id: `${flightId}-inoperable-ally`, type: 'inoperable', flightId, currentDuration: 1, relatedRules: ['rule-tails-flight-inoperable-skill'] },
  ]
  tails.rules = [{ id: 'rule-tails-flight-resolve' }]
  const state = makeState({ pieces: [tails, ally, blockerA, blockerB], width: 8, height: 8 }) as any
  state.turn.turnNumber = 2
  state.extensions!.tileEffects = [
    { id: `${flightId}-a`, type: 'tails-flight-reservation', flightId, x: 4, y: 4 },
    { id: `${flightId}-b`, type: 'tails-flight-reservation', flightId, x: 4, y: 5 },
    { id: 'other-effect', type: 'unrelated', x: 0, y: 0 },
  ]
  const occupied: Array<{ pieceId: string; x: number; y: number }> = []
  if (scenario === 'tails-invalid' || scenario === 'both-invalid') occupied.push({ pieceId: blockerA.instanceId, x: 4, y: 4 })
  if (scenario === 'ally-invalid' || scenario === 'both-invalid') occupied.push({ pieceId: blockerB.instanceId, x: 4, y: 5 })
  if (occupied.length && !changePiecePositions(state, occupied, 'teleport').success) throw new Error('Failed to place rule blocker')
  const result = loaded.effect(state, { type: 'endTurn', playerId: 'player-red', rulePiece: tails, piece: tails, sourcePiece: tails })
  expect(result).toMatchObject({ success: true })
  if (scenario === 'ally-dead') {
    expect(state.extensions?.flowState).toBeUndefined()
    expect(tails).toMatchObject({ x: 4, y: 4 })
    expect(ally).toMatchObject({ x: 2, y: 1, currentHp: 0 })
    expect((state.extensions?.tileEffects ?? []).some((effect: any) => effect.type === 'tails-flight-reservation')).toBe(false)
    expect((tails.statusTags ?? []).some((tag: any) => tag.flightId)).toBe(false)
    expect((ally.statusTags ?? []).some((tag: any) => tag.flightId)).toBe(true)
  } else {
    assertFlightSettled(state, scenario)
  }
  return landingSnapshot(state, result)
}

describe('RED-252 semantic delayed flight modules', () => {
  it('expands both entries into typed, reusable modules', () => {
    const skill = buildTailsTwinFlightGraph()
    const rule = buildTailsFlightResolveGraph()
    expect(skill.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
    expect(rule.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
    expect(skill.schemas).toEqual(FLIGHT_RECORD_SCHEMAS)
    expect(rule.composites).toEqual(expect.arrayContaining([expect.objectContaining({ id: FLIGHT_MOVE_COMPOSITE.id })]))
    expect(modules(skill)).toEqual(expect.arrayContaining([
      'choice.target-piece', 'choice.target-cell', 'choice.is-unresolved', 'choice.as-result',
      'spatial.cell-adjacent', 'spatial.cell-landing-legal', 'tile.has-effect', 'tile.add-reservation',
      'status.apply-record', 'result.action',
    ]))
    expect(modules(rule)).toEqual(expect.arrayContaining([
      'query.has-piece', 'event.player', 'query.has-player', 'query.player', 'piece.owner', 'compare.equal-player', 'status.find-flight', 'turn.number', 'spatial.cell-landing-legal', 'effect.teleport-if-present',
      'status.remove-by-flight', 'tile.clear-flight-reservations', 'rule.remove-piece', 'result.message',
    ]))
    expect(modules(rule)).not.toContain('flowState')
    expect([...modules(skill), ...modules(rule)].some(module => module.includes('native') || module.includes('execute'))).toBe(false)
    compileGameplayModuleGraph(skill, GAMEPLAY_MODULE_REGISTRY)
    compileGameplayModuleGraph(rule, GAMEPLAY_MODULE_REGISTRY)
  })

  it('keeps current wording, metadata, and generated ownership tied to the graph', () => {
    const skill = JSON.parse(readFileSync('data/skills/tails-twin-flight.json', 'utf8')) as JsonRecord
    const rule = JSON.parse(readFileSync('data/rules/rule-tails-flight-resolve.json', 'utf8')) as JsonRecord
    expect(skill.description).toBe(approvedDescription)
    expect(rule.name).toBe(fixture.entries[FLIGHT_RULE_ID].name)
    expect(rule.description).toBe(fixture.entries[FLIGHT_RULE_ID].description)
    for (const [document, field] of [[skill, 'code'], [rule, 'skillCode']] as const) {
      assertGameplayModuleDocument(document)
      expect(document.gameplayModules.entries[field].graph.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
      expect(document.contentGraph).toBeUndefined()
      expect(document.contentGraphField).toBeUndefined()
    }
  })

  it('preflights both frozen entries in an isolated temporary profile', () => {
    withProfile(root => {
      writeJson(root, 'skills/tails-twin-flight.json', fixture.entries[FLIGHT_SKILL_ID])
      writeJson(root, 'rules/rule-tails-flight-resolve.json', fixture.entries[FLIGHT_RULE_ID])
      const reports = runSemanticFlightMigrations(root, fixture)
      expect(reports).toHaveLength(2)
      expect(reports.every(report => report.status === 'ready')).toBe(true)
      expect(reports.every(report => report.document)).toBe(true)
    })
  })

  it('preserves valid authored graphs and rejects changed legacy executables', () => {
    withProfile(root => {
      const authored = migratedDocument(FLIGHT_SKILL_ID)
      authored.description = '作者定制说明'
      writeJson(root, 'skills/tails-twin-flight.json', authored)
      const retained = runSemanticFlightMigrations(root, fixture, [FLIGHT_SKILL_ID])[0]
      expect(retained.status).toBe('ready')
      expect(retained.document).toEqual(authored)
      writeJson(root, 'skills/tails-twin-flight.json', {
        ...fixture.entries[FLIGHT_SKILL_ID], code: 'function executeSkill() { return { success: false }; }',
      })
      const rejected = runSemanticFlightMigrations(root, fixture, [FLIGHT_SKILL_ID])[0]
      expect(rejected.status).toBe('blocked')
      expect(rejected.error).toContain('author executable differs')
    })
  })

  it('matches frozen real-host behavior for both valid, one invalid, and both invalid landings', () => {
    const semanticSkill = migratedDocument(FLIGHT_SKILL_ID)
    const semanticRule = migratedDocument(FLIGHT_RULE_ID)
    for (const scenario of ['both-valid', 'tails-invalid', 'ally-invalid', 'both-invalid'] as const) {
      withProfile(root => {
        const legacySkill = runSkillScenario(root, fixture.entries[FLIGHT_SKILL_ID], fixture.entries[FLIGHT_RULE_ID], scenario)
        const semanticSkillResult = runSkillScenario(root, semanticSkill, semanticRule, scenario)
        expect(semanticSkillResult, `skill:${scenario}`).toEqual(legacySkill)
      })
      withProfile(root => {
        const legacyRule = runRuleScenario(root, fixture.entries[FLIGHT_RULE_ID], scenario)
        const semanticRuleResult = runRuleScenario(root, semanticRule, scenario)
        expect(semanticRuleResult, `rule:${scenario}`).toEqual(legacyRule)
      })
    }
  })

  it('keeps the frozen missing-live-ally cleanup boundary', () => {
    withProfile(root => {
      const legacy = runRuleScenario(root, fixture.entries[FLIGHT_RULE_ID], 'ally-dead')
      const semantic = runRuleScenario(root, migratedDocument(FLIGHT_RULE_ID), 'ally-dead')
      expect(semantic, 'rule:ally-dead').toEqual(legacy)
    })
  })
})

