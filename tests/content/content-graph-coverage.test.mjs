import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  BASE_SHA,
  CONTENT_GRAPH_VERSION,
  GRAPH_COMPILER_VERSION,
  buildCoverageReport,
  canonicalize,
  classifyMigration,
  inspectPendingSourceField,
  inspectRafaamCopySource,
  inspectSourceField,
  inspectTypedSourceGraph,
  loadContentGraphArtifactValidator,
  loadRegisteredGraphProofs,
  registeredGraphProofFor,
  sha256,
} from '../../scripts/audit-content-graph-coverage.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const moduleCore = createRequire(import.meta.url)('../../electron-editor/gameplay-module-core.cjs')

test('module coverage requires a valid registered graph and matching generated source', () => {
  const validator = loadContentGraphArtifactValidator(root)
  const document = moduleCore.applyGameplayModuleGraph({ id: 'semantic-probe' }, moduleCore.createGameplayModuleGraph('skill'))
  const valid = classifyMigration(document, { validator })
  assert.equal(valid.fields.code.graphArtifact, 'semantic-module-validated')
  assert.equal(valid.fields.code.status, 'graph-validated')
  const tampered = classifyMigration({ ...document, code: 'function executeSkill(){}' }, { validator })
  assert.equal(tampered.status, 'graph-unverified')
})

function dynamicByFrom(report, from) {
  const reference = report.dynamicReferences.find(candidate => candidate.from === from)
  assert.ok(reference, `missing dynamic reference for ${from}`)
  return reference
}

test('coverage inventory is deterministic and exposes the dynamic evidence extensions', () => {
  const first = buildCoverageReport({ root })
  const second = buildCoverageReport({ root })
  assert.deepEqual(first, second)

  assert.equal(first.baseBranch, 'main')
  assert.equal(first.baseSha, BASE_SHA)
  assert.equal(first.contentGraphVersion, CONTENT_GRAPH_VERSION)
  assert.equal(first.graphCompilerVersion, GRAPH_COMPILER_VERSION)
  // Even a fully validated compiler-IR corpus cannot satisfy the author's
  // stronger requirement that every feature expand to registered modules.
  assert.equal(first.assessmentScope, 'compiler-ir-and-behavior-compatibility')
  assert.equal(first.semanticModuleCoverage.status, 'partial')
  assert.equal(first.semanticModuleCoverage.validatedInlineFields, 5)
  assert.equal(first.semanticModuleCoverage.complete, false)
  assert.equal(first.compilerValidator.available, true)
  assert.equal(first.compilerValidator.documentAvailable, true)
  assert.ok(Array.isArray(first.generatedFamilies))
  assert.ok(Array.isArray(first.baselineMissingCandidates))
  assert.equal(first.counts.baselineMissingCandidates, 1)
})

test('manifest scope keeps ordinary and PVE denominators explicit', () => {
  const report = buildCoverageReport({ root })
  assert.deepEqual(report.counts.manifests, { pieces: 53, skills: 183, rules: 122, cards: 76 })
  assert.equal(report.manifests.pieces.ordinaryCount, 45)
  assert.equal(report.manifests.skills.ordinaryCount, 174)
  assert.equal(report.manifests.rules.ordinaryCount, 121)
  assert.equal(report.manifests.cards.ordinaryCount, 16)
  assert.deepEqual(report.manifests.pieces.excludedIds, [
    'pve-abomination', 'pve-arthas', 'pve-ghoul', 'pve-reaper',
    'pve-skeleton', 'pve-stormtrooper', 'pve-wither-skeleton', 'pve-zombie',
  ])
  assert.equal(report.counts.ordinary, 356)
  assert.equal(report.counts.excluded, 78)
  assert.deepEqual(report.counts.sourceKind, { declarative: 136, 'inline-fields': 298 })
  assert.deepEqual(report.counts.ordinarySourceKind, { declarative: 71, 'inline-fields': 285 })
  assert.equal(report.counts.ordinaryReachableNonPiece, 302)
  assert.deepEqual(report.counts.ordinaryReachableNonPieceSourceKind, { declarative: 26, 'inline-fields': 276 })
  assert.equal(report.counts.ordinaryMigration.declarative, 71)
  assert.equal(
    report.counts.ordinaryMigration.legacy
      + report.counts.ordinaryMigration['graph-unverified']
      + report.counts.ordinaryMigration['graph-partial']
      + report.counts.ordinaryMigration['graph-validated'],
    285,
  )
  assert.ok(report.nodes.every(node => node.scope === 'excluded'
    ? node.exclusionReason === 'pve-only'
    : node.scope === 'ordinary'))
})

