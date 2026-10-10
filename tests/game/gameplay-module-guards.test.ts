/* eslint-disable @typescript-eslint/no-explicit-any -- frozen rule fixtures are intentionally data-shaped. */
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
import {
  buildSemanticGuardGraph,
  SEMANTIC_GUARD_CONFIGS,
  SEMANTIC_GUARD_MIGRATIONS,
  STATUS_GUARD_COMPOSITE_ID,
  runSemanticGuardMigrations,
} from '@/scripts/migrate-semantic-guards'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import { clearRuleCache, loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord>; baseSha?: string }
type GuardConfig = (typeof SEMANTIC_GUARD_CONFIGS)[number]

const fixture = JSON.parse(
  readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8'),
) as Fixture

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function statementModules(graph: any): string[] {
  const modules: string[] = []
  const visit = (body: readonly any[]) => {
    for (const node of body) {
      if (node.kind === 'call') modules.push(node.module)
      if (node.kind === 'if') {
        visit(node.then)
        visit(node.else ?? [])
      }
      if (node.kind === 'foreach') visit(node.body)
    }
  }
  visit(graph.body)
  for (const composite of graph.composites ?? []) visit(composite.body)
  return modules
}

function migratedDocument(config: GuardConfig): JsonRecord {
  const baseline = fixture.entries[config.id]
  if (!baseline) throw new Error(`Missing frozen guard fixture ${config.id}`)
  return applyGameplayModuleGraph(clone(baseline), buildSemanticGuardGraph(config), 'skillCode') as JsonRecord
}

type Scenario = {
  readonly status: boolean
  readonly dead?: boolean
  readonly missingHolder?: boolean
  readonly missingSubject?: boolean
  readonly wrongSubject?: boolean
}

function contextField(config: GuardConfig): 'piece' | 'sourcePiece' | 'targetPiece' {
  if (config.reference === 'source') return 'sourcePiece'
  if (config.reference === 'target') return 'targetPiece'
  return 'piece'
}

function scenarioState(config: GuardConfig, rule: any, scenario: Scenario): { state: any; context: any } {
  const holder = makePiece({ instanceId: 'guard-holder', ownerPlayerId: 'player-red', currentHp: scenario.dead ? 0 : 10 }) as any
  holder.name = '守卫棋子'
  const subject = makePiece({ instanceId: 'guard-subject', ownerPlayerId: 'player-blue' }) as any
  subject.name = '错误主体'
  const state = makeState({ pieces: [holder, subject] }) as any
  holder.statusTags = scenario.status ? [{ id: 'guard-status', type: config.statusType }] : []
  holder.rules = [rule]
  const context: any = {
    type: config.reference === 'event-piece'
      ? (config.id.includes('immune') ? 'beforeDamageTaken' : 'beforeMove')
      : config.id.includes('target') ? 'beforeSkillUse' : 'beforeMove',
    playerId: 'player-red',
    rulePiece: scenario.missingHolder ? null : holder,
    piece: holder,
    sourcePiece: holder,
    targetPiece: holder,
  }
  if (scenario.missingSubject) context[contextField(config)] = null
  else if (scenario.wrongSubject) context[contextField(config)] = subject
  return { state, context }
}

function behaviorSnapshot(state: any, result: unknown): unknown {
  return JSON.parse(JSON.stringify({
    result,
    pieces: state.pieces.map((piece: any) => ({
      instanceId: piece.instanceId,
      currentHp: piece.currentHp,
      statusTags: piece.statusTags,
      ruleIds: (piece.rules ?? []).map((rule: any) => rule.id),
    })),
  }))
}

