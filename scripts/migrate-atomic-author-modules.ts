/** Full production author migration; legacy adapters remain available for external resources. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildCoverageReport } from './audit-content-graph-coverage.mjs'
import { rewriteAtomicGraph } from '../lib/skill-graph/atomic-graph-rewrite'
import { atomicOptionChoiceRecipe } from '../lib/skill-graph/atomic-migration-option-choices'
import { atomicCardWriteRecipe } from '../lib/skill-graph/atomic-migration-card-writes'
import { atomicFieldRecipe } from '../lib/skill-graph/atomic-migration-fields'
import { atomicFieldWriteRecipe } from '../lib/skill-graph/atomic-migration-field-writes'
import { atomicPredicateRecipe } from '../lib/skill-graph/atomic-migration-predicates'
import { createRelationMigrationRecipe } from '../lib/skill-graph/atomic-migration-relations'
import { atomicValuesRecipe } from '../lib/skill-graph/atomic-migration-values'
import { migrateAuthorGuards } from '../lib/skill-graph/atomic-migration-guards'
import { atomicPresenceRecipe } from '../lib/skill-graph/atomic-migration-presence'
import { atomicCapturedFieldRecipe } from '../lib/skill-graph/atomic-migration-captured-fields'
import { atomicCapturedEffectRecipe } from '../lib/skill-graph/atomic-migration-captured-effects'
import { atomicCapturedSummonRecipe } from '../lib/skill-graph/atomic-migration-captured-summon'
import { atomicMiscValuesRecipe } from '../lib/skill-graph/atomic-migration-misc-values'
import { atomicMovementRecipe } from '../lib/skill-graph/atomic-migration-movement'
import { atomicScopedFieldRecipe } from '../lib/skill-graph/atomic-migration-scoped-fields'
import { atomicContextFieldRecipe } from '../lib/skill-graph/atomic-migration-context-fields'
import { atomicStatusFieldsRecipe } from '../lib/skill-graph/atomic-migration-status-fields'
import { atomicPreviewFieldRecipe } from '../lib/skill-graph/atomic-migration-preview-fields'
import { atomicCollectionAliasRecipe } from '../lib/skill-graph/atomic-migration-collection-aliases'
import { atomicRemainingPredicatesRecipe as atomicRemainingPredicateRecipe } from '../lib/skill-graph/atomic-migration-remaining-predicates'
import { atomicHandQueryRecipe } from '../lib/skill-graph/atomic-migration-hand-queries'
import { atomicStorageWriteRecipe } from '../lib/skill-graph/atomic-migration-storage-writes'
import { atomicExtensionQueryRecipe } from '../lib/skill-graph/atomic-migration-extension-queries'
import { atomicUniqueSummonRecipe } from '../lib/skill-graph/atomic-migration-unique-summon'
import { atomicAbilityWriteRecipe } from '../lib/skill-graph/atomic-migration-ability-writes'
import { atomicFormationRecipe } from '../lib/skill-graph/atomic-migration-formation'
import { atomicActionHistoryRecipe } from '../lib/skill-graph/atomic-migration-action-history'
import { atomicCardReadRecipe } from '../lib/skill-graph/atomic-migration-card-reads'
import { atomicSkillDefinitionFieldRecipe } from '../lib/skill-graph/atomic-migration-skill-definition-fields'
import { atomicStorageReadRecipe } from '../lib/skill-graph/atomic-migration-storage-reads'
import { atomicSpatialQueryRecipe } from '../lib/skill-graph/atomic-migration-spatial-queries'
import { atomicRawStatusRemovalRecipe } from '../lib/skill-graph/atomic-migration-raw-status-removal'
import { atomicMarkerWritesRecipe } from '../lib/skill-graph/atomic-migration-marker-writes'
import { atomicCapturedCollectionRecipe } from '../lib/skill-graph/atomic-migration-captured-collections'
import { atomicFlightStatusRecipe } from '../lib/skill-graph/atomic-migration-flight-status'
import { atomicProjectileQueryRecipe, repairProjectileBlockerBranches } from '../lib/skill-graph/atomic-migration-projectile-queries'
import { atomicMessageBufferRecipe } from '../lib/skill-graph/atomic-migration-message-buffer'
import { atomicIchigoExtensionRecipe } from '../lib/skill-graph/atomic-migration-ichigo-extension'
import { atomicExtensionWriteRecipe } from '../lib/skill-graph/atomic-migration-extension-writes'
import { atomicQueryCompositionRecipe } from '../lib/skill-graph/atomic-migration-query-compositions'
import { atomicFollowupCompositionRecipe, migrateFollowupCompositionModules } from '../lib/skill-graph/atomic-migration-followup-compositions'
import { atomicPlayerBuffExtensionRecipe } from '../lib/skill-graph/atomic-migration-player-buff-extension'
import { atomicStatusChoiceRecipe } from '../lib/skill-graph/atomic-migration-status-choice'
import { atomicStructuredActionLogRecipe } from '../lib/skill-graph/atomic-migration-structured-action-log'
import { migrateRemainingAuthoringModules } from '../lib/skill-graph/atomic-migration-remaining-authoring'
import { atomicLocalAliasRecipe, migrateAtomicTextListGraph } from '../lib/skill-graph/atomic-migration-local-aliases'
import { atomicSkillOwnerRecipe } from '../lib/skill-graph/atomic-migration-skill-owner'
import { atomicDamageAttributionRecipe } from '../lib/skill-graph/atomic-migration-damage-attribution'
import { atomicDelayedDamageRecipe, captureBlackCoffinPlayer } from '../lib/skill-graph/atomic-migration-delayed-damage'
import { repairStorageExpansion } from '../lib/skill-graph/repair-storage-expansion'
import { repairStatusGuardResult } from '../lib/skill-graph/repair-status-guard-result'
import { repairEventConditionGates } from '../lib/skill-graph/repair-event-condition-gates'
import { RETIRED_AUTHOR_MODULES } from '../lib/skill-graph/author-module-catalog'
import { applyGameplayModuleGraph, assertGameplayModuleDocument, GAMEPLAY_MODULE_COMPILER_VERSION, type GameplayModuleGraph } from '../lib/skill-graph/module-document'

export function migrateAtomicAuthorGraph(graph: GameplayModuleGraph): GameplayModuleGraph {
  let current = migrateRemainingAuthoringModules(migrateAuthorGuards(repairStatusGuardResult(repairStorageExpansion(captureBlackCoffinPlayer(graph)))).graph)
  // The follow-up status composition also normalizes legacy typed record.get
  // statements through the graph schema. Run that graph-level pass before the
  // per-call migration chain so production documents receive the same safe
  // record reads as the standalone recipe tests.
  current = migrateAtomicTextListGraph(migrateFollowupCompositionModules(current))
  const relation = createRelationMigrationRecipe()
  // Later passes consume primitive aliases introduced by an earlier recipe.
  // Every recipe removes its source construct; reaching the cap is an error.
  for (let pass = 0; pass < 8; pass++) {
    const next = rewriteAtomicGraph(current, (node, fresh, scope) => atomicProjectileQueryRecipe(node, fresh) ?? atomicFlightStatusRecipe(node, fresh) ?? atomicCapturedCollectionRecipe(node, fresh) ?? atomicRawStatusRemovalRecipe(node, fresh) ?? atomicMarkerWritesRecipe(node, fresh) ?? atomicSpatialQueryRecipe(node, fresh) ?? atomicStorageReadRecipe(node, fresh) ?? atomicCardReadRecipe(node, fresh) ?? atomicSkillDefinitionFieldRecipe(node, fresh) ?? atomicActionHistoryRecipe(node, fresh) ?? atomicAbilityWriteRecipe(node, fresh) ?? atomicFieldWriteRecipe(node, fresh) ?? atomicFormationRecipe(node, fresh) ?? atomicExtensionQueryRecipe(node, fresh) ?? atomicUniqueSummonRecipe(node, fresh) ?? atomicQueryCompositionRecipe(node, fresh, scope) ?? atomicFollowupCompositionRecipe(node, fresh) ?? atomicStructuredActionLogRecipe(node, fresh, scope) ?? atomicStatusChoiceRecipe(node, fresh) ?? atomicPlayerBuffExtensionRecipe(node, fresh) ?? relation(node, fresh)
      ?? atomicLocalAliasRecipe(node, fresh) ?? atomicSkillOwnerRecipe(node, fresh) ?? atomicDamageAttributionRecipe(node, fresh) ?? atomicCapturedEffectRecipe(node, fresh) ?? atomicCapturedSummonRecipe(node, fresh) ?? atomicCardWriteRecipe(node, fresh) ?? atomicOptionChoiceRecipe(node, fresh) ?? atomicDelayedDamageRecipe(node, fresh, scope) ?? atomicMessageBufferRecipe(node, fresh, scope) ?? atomicIchigoExtensionRecipe(node, fresh) ?? atomicExtensionWriteRecipe(node, fresh) ?? atomicStorageWriteRecipe(node, fresh, scope) ?? atomicHandQueryRecipe(node, fresh) ?? atomicRemainingPredicateRecipe(node, fresh) ?? atomicCollectionAliasRecipe(node, fresh) ?? atomicPresenceRecipe(node, fresh) ?? atomicPredicateRecipe(node, fresh) ?? atomicPreviewFieldRecipe(node, fresh) ?? atomicContextFieldRecipe(node, fresh) ?? atomicStatusFieldsRecipe(node, fresh) ?? atomicMiscValuesRecipe(node, fresh) ?? atomicMovementRecipe(node, fresh) ?? atomicScopedFieldRecipe(node, fresh) ?? atomicCapturedFieldRecipe(node, fresh) ?? atomicFieldRecipe(node, fresh) ?? atomicValuesRecipe(node, fresh))
    if (isDeepStrictEqual(next, current)) return migrateRemainingAuthoringModules(migrateFollowupCompositionModules(repairEventConditionGates(repairProjectileBlockerBranches(current))))
    current = next
  }
  throw new Error('atomic migration did not converge')
}

export function migrateAtomicAuthorDocuments(root: string, write = false, ordinaryNodes?: ReadonlySet<string>) {
  let entries = 0, changedEntries = 0, rewrittenGraphs = 0, documents = 0
  const changes: Array<{ file: string; value: string; entries: string[] }> = []
  const errors: Array<{ file: string; error: string }> = []
  const guards: Array<{ file: string; entry: string; report: ReturnType<typeof migrateAuthorGuards>['report'] }> = []
  const generated = new Set(['gameplayModules', 'cluster', 'contentGraph', 'contentGraphField', 'contentGraphCompilerVersion', 'contentGraphEntries'])
  for (const group of ['pieces', 'skills', 'rules', 'cards']) {
    const directory = path.join(root, 'data', group)
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'manifest.json').sort()) {
      const file = path.join(directory, name), relative = path.relative(root, file).split(path.sep).join('/')
      const original = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (ordinaryNodes && !ordinaryNodes.has(`${group}/${original.id ?? name.slice(0, -5)}`)) continue
      if (!original.gameplayModules?.entries) continue
      documents++
      try {
        assertGameplayModuleDocument(original)
        let next = original
        const touched: string[] = []
        for (const [field, entry] of Object.entries(original.gameplayModules.entries) as Array<[string, { graph: GameplayModuleGraph; compilerVersion: string }]>) {
          entries++
          const guardReport = migrateAuthorGuards(entry.graph).report
          if (guardReport.scannedGuardCalls) guards.push({ file: relative, entry: field, report: guardReport })
          const graph = migrateAtomicAuthorGraph(entry.graph)
          const checkRetired = (value: unknown): void => {
            if (!value || typeof value !== 'object') return
            if (Array.isArray(value)) { value.forEach(checkRetired); return }
            const record = value as Record<string, unknown>
            if (record.kind === 'literal') return
            if (record.kind === 'call' && typeof record.module === 'string' && RETIRED_AUTHOR_MODULES.has(record.module)) throw new Error('unmigrated retired helper: ' + record.module)
            Object.values(record).forEach(checkRetired)
          }
          checkRetired(graph)
          const unchangedGraph = isDeepStrictEqual(graph, entry.graph)
          if (unchangedGraph && entry.compilerVersion === GAMEPLAY_MODULE_COMPILER_VERSION) continue
          if (!unchangedGraph) rewrittenGraphs++
          next = applyGameplayModuleGraph(next, graph, field)
          touched.push(field); changedEntries++
        }
        if (!touched.length) continue
        for (const key of new Set([...Object.keys(original), ...Object.keys(next)])) {
          if (generated.has(key) || Object.hasOwn(original.gameplayModules.entries, key)) continue
          if (!isDeepStrictEqual(original[key], next[key])) throw new Error('migration changed non-generated field: ' + key)
        }
        assertGameplayModuleDocument(next)
        changes.push({ file, value: JSON.stringify(next, null, 2) + '\n', entries: touched })
      } catch (error) { errors.push({ file: relative, error: error instanceof Error ? error.message : String(error) }) }
    }
  }
  // Validate the whole batch before touching even the first content file.
  if (write && errors.length) throw new Error('atomic migration validation failed: ' + JSON.stringify(errors))
  if (write) for (const change of changes) fs.writeFileSync(change.file, change.value, 'utf8')
  return { documents, entries, changedEntries, rewrittenGraphs, changed: changes.map(change => ({ file: path.relative(root, change.file).split(path.sep).join('/'), entries: change.entries })), guards, errors }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))), write = process.argv.includes('--write')
  // Current implementation authorization covers reachable ordinary content.
  // Keep detached and adventure-only definitions byte-for-byte unchanged.
  const coverage = buildCoverageReport({ root })
  const ordinaryNodes = new Set<string>(coverage.nodes
    .filter((node: { scope: string; reachability: { status: string } }) => node.scope === 'ordinary' && node.reachability.status === 'reachable')
    .map((node: { nodeKey: string }) => node.nodeKey))
  const report = { write, scope: 'reachable-ordinary', ...migrateAtomicAuthorDocuments(root, write, ordinaryNodes) }
  const reportPath = path.join(root, 'output', 'atomic-migration-report.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, changed: report.changed.length, guards: { scanned: report.guards.reduce((sum, entry) => sum + entry.report.scannedGuardCalls, 0), removed: report.guards.reduce((sum, entry) => sum + entry.report.changes.length, 0), retained: report.guards.reduce((sum, entry) => sum + entry.report.retained.length, 0) } }, null, 2))
  if (report.errors.length) process.exitCode = 1
}