test('static reachability, unknown references, and dynamic references remain visible', () => {
  const report = buildCoverageReport({ root })
  assert.equal(report.counts.ordinaryReachable, 347)
  assert.deepEqual(report.validation.ordinaryUnreachable, [
    'skills/arthas-howling-blast',
    'skills/blackwidow-toxin-damage',
    'skills/elune-guidance-trigger',
    'skills/elune-protection-trigger',
    'skills/hand-cannon',
    'skills/holy-shield-defense',
    'skills/obito-kamui',
    'skills/reap-heal',
    'skills/venom-corrosion',
  ])
  assert.ok(report.references.some(reference => (
    reference.from === 'pieces/blue-naruto'
      && reference.toGroup === 'skills'
      && reference.toId === 'naruto-rasengan'
  )))
  // A hyphen inside a known ID is not the beginning of another reference.
  assert.ok(report.references.some(reference => reference.from === 'rules/rule-recall-skill' && reference.toId === 'recall-skill-trigger'))
  assert.deepEqual(report.unknownReferences, [])
  assert.deepEqual(report.dynamicReferences.map(reference => reference.from), [
    'rules/rule-rafaam-curse-ward',
    'rules/rule-watcher-form',
    'skills/elune-blessing',
    'skills/initial-draw',
    'skills/rafaam-curse-amplify',
    'skills/tails-armor-assembly',
    'skills/turalyon-expedition-order',
    'skills/watcher-ultimate',
  ])
  assert.equal(report.counts.dynamicResolved, 8)
  assert.equal(report.counts.dynamicUnresolved, 0)
  assert.ok(report.dynamicReferences.every(reference => typeof reference.expression === 'string' && reference.expression.length > 0))
  const dynamicBySource = new Map(report.dynamicReferences.map(reference => [reference.from, reference]))
  assert.deepEqual(dynamicBySource.get('rules/rule-watcher-form').resolution.candidateIds, ['watcher-calm', 'watcher-rage'])
  assert.deepEqual(dynamicBySource.get('skills/elune-blessing').resolution.candidateIds, ['holy-charge', 'holy-heal', 'holy-smite'])
  assert.deepEqual(dynamicBySource.get('skills/initial-draw').resolution.candidateIds, ['sample-reactive-card'])
  assert.deepEqual(dynamicBySource.get('skills/initial-draw').resolution.baselineMissingCandidateIds, ['sample-active-card'])
  assert.deepEqual(dynamicBySource.get('skills/tails-armor-assembly').resolution.generatedCandidateIds, [
    'armor-attack-defense', 'armor-attack-heal', 'armor-attack-speed',
    'armor-defense-heal', 'armor-defense-speed', 'armor-heal-speed',
  ])
  const curseWardResolution = dynamicBySource.get('rules/rule-rafaam-curse-ward').resolution
  assert.equal(curseWardResolution.status, 'resolved-generated-family')
  if (curseWardResolution.sourceProof.kind === 'recognized-normalized-compiler-assignment') {
    assert.equal(curseWardResolution.sourceProof.compilerArtifactValidated, true)
  }
  assert.equal(dynamicBySource.get('skills/rafaam-curse-amplify').resolution.status, 'resolved-with-generated-family')
  assert.ok(report.dynamicReferences.every(reference => /^[a-f0-9]{64}$/.test(reference.resolution.sourceProof.sourceSha256)))
  assert.ok(report.references.some(reference => reference.evidenceKind === 'dynamic-finite-candidate'
    && reference.from === 'skills/initial-draw'
    && reference.toId === 'sample-reactive-card'))
  assert.equal(report.nodes.some(node => node.id === 'sample-active-card'), false)
  assert.equal(report.nodes.some(node => node.id === 'armor-attack-defense'), false)
  assert.deepEqual(report.counts.generatedExecutableStatus, { 'graph-source-validated': 3 })
  assert.deepEqual(report.counts.generatedSourceStatus, {
    'legacy-until-graph-source': 0,
    'graph-source-unverified': 0,
    'graph-source-partial': 0,
    'graph-source-validated': 3,
  })
  assert.deepEqual(report.counts.pendingSourceStatus, {
    'legacy-until-graph-source': 0,
    'graph-source-unverified': 0,
    'graph-source-partial': 0,
    'graph-source-validated': 2,
  })
  assert.equal(report.counts.pendingSourceFields, 2)
  assert.equal(report.counts.pendingSourceOccurrences, 3)
  assert.deepEqual(report.pendingSources.map(source => ({
    from: source.from,
    fieldPath: source.fieldPath,
    candidateCount: source.candidateCount,
    status: source.status,
  })), [
    { from: 'skills/minato-spiral-barrage', fieldPath: 'code', candidateCount: 1, status: 'graph-source-validated' },
    { from: 'skills/turalyon-grand-crusade', fieldPath: 'code', candidateCount: 2, status: 'graph-source-validated' },
  ])
  const generatedByFrom = new Map(report.generatedFamilies.map(family => [family.from, family]))
  assert.equal(generatedByFrom.get('rules/rule-rafaam-curse-ward').generatedSourceStatus, 'graph-source-validated')
  assert.equal(generatedByFrom.get('rules/rule-rafaam-curse-ward').generatedSourceProof.rawExecutableSourceLiterals.length, 0)
  assert.equal(generatedByFrom.get('skills/tails-armor-assembly').generatedSourceProof.materializeSourceCount, 1)
  const copyProof = generatedByFrom.get('skills/rafaam-curse-amplify').generatedSourceProof.copySourceProof
  assert.equal(generatedByFrom.get('skills/rafaam-curse-amplify').generatedSourceStatus, 'graph-source-validated')
  assert.equal(copyProof.status, 'graph-source-validated')
  assert.deepEqual(copyProof.ordinaryCurseIds, ['rafaam-curse-sample'])
  assert.equal(copyProof.graphProof.copyCodeMutation, false)
  assert.equal(copyProof.sources.find(source => source.id === 'rule-rafaam-curse-ward').status, 'graph-source-validated')
  assert.ok(report.pendingSources.every(source => source.sourceBaselineFixture === 'tests/game/fixtures/RED-252-legacy-content.json'))
  assert.equal(report.validation.allDynamicProofsSourceBound, true)
  assert.equal(report.validation.allGeneratedFamiliesSourceBound, true)
  assert.equal(report.validation.allGeneratedSourceProofsActual, true)
  assert.equal(report.validation.allGeneratedSourcesGraphValidated, true)
  assert.equal(report.validation.allPendingSourceProofsActual, true)
  assert.equal(report.validation.allPendingSourcesGraphValidated, true)
  assert.equal(report.validation.baselineMissingCandidatesAreExplicit, true)
})

