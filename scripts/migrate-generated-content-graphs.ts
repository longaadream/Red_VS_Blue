import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { importContentGraph } from '../electron-editor/content-graph-import'
import {
  applyContentGraph,
  assertContentGraphArtifact,
  compileContentGraph,
  CONTENT_GRAPH_COMPILER_VERSION,
  CONTENT_GRAPH_VERSION,
  type ContentGraph,
  type ContentGraphBinaryOperator,
  type ContentGraphCollectionMethod,
  type ContentGraphExpression,
  type ContentGraphNode,
  type ContentGraphPureCall,
  type ContentGraphRegion,
  type ContentGraphRegionNode,
  type ContentGraphSurface,
} from '../electron-editor/content-graph-document'

/**
 * Generated cards are a separate migration family.  The ordinary importer is
 * intentionally not extended here: this module only replaces the proven
 * dynamic source fields with hand-authored, typed card subgraphs.
 */

export const GENERATED_CONTENT_IDS = [
  'rules/rule-rafaam-curse-ward',
  'skills/rafaam-curse-amplify',
  'skills/tails-armor-assembly',
] as const

export type GeneratedContentId = typeof GENERATED_CONTENT_IDS[number]

type JsonRecord = Record<string, unknown>
type FrozenFixture = { entries: Record<string, JsonRecord>; baseSha?: string }

export type GeneratedCardFamily = {
  readonly kind: 'rafaam-curse' | 'tails-armor'
  readonly sourceField: 'customCards.code'
  readonly graph: ContentGraph
  readonly bindingNames: readonly string[]
  readonly generatedIds: readonly string[]
}

export type GeneratedContentMigration = {
  readonly id: GeneratedContentId
  readonly field: 'skillCode' | 'code'
  readonly surface: 'rule' | 'skill'
  readonly legacy: JsonRecord
  readonly graph: ContentGraph
  readonly document: JsonRecord
  readonly families: readonly GeneratedCardFamily[]
  readonly sourceSha256: string
}

export type GeneratedMigrationOptions = {
  /** Frozen fixture entry. Supplying this keeps tests independent of data/. */
  readonly legacy?: JsonRecord
  /** Existing document to update; defaults to data/<id>.json. */
  readonly current?: JsonRecord
  /** Project root used to resolve the fixture and production document. */
  readonly root?: string
}

const GENERATED_ID_SET = new Set<string>(GENERATED_CONTENT_IDS)
const generatedCardIds = [
  'armor-attack-defense',
  'armor-attack-heal',
  'armor-attack-speed',
  'armor-defense-heal',
  'armor-defense-speed',
  'armor-heal-speed',
] as const

const literal = (value: string | number | boolean | null | undefined): ContentGraphExpression => ({ kind: 'literal', value })
const undefinedExpr = (): ContentGraphExpression => ({ kind: 'undefined' })
const ref = (name: string): ContentGraphExpression => ({ kind: 'ref', name })
const get = (object: ContentGraphExpression, key: string): ContentGraphExpression => ({ kind: 'get', object, key })
const index = (object: ContentGraphExpression, value: ContentGraphExpression): ContentGraphExpression => ({ kind: 'index', object, index: value })
const array = (items: ContentGraphExpression[]): ContentGraphExpression => ({ kind: 'array', items })
const object = (entries: Record<string, ContentGraphExpression>): ContentGraphExpression => ({ kind: 'object', entries })
const binary = (op: ContentGraphBinaryOperator, left: ContentGraphExpression, right: ContentGraphExpression): ContentGraphExpression => ({ kind: 'binary', op, left, right })
const unary = (op: '!' | '+' | '-' | '~' | 'typeof', argument: ContentGraphExpression): ContentGraphExpression => ({ kind: 'unary', op, argument })
const pureCall = (callee: ContentGraphPureCall, args: ContentGraphExpression[]): ContentGraphExpression => ({ kind: 'call', callee, args })
const collection = (collectionObject: ContentGraphExpression, method: ContentGraphCollectionMethod, args: ContentGraphExpression[] = []): ContentGraphExpression => ({ kind: 'collection', object: collectionObject, method, args })
const lambda = (parameters: string[], body: ContentGraphExpression): ContentGraphExpression => ({ kind: 'lambda', parameters, body })

const call = (id: string, capability: string, args: ContentGraphExpression[], next: string, result?: string): ContentGraphNode => ({
  id, kind: 'call', capability, args, ...(result ? { result } : {}), next,
}) as ContentGraphNode

