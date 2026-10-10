/* eslint-disable @typescript-eslint/no-explicit-any -- frozen content fixtures are intentionally data-shaped. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
  GAMEPLAY_MODULE_GRAPH_VERSION,
} from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  buildHidanUndyingSkillGraph,
  buildLuckyCoinGraph,
  buildRafaamSampleCardGraph,
  buildReapSkillGraph,
  buildRuleReapGraph,
  HALF_DAMAGE_COMPOSITE,
  RESULT_MESSAGE_COMPOSITE,
  SEMANTIC_MIGRATIONS,
  SEMANTIC_REVIEW_GAPS,
  TAILS_MISSING_ATOMS,
} from '@/scripts/migrate-semantic-modules'
import {
  executeCardFunction,
  executeSkillFunction,
  loadRuleById,
  type CardDefinition,
  type SkillDefinition,
} from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>
type Fixture = { entries: Record<string, JsonRecord> }

const fixture = JSON.parse(
  readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8'),
) as Fixture

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function semanticDocument(id: string, field: 'code' | 'skillCode', graph: unknown): JsonRecord {
  const entry = clone(fixture.entries[id])
  const document = applyGameplayModuleGraph(entry, graph, field)
  assertGameplayModuleDocument(document)
  return document
}

function snapshot(value: unknown): unknown {
  if (typeof value === 'function') return { functionSource: String(value) }
  if (Array.isArray(value)) return value.map(snapshot)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, snapshot(nested)]))
  }
  return value
}

function hostBehaviorSnapshot(result: unknown, state: any): unknown {
  // The migrated definition intentionally has a generated executable `code`
  // and gameplay-module metadata. Those representation fields are not host
  // behavior; compare the result and mutable battle state instead.
  const behaviorState = { ...state }
  delete behaviorState.skillsById
  delete behaviorState.cardsById
  return snapshot({ result, state: behaviorState })
}

function skillInput(definition: SkillDefinition): { definition: SkillDefinition; state: any; piece: any } {
  const piece = makePiece({
    instanceId: 'semantic-sample-piece',
    templateId: 'semantic-sample-piece',
    ownerPlayerId: 'player-red',
    name: '语义样本',
  })
  const state = makeState({ pieces: [piece] })
  state.skillsById[definition.id] = definition
  return { definition, state, piece }
}

function runSkill(definition: SkillDefinition): unknown {
  const { state, piece } = skillInput(definition)
  const result = executeSkillFunction(definition, {
    piece,
    target: null,
    targetPosition: null,
    targets: [],
    skill: definition,
    battle: state,
  }, state)
  return hostBehaviorSnapshot(result, state)
}

function runCard(definition: CardDefinition, playerId = 'player-red'): unknown {
  const source = makePiece({
    instanceId: 'semantic-card-source',
    templateId: 'semantic-card-source',
    ownerPlayerId: 'player-red',
    name: '卡牌来源',
  })
  const state = makeState({ pieces: [source] })
  const cardInstance = {
    cardId: definition.id,
    instanceId: 'semantic-card-instance',
    ownerPlayerId: playerId,
    effectModifiers: [],
  }
  state.players[0].hand = [cardInstance]
  const result = executeCardFunction(
    definition,
    playerId,
    state,
    { sourcePiece: source, targetPiece: null },
    undefined,
    undefined,
    undefined,
    [],
    cardInstance,
  )
  return hostBehaviorSnapshot(result, state)
}

function loadRuleFromDefinition(definition: JsonRecord, loaderId: string): any {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-semantic-rule-'))
  mkdirSync(join(root, 'data', 'rules'), { recursive: true })
  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  try {
    writeFileSync(join(root, 'data', 'rules', `${loaderId}.json`), JSON.stringify({ ...clone(definition), id: loaderId }), 'utf8')
    const rule = loadRuleById(loaderId, true, true)
    if (!rule || typeof rule.effect !== 'function') throw new Error(`Failed to load temporary RED-252 rule ${loaderId}`)
    return rule
  } finally {
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function runReapRule(rule: any, damage: number, sameHolder: boolean): unknown {
  const source = makePiece({
    instanceId: 'semantic-rule-source',
    templateId: 'semantic-rule-source',
    ownerPlayerId: 'player-red',
    name: '伤害来源',
  })
  source.name = '伤害来源'
  const holder = sameHolder
    ? source
    : makePiece({
      instanceId: 'semantic-rule-holder',
      templateId: 'semantic-rule-holder',
      ownerPlayerId: 'player-red',
      name: '收割者',
    })
  if (!sameHolder) holder.name = '收割者'
  const state = makeState({ pieces: sameHolder ? [source] : [source, holder] })
  const queue: any[] = []
  const context = {
    type: 'afterDamageDealt',
    sourcePiece: source,
    rulePiece: holder,
    piece: source,
    playerId: 'player-red',
    damage,
    healQueue: { push: (entry: any) => { queue.push(entry); return queue.length } },
  }
  const result = rule.effect(state, context)
  return snapshot({ result, queue, state })
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

describe('RED-252 semantic gameplay content samples', () => {
  it('uses the approved semantic graph version and preserves the frozen entry metadata', () => {
    const samples = [
      ['skills/reap', 'code', buildReapSkillGraph()],
      ['skills/hidan-undying', 'code', buildHidanUndyingSkillGraph()],
      ['cards/rafaam-curse-sample', 'code', buildRafaamSampleCardGraph()],
    ] as const
    for (const [id, field, graph] of samples) {
      expect(graph.version).toBe(GAMEPLAY_MODULE_GRAPH_VERSION)
      const document = semanticDocument(id, field, graph)
      expect(document.id).toBe(fixture.entries[id].id)
      expect(document.description).toBe(fixture.entries[id].description)
      expect(document.gameplayModules).toMatchObject({ version: 'rvb-gameplay-module-document/v1' })
      expect(document.contentGraph).toBeUndefined()
      expect(document.contentGraphField).toBeUndefined()
    }
  })

  it('expands the same result composition across skill and card content', () => {
    const reap = buildReapSkillGraph()
    const hidan = buildHidanUndyingSkillGraph()
    const card = buildRafaamSampleCardGraph()
    for (const graph of [reap, hidan, card]) {
      expect(graph.composites).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: RESULT_MESSAGE_COMPOSITE.id, version: RESULT_MESSAGE_COMPOSITE.version }),
      ]))
      expect(statementModules(graph)).toContain(RESULT_MESSAGE_COMPOSITE.id)
    }
    const compiledReap = compileGameplayModuleGraph(reap, GAMEPLAY_MODULE_REGISTRY)
    const compiledCard = compileGameplayModuleGraph(card, GAMEPLAY_MODULE_REGISTRY)
    expect(compiledReap.dependencies).toEqual(expect.arrayContaining([
      { id: RESULT_MESSAGE_COMPOSITE.id, version: RESULT_MESSAGE_COMPOSITE.version, kind: 'composite' },
    ]))
    expect(compiledCard.dependencies).toEqual(expect.arrayContaining([
      { id: RESULT_MESSAGE_COMPOSITE.id, version: RESULT_MESSAGE_COMPOSITE.version, kind: 'composite' },
    ]))
  })

  it('keeps the reusable half-damage formula typed and leaves queue identity at the rule edge', () => {
    const graph = buildRuleReapGraph()
    expect(graph.composites).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: HALF_DAMAGE_COMPOSITE.id, version: HALF_DAMAGE_COMPOSITE.version }),
    ]))
    expect(statementModules(graph)).toContain(HALF_DAMAGE_COMPOSITE.id)
    expect(statementModules({ body: HALF_DAMAGE_COMPOSITE.body })).toEqual(expect.arrayContaining([
      'math.multiply',
      'math.floor',
    ]))
    expect(statementModules(graph)).toContain('effect.queue-heal')
  })

  it('matches the real skill host for the two fixed triggerSkill samples', () => {
    const pairs = [
      ['skills/reap', buildReapSkillGraph()],
      ['skills/hidan-undying', buildHidanUndyingSkillGraph()],
    ] as const
    for (const [id, graph] of pairs) {
      const legacy = fixture.entries[id] as unknown as SkillDefinition
      const semantic = semanticDocument(id, 'code', graph) as unknown as SkillDefinition
      expect(runSkill(semantic), id).toEqual(runSkill(legacy))
    }
  })

  it('matches the real card host for the fixed reactive sample', () => {
    const id = 'cards/rafaam-curse-sample'
    const legacy = fixture.entries[id] as unknown as CardDefinition
    const semantic = semanticDocument(id, 'code', buildRafaamSampleCardGraph()) as unknown as CardDefinition
    expect(runCard(semantic)).toEqual(runCard(legacy))
  })

  it('matches the real card host for Lucky Coin on success and missing-player rejection', () => {
    const id = 'cards/lucky-coin'
    const legacy = fixture.entries[id] as unknown as CardDefinition
    const semantic = semanticDocument(id, 'code', buildLuckyCoinGraph()) as unknown as CardDefinition
    expect(runCard(semantic, 'player-red')).toEqual(runCard(legacy, 'player-red'))
    expect(runCard(semantic, 'missing-player')).toEqual(runCard(legacy, 'missing-player'))
  })

  it('matches the real rule host for Reap success and rejection paths', () => {
    const id = 'rules/rule-reap'
    const legacy = loadRuleFromDefinition(fixture.entries[id], 'red252-rule-reap-legacy')
    const semantic = loadRuleFromDefinition(
      semanticDocument(id, 'skillCode', buildRuleReapGraph()),
      'red252-rule-reap-semantic',
    )
    for (const scenario of [
      { damage: 5, sameHolder: true },
      { damage: 0, sameHolder: true },
      { damage: 5, sameHolder: false },
    ]) {
      expect(runReapRule(semantic, scenario.damage, scenario.sameHolder), JSON.stringify(scenario))
        .toEqual(runReapRule(legacy, scenario.damage, scenario.sameHolder))
    }
  })

  it('uses registered typed atoms for Lucky Coin and Reap', () => {
    const lucky = SEMANTIC_MIGRATIONS.find(entry => entry.id === 'cards/lucky-coin')
    const reap = SEMANTIC_MIGRATIONS.find(entry => entry.id === 'rules/rule-reap')
    expect(lucky?.missingAtoms).toBeUndefined()
    expect(reap?.missingAtoms).toBeUndefined()
    expect(statementModules(buildLuckyCoinGraph())).toEqual(expect.arrayContaining([
      'ref.player',
      'query.has-player',
      'query.player',
      'resource.adjust',
      'text.from-number',
      'text.concat',
    ]))
    expect(statementModules(buildRuleReapGraph())).toEqual(expect.arrayContaining([
      'event.damage',
      HALF_DAMAGE_COMPOSITE.id,
      'query.piece',
      'attribute.text',
    ]))
  })

  it('reports Tails as a generic atom gap instead of accepting a native whole-skill wrapper', () => {
    expect(SEMANTIC_REVIEW_GAPS.map(entry => entry.id)).toEqual([
      'skills/tails-twin-flight',
      'rules/rule-tails-flight-resolve',
    ])
    expect(TAILS_MISSING_ATOMS).toEqual(expect.arrayContaining([
      'choice.require-piece',
      'record.create-flight',
      'effect.teleport-group',
      'state.get-record',
    ]))
    expect(TAILS_MISSING_ATOMS.some(atom => atom.includes('tails-twin-flight'))).toBe(false)
  })
})