test('dynamic proofs hash the exact legacy source that produced each candidate set', () => {
  const report = buildCoverageReport({ root })
  const sourceFields = {
    'rules/rule-rafaam-curse-ward': ['rules/rule-rafaam-curse-ward.json', 'skillCode'],
    'rules/rule-watcher-form': ['rules/rule-watcher-form.json', 'skillCode'],
    'skills/elune-blessing': ['skills/elune-blessing.json', 'code'],
    'skills/initial-draw': ['skills/initial-draw.json', 'code'],
    'skills/rafaam-curse-amplify': ['skills/rafaam-curse-amplify.json', 'code'],
    'skills/tails-armor-assembly': ['skills/tails-armor-assembly.json', 'code'],
    'skills/turalyon-expedition-order': ['skills/turalyon-expedition-order.json', 'code'],
    'skills/watcher-ultimate': ['skills/watcher-ultimate.json', 'code'],
  }
  for (const reference of report.dynamicReferences) {
    const [relativePath, field] = sourceFields[reference.from]
    const definition = JSON.parse(fs.readFileSync(path.join(root, 'data', relativePath), 'utf8'))
    assert.equal(reference.resolution.sourceProof.sourceSha256, sha256(definition[field]))
  }
  const initial = dynamicByFrom(report, 'skills/initial-draw')
  const alteredSourceHash = sha256(`${JSON.parse(fs.readFileSync(path.join(root, 'data/skills/initial-draw.json'), 'utf8')).code}\n`)
  assert.notEqual(initial.resolution.sourceProof.sourceSha256, alteredSourceHash)
  assert.ok(report.generatedFamilies.every(family => /^[a-f0-9]{64}$/.test(family.sourceProof.sourceSha256)))
})