const bind = (id: string, name: string, expr: ContentGraphExpression, next: string): ContentGraphNode => ({ id, kind: 'bind', name, expr, next })
const branch = (id: string, condition: ContentGraphExpression, yes: string, no: string): ContentGraphNode => ({ id, kind: 'branch', condition, yes, no })
const set = (id: string, target: { kind: 'get'; object: ContentGraphExpression; key: string } | { kind: 'index'; object: ContentGraphExpression; index: ContentGraphExpression }, value: ContentGraphExpression, next: string): ContentGraphNode => ({ id, kind: 'set', target, operator: '=', value, next })
const returnNode = (id: string, value?: ContentGraphExpression): ContentGraphNode => ({ id, kind: 'return', ...(value === undefined ? {} : { value }) })
const regionEnd = (id: string): ContentGraphRegionNode => ({ id, kind: 'regionEnd' })

function graph(surface: ContentGraphSurface, entry: string, nodes: ContentGraphNode[], metadata?: JsonRecord): ContentGraph {
  return {
    version: CONTENT_GRAPH_VERSION,
    surface,
    entry,
    nodes,
    ...(metadata ? { metadata } : {}),
  }
}

function functionGraph(parameters: string[], body: ContentGraphRegion): ContentGraphExpression {
  return { kind: 'function', parameters, body }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function entryList(expression: ContentGraphExpression): Array<{ key: string; value: ContentGraphExpression }> {
  if (expression.kind !== 'object') throw new Error('generated card definition must be an object expression')
  const objectExpression = expression as Extract<ContentGraphExpression, { kind: 'object' }>
  return Array.isArray(objectExpression.entries)
    ? objectExpression.entries
    : Object.entries(objectExpression.entries).map(([key, value]) => ({ key, value }))
}

function setObjectEntry(expression: ContentGraphExpression, key: string, value: ContentGraphExpression): void {
  const entries = entryList(expression)
  const entry = entries.find(candidate => candidate.key === key)
  if (!entry) throw new Error(`generated card object is missing ${key}`)
  entry.value = value
  const objectExpression = expression as Extract<ContentGraphExpression, { kind: 'object' }>
  if (!Array.isArray(objectExpression.entries)) {
    objectExpression.entries[key] = value
  }
}

function routeTopLevelEdge(node: ContentGraphNode, from: string, to: string): void {
  if ('next' in node && node.next === from) node.next = to
  if (node.kind === 'branch') {
    if (node.yes === from) node.yes = to
    if (node.no === from) node.no = to
  }
}

function addMaterializedCardSource(
  source: ContentGraph,
  targetNodeId: string,
  materializeNodeId: string,
  child: ContentGraph,
  bindings: Record<string, ContentGraphExpression>,
  result: string,
): ContentGraph {
  const next = cloneJson(source)
  const target = next.nodes.find(node => node.id === targetNodeId)
  if (!target || target.kind !== 'set' || target.target.kind !== 'index') throw new Error(`${targetNodeId}: generated card assignment not found`)
  setObjectEntry(target.value, 'code', ref(result))
  for (const node of next.nodes) routeTopLevelEdge(node, targetNodeId, materializeNodeId)
  next.nodes.push({ id: materializeNodeId, kind: 'materializeSource', graph: child, bindings, result, next: targetNodeId })
  return next
}

function addFixedCardSource(source: ContentGraph, targetNodeId: string, child: ContentGraph): ContentGraph {
  const next = cloneJson(source)
  const target = next.nodes.find(node => node.id === targetNodeId)
  if (!target || target.kind !== 'set' || target.target.kind !== 'index') throw new Error(`${targetNodeId}: generated card assignment not found`)
  setObjectEntry(target.value, 'code', { kind: 'source', graph: child })
  return next
}

/** Independent Rafaam curse card effect. It reads only card roots and the
 * materialized card record; it does not close over the creating rule. */
export function buildRafaamCurseCardGraph(): ContentGraph {
  const allies = lambda(['piece'], binary('&&',
    binary('===', get(ref('piece'), 'ownerPlayerId'), ref('playerId')),
    binary('>', get(ref('piece'), 'currentHp'), literal(0)),
  ))
  const sourcePiece = lambda(['piece'], binary('===', get(ref('piece'), 'instanceId'), get(ref('cardData'), 'sourcePieceId')))
  return graph('card', 'start', [
    branch('start', binary('!==', get(ref('context'), 'type'), literal('endTurn')), 'discard', 'turn'),
    returnNode('discard', object({ success: literal(true), message: literal('弃置了诅咒') })),
    branch('turn', binary('!==', get(get(ref('battle'), 'turn'), 'currentPlayerId'), ref('playerId')), 'wrong-player', 'allies'),
    returnNode('wrong-player', object({ success: literal(false) })),
    bind('allies', 'allies', collection(get(ref('battle'), 'pieces'), 'filter', [allies]), 'has-allies'),
    branch('has-allies', binary('===', get(ref('allies'), 'length'), literal(0)), 'no-allies', 'random'),
    returnNode('no-allies', object({ success: literal(true), message: literal('诅咒结算时没有存活的友军目标') })),
    call('random', 'Math.random', [], 'random-index', 'random'),
    bind('random-index', 'randomIndex', pureCall('Math.floor', [binary('*', ref('random'), get(ref('allies'), 'length'))]), 'target'),
    bind('target', 'target', index(ref('allies'), ref('randomIndex')), 'card-data'),
    bind('card-data', 'cardData', binary('&&',
      get(ref('battle'), 'customCards'),
      index(get(ref('battle'), 'customCards'), get(get(ref('context'), 'card'), 'id')),
    ), 'damage'),
    bind('damage', 'damage', {
      kind: 'conditional',
      test: binary('&&', ref('cardData'), binary('!==', get(ref('cardData'), 'damageAmount'), undefinedExpr())),
      consequent: get(ref('cardData'), 'damageAmount'),
      alternate: literal(0),
    }, 'all-pieces'),
    bind('all-pieces', 'allPieces', collection(get(ref('battle'), 'pieces'), 'concat', [binary('||', get(ref('battle'), 'graveyard'), array([]))]), 'source'),
    bind('source', 'source', binary('||',
      collection(ref('allPieces'), 'find', [sourcePiece]),
      ref('target'),
    ), 'deal'),
    call('deal', 'dealDamage', [
      ref('source'), ref('target'), ref('damage'), literal('true'), ref('battle'), literal('curse-end-turn'), literal(true),
    ], 'done', 'result'),
    returnNode('done', object({
      success: literal(true),
      keepInHand: literal(true),
      message: binary('+', binary('+', literal('诅咒对'), get(ref('target'), 'name')), binary('+', binary('+', literal('造成了'), get(ref('result'), 'damage')), literal('点伤害'))),
    })),
  ], { generatedFamily: 'rafaam-curse', sourceField: 'customCards.code' })
}

function armorCallback(): ContentGraphExpression {
  const moduleIs = (value: string): ContentGraphExpression => binary('===', ref('m'), literal(value))
  const statusId = (prefix: string, clock: string): ContentGraphExpression => binary('+', binary('+', binary('+', literal(prefix), get(ref('t'), 'instanceId')), literal('-')), ref(clock))
  const healTag = object({
    id: statusId('periodic-heal-', 'healNow'),
    type: literal('periodic-heal'),
    name: literal('恢复模块'),
    stacks: literal(1),
    relatedRules: array([literal('rule-tails-armor-recovery')]),
  })
  const speedTag = object({
    id: statusId('free-normal-move-every-turn-', 'speedNow'),
    type: literal('free-normal-move-every-turn'),
    name: literal('高速模块'),
    stacks: literal(1),
    relatedRules: array([literal('rule-sonic-free-move')]),
  })
  const body: ContentGraphRegion = {
    entry: 'check-heal',
    end: 'callback-end',
    nodes: [
      branch('check-heal', moduleIs('heal'), 'heal-clock', 'check-attack'),
      call('heal-clock', 'Date.now', [], 'heal-push', 'healNow'),
      call('heal-push', 'array.push', [get(ref('t'), 'statusTags'), healTag], 'heal-rule'),
      call('heal-rule', 'addRuleById', [get(ref('t'), 'instanceId'), literal('rule-tails-armor-recovery')], 'check-attack'),
      branch('check-attack', moduleIs('attack'), 'attack-set', 'check-speed'),
      set('attack-set', { kind: 'get', object: ref('t'), key: 'attack' }, binary('+', binary('||', get(ref('t'), 'attack'), literal(0)), literal(3)), 'check-speed'),
      branch('check-speed', moduleIs('speed'), 'speed-clock', 'check-defense'),
      call('speed-clock', 'Date.now', [], 'speed-push', 'speedNow'),
      call('speed-push', 'array.push', [get(ref('t'), 'statusTags'), speedTag], 'speed-rule'),
      call('speed-rule', 'addRuleById', [get(ref('t'), 'instanceId'), literal('rule-sonic-free-move')], 'check-defense'),
      branch('check-defense', moduleIs('defense'), 'defense-set', 'callback-end'),
      set('defense-set', { kind: 'get', object: ref('t'), key: 'defense' }, binary('+', binary('||', get(ref('t'), 'defense'), literal(0)), literal(2)), 'callback-end'),
      regionEnd('callback-end'),
    ],
  }
  return functionGraph(['m'], body)
}

/** Independent Tails armor card effect. `selected` is the only explicit
 * source binding and is snapshotted by materializeSource at creation time. */
export function buildTailsArmorCardGraph(): ContentGraph {
  return graph('card', 'select', [
    call('select', 'selectTarget', [object({ type: literal('piece'), range: literal(99), filter: literal('ally') })], 'target-check', 't'),
    branch('target-check', binary('||', unary('!', ref('t')), get(ref('t'), 'needsTargetSelection')), 'return-target', 'modules'),
    returnNode('return-target', ref('t')),
    bind('modules', 'ms', collection(collection(ref('selected'), 'join', [literal(',')]), 'split', [literal(',')]), 'init-status'),
    set('init-status', { kind: 'get', object: ref('t'), key: 'statusTags' }, binary('||', get(ref('t'), 'statusTags'), array([])), 'apply-modules'),
    {
      id: 'apply-modules', kind: 'invoke', target: { kind: 'array', object: ref('ms'), method: 'forEach' }, args: [armorCallback()], next: 'done',
    } as ContentGraphNode,
    returnNode('done', object({ success: literal(true), message: literal('获得组合护甲效果') })),
  ], { generatedFamily: 'tails-armor', sourceField: 'customCards.code' })
}

function sourceFor(id: GeneratedContentId, legacy: JsonRecord): { graph: ContentGraph; families: GeneratedCardFamily[] } {
  const field = id.startsWith('rules/') ? 'skillCode' : 'code'
  const source = legacy[field]
  if (typeof source !== 'string' || source.length === 0) throw new Error(`${id}: frozen entry has no ${field}`)
  const imported = importContentGraph(source, id.startsWith('rules/') ? 'rule' : 'skill')
  if (id === 'rules/rule-rafaam-curse-ward') {
    const child = buildRafaamCurseCardGraph()
    const graphWithSource = addFixedCardSource(imported, 'n3', child)
    return {
      graph: graphWithSource,
      families: [{ kind: 'rafaam-curse', sourceField: 'customCards.code', graph: child, bindingNames: [], generatedIds: [] }],
    }
  }
  if (id === 'skills/tails-armor-assembly') {
    const child = buildTailsArmorCardGraph()
    const graphWithSource = addMaterializedCardSource(imported, 'n5', 'generated-card-source', child, {
      selected: ref('selected'),
    }, 'generatedCardSource')
    return {
      graph: graphWithSource,
      families: [{ kind: 'tails-armor', sourceField: 'customCards.code', graph: child, bindingNames: ['selected'], generatedIds: [...generatedCardIds] }],
    }
  }
  // Rafaam's amplifier copies a previously materialized card definition. Its
  // copy is already data-preserving JSON.parse/JSON.stringify control flow;
  // there is no new source string to lift into another child graph.
  return { graph: imported, families: [] }
}

function fixtureAt(root: string): FrozenFixture {
  const filename = path.join(root, 'tests', 'game', 'fixtures', 'RED-252-legacy-content.json')
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as FrozenFixture
}

function defaultRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function parseId(id: string): GeneratedContentId {
  if (!GENERATED_ID_SET.has(id)) throw new Error(`${id}: generated-content migration requires an explicit supported ID`)
  return id as GeneratedContentId
}

function sourceField(id: GeneratedContentId): 'skillCode' | 'code' {
  return id.startsWith('rules/') ? 'skillCode' : 'code'
}

function sourceSurface(id: GeneratedContentId): 'rule' | 'skill' {
  return id.startsWith('rules/') ? 'rule' : 'skill'
}

function readCurrent(root: string, id: GeneratedContentId): JsonRecord {
  const filename = path.join(root, 'data', `${id}.json`)
  return JSON.parse(fs.readFileSync(filename, 'utf8')) as JsonRecord
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Existing graph artifacts are accepted only when they are reproducible from
 * the frozen source.  This keeps a hand-edited `contentGraph` from being
 * silently overwritten by the generated-card migration.
 */
function isRecognizedFrozenArtifact(
  current: JsonRecord,
  legacy: JsonRecord,
  generatedGraph: ContentGraph,
  field: 'skillCode' | 'code',
  surface: 'rule' | 'skill',
): boolean {
  if (!current.contentGraph) return false
  const ordinaryGraph = importContentGraph(String(legacy[field]), surface)
  const candidates = [ordinaryGraph, generatedGraph].map(candidate =>
    applyContentGraph(cloneJson(legacy), candidate, field) as JsonRecord,
  )
  return candidates.some(candidate => (
    sameJson(candidate.contentGraph, current.contentGraph)
    && candidate[field] === current[field]
    && candidate.contentGraphField === current.contentGraphField
    && candidate.contentGraphCompilerVersion === current.contentGraphCompilerVersion
  ))
}

/** Build and validate one generated-card migration without writing files. */
export function buildGeneratedContentMigration(idValue: string, options: GeneratedMigrationOptions = {}): GeneratedContentMigration {
  const id = parseId(idValue)
  const root = options.root ?? defaultRoot()
  const frozen = fixtureAt(root)
  const legacy = cloneJson(options.legacy ?? frozen.entries[id])
  if (!legacy) throw new Error(`${id}: not in frozen RED-252 fixture`)
  const { graph, families } = sourceFor(id, legacy)
  const field = sourceField(id)
  const current = cloneJson(options.current ?? readCurrent(root, id))
  if (!current.contentGraph && JSON.stringify(current[field]) !== JSON.stringify(legacy[field])) {
    throw new Error(`${id}: current ${field} differs from frozen source; inspect before generated migration`)
  }
  if (current.contentGraph && !isRecognizedFrozenArtifact(current, legacy, graph, field, sourceSurface(id))) {
    throw new Error(`${id}: current contentGraph is not a recognized frozen ordinary/generated artifact`)
  }
  const document = applyContentGraph(current, graph, field) as JsonRecord
  assertContentGraphArtifact(document)
  const compiled = compileContentGraph(graph)
  if (document[field] !== compiled.code || document.contentGraphCompilerVersion !== CONTENT_GRAPH_COMPILER_VERSION) {
    throw new Error(`${id}: generated graph artifact did not compile to its stored source`)
  }
  const source = legacy[field]
  if (typeof source !== 'string') throw new Error(`${id}: source hash requires a string field`)
  return {
    id,
    field,
    surface: sourceSurface(id),
    legacy,
    graph,
    document,
    families,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  }
}

export function buildGeneratedContentMigrations(ids: readonly string[] = GENERATED_CONTENT_IDS, options: GeneratedMigrationOptions = {}): GeneratedContentMigration[] {
  return [...new Set(ids)].map(id => buildGeneratedContentMigration(id, options))
}

export function preflightGeneratedContentMigrations(ids: readonly string[] = GENERATED_CONTENT_IDS, options: GeneratedMigrationOptions = {}) {
  const changes = buildGeneratedContentMigrations(ids, options)
  return {
    mode: 'dry-run' as const,
    compilerVersion: CONTENT_GRAPH_COMPILER_VERSION,
    changes: changes.map(change => ({
      id: change.id,
      field: change.field,
      nodes: change.graph.nodes.length,
      sourceSha256: change.sourceSha256,
      generatedFamilies: change.families.map(family => ({
        kind: family.kind,
        bindingNames: [...family.bindingNames],
        generatedIds: [...family.generatedIds],
        childNodes: family.graph.nodes.length,
      })),
    })),
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return !!entry && import.meta.url === pathToFileURL(path.resolve(entry)).href
}

function runCli(): void {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const ids = args.filter(argument => argument !== '--write')
  if (!ids.length || ids.some(id => !GENERATED_ID_SET.has(id))) {
    throw new Error(`Usage: node --import tsx scripts/migrate-generated-content-graphs.ts [--write] ${GENERATED_CONTENT_IDS.join(' ')}`)
  }
  const root = defaultRoot()
  // Build every artifact before writing any file. A failed child validation
  // therefore cannot leave a partially migrated generated-card family.
  const changes = buildGeneratedContentMigrations(ids, { root })
  if (write) {
    for (const change of changes) {
      fs.writeFileSync(path.join(root, 'data', `${change.id}.json`), JSON.stringify(change.document, null, 2) + '\n')
    }
  }
  console.log(JSON.stringify({
    mode: write ? 'written' : 'dry-run',
    compilerVersion: CONTENT_GRAPH_COMPILER_VERSION,
    changes: changes.map(change => ({
      id: change.id,
      field: change.field,
      nodes: change.graph.nodes.length,
      sourceSha256: change.sourceSha256,
      generatedFamilies: change.families.map(family => ({ kind: family.kind, generatedIds: family.generatedIds })),
    })),
  }, null, 2))
}

if (isMainModule()) runCli()
