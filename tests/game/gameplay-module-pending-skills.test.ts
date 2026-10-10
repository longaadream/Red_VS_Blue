/* eslint-disable @typescript-eslint/no-explicit-any -- graph fixtures and host documents are JSON-shaped. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  type GameplayModuleGraph,
  type GameplayStatement,
} from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  runSemanticPendingMigrations,
  SEMANTIC_PENDING_MIGRATIONS,
} from '@/scripts/migrate-semantic-pending-skills'
import { prepareAction } from '@/lib/game/targeting'
import { loadAllSkillsById } from '@/lib/game/skills'
import { runBattleAction } from '@/lib/game/battle-runner'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type FrozenFixture = { entries: Record<string, JsonRecord>; baseSha: string }

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')) as FrozenFixture

function visitStatements(body: readonly GameplayStatement[], callback: (statement: GameplayStatement) => void): void {
  for (const statement of body) {
    callback(statement)
    if (statement.kind === 'if') {
      visitStatements(statement.then, callback)
      visitStatements(statement.else ?? [], callback)
    } else if (statement.kind === 'foreach' || statement.kind === 'collection') {
      visitStatements(statement.body, callback)
    }
  }
}

function graphs(root: GameplayModuleGraph): GameplayModuleGraph[] {
  const result: GameplayModuleGraph[] = []
  const visit = (graph: GameplayModuleGraph): void => {
    result.push(graph)
    for (const continuation of graph.continuations ?? []) visit(continuation.graph)
  }
  visit(root)
  return result
}

function calls(root: GameplayModuleGraph): Extract<GameplayStatement, { kind: 'call' }>[] {
  const result: Extract<GameplayStatement, { kind: 'call' }>[] = []
  for (const graph of graphs(root)) {
    visitStatements(graph.body, statement => {
      if (statement.kind === 'call') result.push(statement)
    })
    for (const composite of graph.composites ?? []) visitStatements(composite.body, statement => {
      if (statement.kind === 'call') result.push(statement)
    })
  }
  return result
}

function deferChoices(root: GameplayModuleGraph): Extract<GameplayStatement, { kind: 'defer-choice' }>[] {
  const result: Extract<GameplayStatement, { kind: 'defer-choice' }>[] = []
  for (const graph of graphs(root)) visitStatements(graph.body, statement => {
    if (statement.kind === 'defer-choice') result.push(statement)
  })
  return result
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('RED-252 semantic pending skill modules', () => {
  it('compiles every pending graph with real continuations and no legacy wrappers', () => {
    expect(SEMANTIC_PENDING_MIGRATIONS).toHaveLength(10)
    for (const migration of SEMANTIC_PENDING_MIGRATIONS) {
      const graph = migration.build()
      compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY)
      const modules = calls(graph).map(statement => statement.module)
      expect(modules).not.toContain('status.apply-divine-shield')
      expect(modules.some(module => /executeSkill|selectTarget|addStatusEffectById|displace\(/.test(module))).toBe(false)
      for (const choice of deferChoices(graph)) {
        expect(choice.canCancel).toEqual({ kind: 'literal', value: true })
        expect(graphs(graph).some(owner => (owner.continuations ?? []).some(entry => entry.id === choice.graph))).toBe(true)
      }
    }

    const turalyon = SEMANTIC_PENDING_MIGRATIONS.find(entry => entry.id === 'skills/turalyon-grand-crusade')!.build()
    expect(calls(turalyon).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'spatial.formation-selection-valid', 'spatial.formation-candidates', 'spatial.formation-slots',
      'effect.displace-many', 'status.apply-record', 'rule.has-piece', 'rule.apply-piece',
    ]))
    const minatoTrigger = SEMANTIC_PENDING_MIGRATIONS.find(entry => entry.id === 'rules/rule-minato-flying-raijin-trigger')!.build()
    expect(calls(minatoTrigger).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'choice.binary-option', 'choice.is-unresolved', 'choice.raw-string-value', 'marker.trigger-target', 'spatial.random-adjacent-landing',
    ]))
    const randomLanding = calls(minatoTrigger).find(statement => statement.module === 'spatial.random-adjacent-landing')
    expect(randomLanding?.inputs?.ignore).toEqual({ kind: 'output', node: 'minato', port: 'piece' })
    const expedition = SEMANTIC_PENDING_MIGRATIONS.find(entry => entry.id === 'skills/turalyon-expedition-order')!.build()
    expect(calls(expedition).map(statement => statement.module)).toEqual(expect.arrayContaining([
      'choice.multi-string', 'choice.is-unresolved', 'choice.raw-string-value', 'card.hand-add',
    ]))
    const march = SEMANTIC_PENDING_MIGRATIONS.find(entry => entry.id === 'rules/rule-turalyon-lightforged-march')!.build()
    expect(deferChoices(march).every(choice => choice.targetType?.kind === 'literal' && choice.targetType.value === (choice.id === 'piece-choice' ? 'piece' : 'grid'))).toBe(true)
    expect(deferChoices(march).every(choice => choice.resumeOnCancel?.kind === 'literal' && choice.resumeOnCancel.value === true)).toBe(true)
  })

  it('preflights all frozen entries before producing any document', () => {
    const root = mkdtempSync(join(tmpdir(), 'rvb-red252-pending-skills-'))
    try {
      for (const migration of SEMANTIC_PENDING_MIGRATIONS) {
        const value = fixture.entries[migration.id]
        if (!value) throw new Error(`Missing frozen entry ${migration.id}`)
        const filename = join(root, 'data', `${migration.id}.json`)
        mkdirSync(join(filename, '..'), { recursive: true })
        writeFileSync(filename, JSON.stringify(clone(value)), 'utf8')
      }
      const run = runSemanticPendingMigrations(root, fixture)
      expect(run.reports).toHaveLength(SEMANTIC_PENDING_MIGRATIONS.length)
      expect(run.reports.every(report => report.status === 'ready')).toBe(true)
      expect(run.documents.size).toBe(SEMANTIC_PENDING_MIGRATIONS.length)
      for (const document of run.documents.values()) assertGameplayModuleDocument(document)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('executes a real Minato pending host continuation and consumes one anchor', () => {
    const state = makeState({
      width: 8,
      height: 6,
      pieces: [
        makePiece({ instanceId: 'minato', templateId: 'blue-minato', x: 1, y: 1, skills: [{ skillId: 'minato-kunai-formula', currentCooldown: 0, usesRemaining: -1 }] }),
        makePiece({ instanceId: 'ally', x: 2, y: 1 }),
        makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 7, y: 5 }),
      ],
    })
    state.skillsById = loadAllSkillsById()
    state.extensions!.minatoAnchors = [{ x: 4, y: 3, sourceId: 'minato', ownerPlayerId: 'player-red' }]
    const draft = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'minato', skillId: 'minato-kunai-formula' } as const
    const root = prepareAction(state, draft)
    if (root.kind !== 'needTarget') throw new Error('missing Minato first pending target')
    const selected = { ...draft, targetPieceId: 'ally', selectionId: root.selectionId, stateRevision: root.stateRevision }
    const continuation = prepareAction(state, selected)
    if (continuation.kind !== 'needTarget') throw new Error('missing Minato continuation target')
    expect(continuation.targetType).toBe('cell')
    expect(continuation.candidates).toEqual([{ type: 'cell', x: 4, y: 3 }])
    const result = runBattleAction(state, { ...selected, extraTargets: [{ x: 4, y: 3 }] }, { rootSeed: 252 })
    expect(result.state.pieces.find(piece => piece.instanceId === 'ally')).toMatchObject({ x: 4, y: 3 })
    expect(result.state.extensions?.minatoAnchors).not.toEqual(expect.arrayContaining([expect.objectContaining({ x: 4, y: 3, sourceId: 'minato' })]))
    expect(result.state.pieces.find(piece => piece.instanceId === 'ally')?.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'flying-raijin-mark', sourceId: 'minato' })]))
  })
})