test('parity hashes and source classifications are stable', () => {
  const report = buildCoverageReport({ root })
  assert.equal(report.counts.migration.declarative, 136)
  assert.equal(
    report.counts.migration.legacy
      + report.counts.migration['graph-unverified']
      + report.counts.migration['graph-partial']
      + report.counts.migration['graph-validated'],
    298,
  )
  assert.equal(
    report.counts.fieldMigration.legacy
      + report.counts.fieldMigration['graph-unverified']
      + report.counts.fieldMigration['graph-validated'],
    394,
  )
  assert.equal(
    report.counts.ordinaryFieldMigration.legacy
      + report.counts.ordinaryFieldMigration['graph-unverified']
      + report.counts.ordinaryFieldMigration['graph-validated'],
    373,
  )
  assert.equal(report.validation.allOrdinaryEntriesHaveStableHashes, true)
  assert.equal(
    report.validation.allOrdinaryInlineFieldsLegacyUntilValidated,
    report.counts.ordinaryFieldMigration['graph-validated'] === 0,
  )
  assert.equal(report.validation.allOrdinaryEntriesClassifiedBySourceKind, true)
  assert.equal(report.nodes.filter(node => node.scope === 'ordinary' && node.group === 'pieces' && node.migration.status === 'declarative').length, 45)
  assert.equal(report.nodes.filter(node => node.scope === 'ordinary' && node.group !== 'pieces' && node.reachability.status === 'reachable' && node.migration.status === 'declarative').length, 26)
  const expectedGraphEntries = [
    'cards/soul-fragment',
    'rules/rule-reap',
    'skills/ashbringer',
    'skills/blessed-hammer',
    'skills/fireball',
    'skills/ichigo-zangetsu',
    'skills/illidan-eye-beam',
    'skills/light-of-the-light',
    'skills/ulquiorra-black-cero',
    'skills/ulquiorra-cero',
    'skills/venom-claw-rend',
  ]
  const graphEntryKeys = new Set(report.nodes
    .filter(node => node.migration.status === 'graph-partial' || node.migration.status === 'graph-validated')
    .map(node => node.nodeKey))
  assert.ok(expectedGraphEntries.every(nodeKey => graphEntryKeys.has(nodeKey)))
  assert.ok(report.nodes.every(node => Object.values(node.hashes).every(hash => /^[a-f0-9]{64}$/.test(hash))))
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('graph presence without compiler-accepted artifact is not migration', () => {
  const graph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'start',
    nodes: [{ id: 'start', kind: 'return' }],
  }
  assert.equal(classifyMigration({ contentGraph: graph }).status, 'graph-unverified')
  assert.equal(classifyMigration({
    contentGraph: graph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
    code: 'function executeSkill(context) { return; }',
  }).status, 'graph-unverified')
})

test('migration status uses the actual compiler output and rejects tampering', () => {
  const validator = loadContentGraphArtifactValidator(root)
  assert.equal(validator.available, true)
  const graph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'start',
    nodes: [{ id: 'start', kind: 'return' }],
  }
  const compiled = validator.compileContentGraph(graph)
  const artifact = {
    contentGraph: graph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
    code: compiled.code,
  }
  assert.equal(classifyMigration(artifact, { validator }).status, 'graph-validated')
  assert.equal(classifyMigration({ ...artifact, code: `${compiled.code} ` }, { validator }).status, 'graph-unverified')
})

