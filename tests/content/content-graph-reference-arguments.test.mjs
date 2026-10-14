import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCoverageReport,
  dynamicArgumentIndices,
  scanSemanticGraphDynamic,
} from '../../scripts/audit-content-graph-coverage.mjs'

const literal = value => ({ kind: 'literal', value })
const output = (node, port = 'value') => ({ kind: 'output', node, port })

function semanticScanState() {
  return {
    knownIds: new Set(['holy-smite']),
    catalogs: {
      pieces: new Map(),
      skills: new Map(),
      rules: new Map(),
      cards: new Map([['holy-smite', { id: 'holy-smite', scope: 'ordinary' }]]),
    },
    legacyFixture: { entries: new Map() },
    registeredGraphProofs: { entries: {} },
    dynamic: [],
    dynamicKeys: new Set(),
    references: [],
    referenceKeys: new Set(),
    unknown: [],
    unknownKeys: new Set(),
    generatedFamilies: [],
    generatedFamilyKeys: new Set(),
    baselineMissingCandidates: [],
    baselineMissingCandidateKeys: new Set(),
  }
}

function scanSemanticGraph(graph) {
  const state = semanticScanState()
  scanSemanticGraphDynamic(
    state,
    {
      nodeKey: 'skills/reference-scope-test',
      group: 'skills',
      id: 'reference-scope-test',
      definition: {},
      migration: { fields: { code: { status: 'graph-validated' } } },
    },
    'code',
    'semantic-reference-scope-test',
    graph,
  )
  return state.dynamic
}

function randomSource(id, values) {
  return {
    kind: 'call',
    id,
    module: 'query.random-string',
    version: '1',
    inputs: { items: literal(values) },
    parameters: {},
  }
}

function dynamicSink(id, sourceId) {
  return {
    kind: 'call',
    id,
    module: 'card.hand-add-ref',
    version: '1',
    inputs: { player: literal('player'), cardId: output(sourceId) },
    parameters: {},
  }
}

test('hand queries do not treat player IDs as dynamic content IDs', () => {
  assert.deepEqual(dynamicArgumentIndices('flow.cards.hand', 1), [])
  assert.deepEqual(dynamicArgumentIndices('ctx.flow.cards.hand', 1), [])
})

test('flow definition writes inspect the content argument, not owner or optional scope', () => {
  assert.deepEqual(dynamicArgumentIndices('flow.cards.add', 2), [1])
  assert.deepEqual(dynamicArgumentIndices('ctx.flow.rules.add', 3), [1])
  assert.deepEqual(dynamicArgumentIndices('flow.skills.add', 2), [1])
  assert.deepEqual(dynamicArgumentIndices('addCardToHand', 2), [0])
  assert.deepEqual(dynamicArgumentIndices('addPlayerRuleById', 2), [1])
})

test('actual AST scan reports definition arguments and excludes hand owners and scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-reference-scan-'))
  try {
    for (const group of ['pieces', 'skills', 'rules', 'cards']) {
      mkdirSync(join(root, 'data', group), { recursive: true })
      writeFileSync(join(root, 'data', group, 'manifest.json'), JSON.stringify(group === 'rules' ? ['rule-test', 'rule-known'] : []))
    }
    writeFileSync(join(root, 'data/rules/rule-known.json'), JSON.stringify({ id: 'rule-known' }))
    writeFileSync(join(root, 'data/rules/rule-test.json'), JSON.stringify({ id: 'rule-test', skillCode: `
      flow.cards.hand(ownerId);
      flow.rules.add(ownerId, dynamicRuleId, 'player');
      addPlayerRuleById(ownerId, otherRuleId);
      flow.rules.add(ownerId, 'rule-known', 'player');
    ` }))
    const report = buildCoverageReport({ root })
    assert.deepEqual(report.dynamicReferences.map(item => item.expression).sort(), ['dynamicRuleId', 'otherRuleId'])
    assert.ok(report.references.some(item => item.from === 'rules/rule-test' && item.toId === 'rule-known'))
    assert.equal(report.semanticModuleCoverage.reachableInlineFields, 1)
    assert.equal(report.semanticModuleCoverage.validatedReachableInlineFields, 0)
    assert.deepEqual(report.semanticModuleCoverage.remainingReachableFields, ['rules/rule-test:skillCode'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('semantic dynamic sinks keep composite and continuation producers in their own graph scopes', () => {
  const graph = {
    version: 'rvb-gameplay-modules/v1',
    surface: 'skill',
    body: [randomSource('same-id', ['holy-smite'])],
    composites: [{
      id: 'scope-composite',
      version: '1',
      inputs: [],
      outputs: [],
      body: [
        randomSource('same-id', ['missing-composite-card']),
        dynamicSink('composite-sink', 'same-id'),
      ],
    }],
    continuations: [{
      id: 'scope-continuation',
      version: '1',
      graph: {
        version: 'rvb-gameplay-modules/v1',
        surface: 'pending',
        body: [
          randomSource('same-id', ['missing-continuation-card']),
          dynamicSink('continuation-sink', 'same-id'),
        ],
      },
    }],
  }

  const dynamic = scanSemanticGraph(graph)
  assert.deepEqual(dynamic.map(item => ({
    graphPath: item.graphPath,
    status: item.resolution.status,
    unknownCandidateIds: item.resolution.unknownCandidateIds,
  })), [
    {
      graphPath: '$.composites.0.body.1',
      status: 'unresolved',
      unknownCandidateIds: ['missing-composite-card'],
    },
    {
      graphPath: '$.continuations.0.graph.body.1',
      status: 'unresolved',
      unknownCandidateIds: ['missing-continuation-card'],
    },
  ])
})

test('semantic dynamic sinks prefer a control body local producer over an outer producer', () => {
  const graph = {
    version: 'rvb-gameplay-modules/v1',
    surface: 'skill',
    body: [
      randomSource('same-id', ['holy-smite']),
      {
        kind: 'if',
        id: 'branch',
        condition: literal(true),
        then: [
          randomSource('same-id', ['missing-local-card']),
          dynamicSink('local-sink', 'same-id'),
        ],
      },
    ],
  }

  const dynamic = scanSemanticGraph(graph)
  assert.equal(dynamic.length, 1)
  assert.equal(dynamic[0].graphPath, '$.body.1.then.1')
  assert.equal(dynamic[0].resolution.status, 'unresolved')
  assert.deepEqual(dynamic[0].resolution.unknownCandidateIds, ['missing-local-card'])
  assert.equal(dynamic[0].resolution.candidateIds, undefined)
})