function withRulePair<T>(config: GuardConfig, callback: (legacy: any, semantic: any) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-semantic-guards-'))
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  const previousRoot = process.env.RVB_PROFILE_ROOT
  const filename = join(root, 'data', 'rules', `${config.ruleId}.json`)
  const legacy = clone(fixture.entries[config.id])
  const semantic = migratedDocument(config)
  try {
    process.env.RVB_PROFILE_ROOT = root
    writeFileSync(filename, JSON.stringify(legacy), 'utf8')
    clearRuleCache()
    const legacyRule = loadRuleById(config.ruleId, true, true)
    if (!legacyRule) throw new Error(`Failed to load frozen rule ${config.ruleId}`)
    writeFileSync(filename, JSON.stringify(semantic), 'utf8')
    clearRuleCache()
    const semanticRule = loadRuleById(config.ruleId, true, true)
    if (!semanticRule) throw new Error(`Failed to load semantic rule ${config.ruleId}`)
    return callback(legacyRule, semanticRule)
  } finally {
    clearRuleCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

describe('RED-252 semantic status event guard batch', () => {
  it('builds every guard from one expandable graph composition', () => {
    for (const config of SEMANTIC_GUARD_CONFIGS) {
      const graph = buildSemanticGuardGraph(config)
      expect(graph.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
      expect(graph.surface).toBe('rule')
      expect(graph.composites).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: STATUS_GUARD_COMPOSITE_ID, version: '1' }),
      ]))
      const modules = statementModules(graph)
      expect(modules).toEqual(expect.arrayContaining([
        'ref.holder',
        config.reference === 'source' ? 'ref.source' : config.reference === 'target' ? 'ref.target' : 'ref.event-piece',
        'query.has-piece',
        'compare.equal-piece',
        'status.has-piece',
        'attribute.text',
        'text.concat',
        'rule.remove-piece',
        'event.block',
      ]))
      if (config.requiresAlive) expect(modules).toEqual(expect.arrayContaining(['attribute.read', 'compare.greater-than']))
      else expect(modules).not.toContain('attribute.read')
      expect(modules.some(module => module.includes('native') || module.includes('execute'))).toBe(false)
      const compiled = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      expect(compiled.code).toBe((migratedDocument(config).skillCode as string))
    }
  })

  it('keeps production rule metadata and generated fields tied to the semantic graph', () => {
    for (const config of SEMANTIC_GUARD_CONFIGS) {
      const current = JSON.parse(readFileSync(`data/${config.id}.json`, 'utf8')) as JsonRecord
      const frozen = fixture.entries[config.id]
      expect(current.name).toBe(frozen.name)
      expect(current.description).toBe(frozen.description)
      expect(current.trigger).toEqual(frozen.trigger)
      assertGameplayModuleDocument(current)
      expect(current.gameplayModules.entries.skillCode.graph.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
      expect(current.contentGraph).toBeUndefined()
      expect(current.contentGraphField).toBeUndefined()
    }
  })

  it('preflights all six frozen rules without touching a global resource root', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-semantic-guards-migration-'))
    mkdirSync(join(root, 'data', 'rules'), { recursive: true })
    try {
      for (const config of SEMANTIC_GUARD_CONFIGS) {
        // Use the frozen source as the isolated preflight input. Production
        // files are already migrated by this point and are checked above.
        writeFileSync(join(root, 'data', 'rules', `${config.ruleId}.json`), JSON.stringify(clone(fixture.entries[config.id])), 'utf8')
      }
      const run = runSemanticGuardMigrations(root, fixture)
      expect(run.reports).toHaveLength(SEMANTIC_GUARD_MIGRATIONS.length)
      expect(run.reports.every(report => report.status === 'ready')).toBe(true)
      expect(run.documents.size).toBe(SEMANTIC_GUARD_MIGRATIONS.length)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('matches the frozen host across missing references, wrong subjects, status expiry, and dead holders', () => {
    const scenarios: readonly [string, Scenario][] = [
      ['active', { status: true }],
      ['missing-holder', { status: true, missingHolder: true }],
      ['missing-subject', { status: true, missingSubject: true }],
      ['wrong-subject', { status: true, wrongSubject: true }],
      ['status-absent', { status: false }],
      ['dead', { status: true, dead: true }],
    ]
    for (const config of SEMANTIC_GUARD_CONFIGS) {
      withRulePair(config, (legacy, semantic) => {
        for (const [label, scenario] of scenarios) {
          const legacyInput = scenarioState(config, legacy, scenario)
          const semanticInput = scenarioState(config, semantic, scenario)
          const legacyResult = legacy.effect(legacyInput.state, legacyInput.context)
          const semanticResult = semantic.effect(semanticInput.state, semanticInput.context)
          expect(behaviorSnapshot(semanticInput.state, semanticResult), `${config.id}:${label}`)
            .toEqual(behaviorSnapshot(legacyInput.state, legacyResult))
        }
      })
    }
  })
})