test('a graph artifact validates one inline field and leaves sibling fields legacy', () => {
  const validator = loadContentGraphArtifactValidator(root)
  const graph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'start',
    nodes: [{ id: 'start', kind: 'return' }],
  }
  const compiled = validator.compileContentGraph(graph)
  const classified = classifyMigration({
    contentGraph: graph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
    code: compiled.code,
    previewCode: 'legacy preview source',
  }, { validator })
  assert.equal(classified.sourceKind, 'inline-fields')
  assert.deepEqual(classified.codeFields, ['code', 'previewCode'])
  assert.equal(classified.status, 'graph-partial')
  assert.equal(classified.fields.code.status, 'graph-validated')
  assert.equal(classified.fields.previewCode.status, 'legacy')
  assert.match(classified.fields.previewCode.reason, /contentGraphField targets "code"/)
})

test('the audit validates primary and additional graph entries independently', () => {
  const validator = loadContentGraphArtifactValidator(root)
  const primaryGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'start',
    nodes: [{ id: 'start', kind: 'return' }],
  }
  const previewGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'preview',
    entry: 'start',
    nodes: [{ id: 'start', kind: 'return' }],
  }
  const primaryCode = validator.compileContentGraph(primaryGraph).code
  const previewCode = validator.compileContentGraph(previewGraph).code
  const artifact = {
    contentGraph: primaryGraph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
    code: primaryCode,
    previewCode,
    contentGraphEntries: {
      previewCode: {
        graph: previewGraph,
        compilerVersion: GRAPH_COMPILER_VERSION,
      },
    },
  }
  const classified = classifyMigration(artifact, { validator })
  assert.equal(classified.status, 'graph-validated')
  assert.equal(classified.fields.code.status, 'graph-validated')
  assert.equal(classified.fields.previewCode.status, 'graph-validated')

  const tampered = classifyMigration({ ...artifact, previewCode: `${previewCode} ` }, { validator })
  assert.equal(tampered.status, 'graph-unverified')
  assert.equal(tampered.fields.code.status, 'graph-validated')
  assert.equal(tampered.fields.previewCode.status, 'graph-unverified')

  const duplicate = classifyMigration({
    ...artifact,
    contentGraphEntries: {
      ...artifact.contentGraphEntries,
      code: { graph: primaryGraph, compilerVersion: GRAPH_COMPILER_VERSION },
    },
  }, { validator })
  assert.equal(duplicate.status, 'graph-unverified')
  assert.equal(duplicate.fields.code.status, 'graph-unverified')
})

test('typed generated and pending sources require real child graphs and reject legacy source literals', () => {
  const validator = loadContentGraphArtifactValidator(root)
  const literal = value => ({ kind: 'literal', value })
  const object = entries => ({ kind: 'object', entries: Object.entries(entries).map(([key, value]) => ({ key, value })) })
  const child = (surface = 'card') => ({
    version: CONTENT_GRAPH_VERSION,
    surface,
    entry: 'return',
    nodes: [{ id: 'return', kind: 'return', value: literal('child-source') }],
  })
  const sourceParent = (field, childGraph) => ({
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'return',
    nodes: [{
      id: 'return',
      kind: 'return',
      value: object({ [field]: { kind: 'source', graph: childGraph } }),
    }],
  })
  const materializeParent = childGraph => ({
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'materialize',
    nodes: [
      { id: 'materialize', kind: 'materializeSource', graph: childGraph, bindings: {}, result: 'generatedCode', next: 'return' },
      { id: 'return', kind: 'return', value: object({ code: { kind: 'ref', name: 'generatedCode' } }) },
    ],
  })
  const rawParent = field => ({
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'return',
    nodes: [{
      id: 'return',
      kind: 'return',
      value: object({ [field]: literal('function executeCard(context) { return { success: true }; }') }),
    }],
  })
  const definitionFor = (graph, source) => ({
    id: 'typed-source-fixture',
    code: source ?? validator.compileContentGraph(graph).code,
    contentGraph: graph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
  })

  const typedGraph = sourceParent('code', child('card'))
  const typedDefinition = definitionFor(typedGraph)
  const typedMigration = classifyMigration(typedDefinition, { validator })
  const typedEvidence = inspectSourceField(typedDefinition, 'code', typedMigration)
  assert.equal(typedMigration.fields.code.status, 'graph-validated')
  assert.equal(typedEvidence.status, 'graph-source-unverified')
  assert.match(typedEvidence.reason, /independently rebuilt frozen graph proof/)
  assert.equal(typedEvidence.sourceExpressionCount, 1)
  assert.equal(typedEvidence.materializeSourceCount, 0)
  assert.equal(typedEvidence.rawExecutableSourceLiterals.length, 0)

  const materializedGraph = materializeParent(child('card'))
  const materializedDefinition = definitionFor(materializedGraph)
  const materializedMigration = classifyMigration(materializedDefinition, { validator })
  const materializedEvidence = inspectSourceField(materializedDefinition, 'code', materializedMigration)
  assert.equal(materializedEvidence.status, 'graph-source-unverified')
  assert.equal(materializedEvidence.sourceExpressionCount, 0)
  assert.equal(materializedEvidence.materializeSourceCount, 1)

  const rawGraph = rawParent('code')
  const rawDefinition = definitionFor(rawGraph)
  const rawMigration = classifyMigration(rawDefinition, { validator })
  const rawEvidence = inspectSourceField(rawDefinition, 'code', rawMigration)
  assert.equal(rawMigration.fields.code.status, 'graph-validated')
  assert.equal(rawEvidence.status, 'graph-source-unverified')
  assert.equal(rawEvidence.typedSourceCount, 0)
  assert.equal(rawEvidence.rawExecutableSourceLiterals.length, 1)

  const descriptionGraph = {
    ...rawParent('description'),
  }
  assert.equal(inspectTypedSourceGraph(descriptionGraph).rawExecutableSourceLiterals.length, 0)

  const pendingLegacy = `function executeSkill(context) {
    return { pendingTargetSelection: { effectCode: "function(ctx) { return { success: true }; }" } };
  }`
  const pendingGraph = sourceParent('effectCode', child('pending'))
  const pendingDefinition = definitionFor(pendingGraph, validator.compileContentGraph(pendingGraph).code)
  const pendingMigration = classifyMigration(pendingDefinition, { validator })
  const pendingEvidence = inspectPendingSourceField(pendingDefinition, 'code', pendingLegacy, pendingMigration)
  assert.equal(pendingEvidence.status, 'graph-source-unverified')
  assert.equal(pendingEvidence.candidateCount, 1)
  assert.equal(pendingEvidence.typedSourceCount, 1)

  const rawPendingGraph = rawParent('effectCode')
  const rawPendingDefinition = definitionFor(rawPendingGraph, validator.compileContentGraph(rawPendingGraph).code)
  const rawPendingMigration = classifyMigration(rawPendingDefinition, { validator })
  const rawPendingEvidence = inspectPendingSourceField(rawPendingDefinition, 'code', pendingLegacy, rawPendingMigration)
  assert.equal(rawPendingEvidence.status, 'graph-source-unverified')
  assert.equal(rawPendingEvidence.rawExecutableSourceLiterals.length, 1)
})

test('source proof is rooted at executable sinks and Rafaam copy proof rejects clone-code changes', () => {
  const validator = loadContentGraphArtifactValidator(root)
  const literal = value => ({ kind: 'literal', value })
  const object = entries => ({ kind: 'object', entries: Object.entries(entries).map(([key, value]) => ({ key, value })) })
  const child = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'card',
    entry: 'return',
    nodes: [{ id: 'return', kind: 'return', value: literal('child-source') }],
  }
  const graphWithAliasedLegacyAndUnusedTypedSource = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'legacy',
    nodes: [
      { id: 'legacy', kind: 'bind', name: 'legacy', expr: literal('function executeCard(context) { return 99; }'), next: 'unused' },
      { id: 'unused', kind: 'bind', name: 'unused', expr: { kind: 'source', graph: child }, next: 'return' },
      { id: 'return', kind: 'return', value: object({ code: { kind: 'ref', name: 'legacy' } }) },
    ],
  }
  const aliasedCompiled = validator.compileContentGraph(graphWithAliasedLegacyAndUnusedTypedSource)
  const aliasedDefinition = {
    id: 'sink-proof-fixture',
    code: aliasedCompiled.code,
    contentGraph: graphWithAliasedLegacyAndUnusedTypedSource,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
  }
  const aliasedEvidence = inspectSourceField(aliasedDefinition, 'code', classifyMigration(aliasedDefinition, { validator }))
  assert.notEqual(aliasedEvidence.status, 'graph-source-validated')
  assert.equal(aliasedEvidence.sourceExpressionCount, 0)
  assert.equal(aliasedEvidence.rawExecutableSourceLiterals.length, 1)

  const missingSourceGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'external',
    nodes: [
      { id: 'external', kind: 'bind', name: 'missingSource', expr: literal('external script payload'), next: 'return' },
      { id: 'return', kind: 'return', value: object({ code: { kind: 'ref', name: 'missingSource' } }) },
    ],
  }
  const missingDefinition = {
    id: 'missing-source-fixture',
    code: validator.compileContentGraph(missingSourceGraph).code,
    contentGraph: missingSourceGraph,
    contentGraphField: 'code',
    contentGraphCompilerVersion: GRAPH_COMPILER_VERSION,
  }
  const missingEvidence = inspectSourceField(missingDefinition, 'code', classifyMigration(missingDefinition, { validator }))
  assert.notEqual(missingEvidence.status, 'graph-source-validated')
  assert.equal(missingEvidence.sourceExpressionCount, 0)

  const poisonedBindingGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'source',
    nodes: [
      { id: 'source', kind: 'bind', name: 'source', expr: { kind: 'source', graph: child }, next: 'mutate' },
      { id: 'mutate', kind: 'set', target: { kind: 'ref', name: 'source' }, operator: '+=', value: literal('suffix'), next: 'return' },
      { id: 'return', kind: 'return', value: object({ code: { kind: 'ref', name: 'source' } }) },
    ],
  }
  const poisonedEvidence = inspectTypedSourceGraph(poisonedBindingGraph)
  assert.equal(poisonedEvidence.sourceExpressionCount, 0)
  assert.ok(poisonedEvidence.unresolvedSinkPaths.length > 0)

  const wrappedUnknownSinkGraph = {
    version: CONTENT_GRAPH_VERSION,
    surface: 'skill',
    entry: 'return',
    nodes: [{
      id: 'return',
      kind: 'return',
      value: object({
        code: {
          kind: 'binary',
          op: '+',
          left: { kind: 'source', graph: child },
          right: literal('suffix'),
        },
      }),
    }],
  }
  const wrappedUnknownEvidence = inspectTypedSourceGraph(wrappedUnknownSinkGraph)
  assert.equal(wrappedUnknownEvidence.sourceExpressionCount, 0)
  assert.ok(wrappedUnknownEvidence.unresolvedSinkPaths.length > 0)

  const amplify = JSON.parse(fs.readFileSync(path.join(root, 'data/skills/rafaam-curse-amplify.json'), 'utf8'))
  const amplifyMigration = classifyMigration(amplify, { validator })
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'data/cards/rafaam-curse-sample.json'), 'utf8'))
  const sampleEntry = {
    id: sample.id,
    definition: sample,
    migration: classifyMigration(sample, { validator }),
  }
  const ward = JSON.parse(fs.readFileSync(path.join(root, 'data/rules/rule-rafaam-curse-ward.json'), 'utf8'))
  const wardMigration = classifyMigration(ward, { validator })
  const wardProof = inspectSourceField(ward, 'skillCode', wardMigration, 1, {
    registeredProof: registeredGraphProofFor(
      loadRegisteredGraphProofs(root),
      'rules/rule-rafaam-curse-ward',
      'skillCode',
      ward,
    ),
  })
  const copyOptions = {
    staticSourceEntry: sampleEntry,
    generatedSourceProof: wardProof,
    registeredProof: registeredGraphProofFor(
      loadRegisteredGraphProofs(root),
      'skills/rafaam-curse-amplify',
      'code',
      amplify,
    ),
    ordinaryCurseIds: ['rafaam-curse-sample'],
  }
  assert.equal(inspectRafaamCopySource(amplify, amplifyMigration, copyOptions).status, 'graph-source-validated')
  const tamperedModuleSource = structuredClone(sampleEntry)
  tamperedModuleSource.definition.code = 'function executeCard(){return {success:true}}'
  assert.equal(inspectRafaamCopySource(amplify, amplifyMigration, {
    ...copyOptions, staticSourceEntry: tamperedModuleSource,
  }).status, 'graph-source-unverified', 'copy provenance must revalidate semantic source bytes, not trust a cached classification')

  const graphMetadataMutation = structuredClone(ward)
  graphMetadataMutation.contentGraph.metadata = {
    ...(graphMetadataMutation.contentGraph.metadata ?? {}),
    auditMutation: true,
  }
  const graphMetadataMigration = classifyMigration(graphMetadataMutation, { validator })
  const staleWardProof = inspectSourceField(
    graphMetadataMutation,
    'skillCode',
    graphMetadataMigration,
    1,
    { registeredProof: copyOptions.generatedSourceProof.registeredGraphProof },
  )
  assert.equal(staleWardProof.status, 'graph-source-unverified')
  assert.match(staleWardProof.reason, /registered graph proof/i)

  const cloneCodeLiteral = structuredClone(amplify)
  const cloneCodeSet = cloneCodeLiteral.contentGraph.nodes
    .flatMap(node => node.body?.nodes ?? [])
    .find(node => node.kind === 'set' && node.target?.kind === 'get' && node.target.object?.name === 'copy' && node.target.key === 'id')
  cloneCodeSet.target.key = 'code'
  cloneCodeSet.value = literal('function executeCard(context) { return 99; }')
  const cloneCodeProof = inspectRafaamCopySource(cloneCodeLiteral, amplifyMigration, copyOptions)
  assert.equal(cloneCodeProof.status, 'graph-source-unverified')
  assert.equal(cloneCodeProof.graphProof.copyCodeMutation, true)

  const unknownSource = structuredClone(amplify)
  const customLookup = unknownSource.contentGraph.nodes
    .flatMap(node => node.body?.nodes ?? [])
    .find(node => node.kind === 'bind' && node.name === 'custom')
  customLookup.expr.index = { kind: 'ref', name: 'externalScriptId' }
  const unknownSourceProof = inspectRafaamCopySource(unknownSource, amplifyMigration, copyOptions)
  assert.equal(unknownSourceProof.status, 'graph-source-unverified')
  assert.equal(unknownSourceProof.graphProof.customCardsLookup, false)
})
