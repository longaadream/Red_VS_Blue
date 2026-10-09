/* eslint-disable @typescript-eslint/no-explicit-any -- legacy content is intentionally data-shaped. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applyContentGraph, assertContentGraphArtifact } from '@/electron-editor/content-graph-document'
import { importContentGraph } from '@/electron-editor/content-graph-import'
import { compileContentGraph } from '@/electron-editor/content-graph'
import { buildRafaamCurseCardGraph } from '@/scripts/migrate-generated-content-graphs'
import {
  executeCardFunction,
  loadRuleById,
  type CardDefinition,
} from '@/lib/game/skills'
import {
  createRuleExecutionContext,
  RuleRuntime,
  withRuleExecutionContext,
  withRuleRuntime,
} from '@/lib/game/rule-runtime'
import { TriggerSystem, type TriggerRule } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>

type LegacyFixture = {
  readonly entries: Record<string, JsonRecord>
}

type CardCandidate = {
  readonly id: string
  readonly legacy: CardDefinition
  readonly graph: CardDefinition
}

type RuleCandidate = {
  readonly id: string
  readonly legacy: JsonRecord
  readonly graph: JsonRecord
}

type SnapshotContext = {
  readonly seen: WeakMap<object, number>
  nextId: number
}

type CardVariant = 'none' | 'enemy' | 'ally' | 'cell'

const FIXTURE_PATH = resolve(
  process.cwd(),
  'tests/game/fixtures/RED-252-legacy-content.json',
)
const ROOT_SEED = 0x2520_252

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as LegacyFixture

// This one generated card family is independently executed (including missing
// source and copies) in content-graph-generated-cards.test.ts. Normalize only
// its exact frozen source / independently compiled child source pair; all other
// code strings remain part of the full-state comparison.
const generatedSourceIdentity = new Map<string,string>()
const frozenWardGraph = importContentGraph(fixture.entries['rules/rule-rafaam-curse-ward'].skillCode,'rule')
function findFrozenCardSource(value:unknown):string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(findFrozenCardSource)
  const record = value as JsonRecord
  const found = record.key === 'code' && record.value?.kind === 'literal' && typeof record.value.value === 'string' ? [record.value.value] : []
  return [...found,...Object.values(record).flatMap(findFrozenCardSource)]
}
const frozenCardSources = findFrozenCardSource(frozenWardGraph)
if (frozenCardSources.length !== 1) throw new Error('Expected exactly one frozen Rafaam generated card source')
for (const source of [frozenCardSources[0],compileContentGraph(buildRafaamCurseCardGraph()).code]) generatedSourceIdentity.set(source,'RED-252:verified-rafaam-child-source')

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function graphCandidate(
  definition: JsonRecord,
  surface: 'card' | 'rule',
  field: 'code' | 'skillCode',
): JsonRecord | undefined {
  if (typeof definition[field] !== 'string' || definition[field].length === 0) return undefined
  const group = surface === 'card' ? 'cards' : 'rules'
  const production = JSON.parse(readFileSync(resolve(process.cwd(), 'data', group, `${definition.id}.json`), 'utf8'))
  if (production.contentGraphField === field || production.gameplayModules?.entries?.[field]) {
    assertContentGraphArtifact(production)
    return production
  }
  try {
    const graph = importContentGraph(definition[field], surface)
    return applyContentGraph(cloneJson(definition), graph, field) as JsonRecord
  } catch {
    // Unsupported syntax is deliberately outside this corpus. The audit and
    // migration tests record those entries as unresolved rather than silently
    // treating the old source as a migrated artifact.
    return undefined
  }
}

function buildCandidates(): {
  readonly cards: CardCandidate[]
  readonly rules: RuleCandidate[]
} {
  const cards: CardCandidate[] = []
  const rules: RuleCandidate[] = []

  for (const [key, definition] of Object.entries(fixture.entries).sort(([left], [right]) => left.localeCompare(right))) {
    const separator = key.indexOf('/')
    if (separator < 0) continue
    const kind = key.slice(0, separator)
    const id = key.slice(separator + 1)
    if (kind === 'cards') {
      const graph = graphCandidate(definition, 'card', 'code')
      if (graph) cards.push({
        id,
        legacy: cloneJson(definition) as CardDefinition,
        graph: graph as CardDefinition,
      })
    } else if (kind === 'rules') {
      const graph = graphCandidate(definition, 'rule', 'skillCode')
      if (graph) rules.push({
        id,
        legacy: cloneJson(definition),
        graph,
      })
    }
  }

  return { cards, rules }
}

const candidates = buildCandidates()

/**
 * Preserve every enumerable state field, including cycles and functions. A
 * function is represented by its exact source because separately loaded rule
 * instances do not share object identity. No gameplay field is filtered or
 * canonicalized here.
 */
function snapshotValue(value: unknown, context: SnapshotContext = {
  seen: new WeakMap<object, number>(),
  nextId: 0,
}): unknown {
  if (typeof value === 'function') return { functionSource: String(value) }
  if (value === null || typeof value !== 'object') return value

  const object = value as object
  const existingId = context.seen.get(object)
  if (existingId !== undefined) return { reference: existingId }

  const id = context.nextId++
  context.seen.set(object, id)
  if (Array.isArray(value)) {
    return {
      id,
      array: value.map(item => snapshotValue(item, context)),
    }
  }

  const result: JsonRecord = { id }
  for (const [key, nested] of Object.entries(value)) {
    result[key] = key === 'code' && typeof nested === 'string' && generatedSourceIdentity.has(nested)
      ? generatedSourceIdentity.get(nested)
      : snapshotValue(nested, context)
  }
  return result
}

function captureError(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return snapshotValue(error)
}

function namedPiece(overrides: Parameters<typeof makePiece>[0]): any {
  const piece = makePiece(overrides) as any
  piece.name = piece.name || piece.instanceId
  return piece
}

function cardInput(card: CardDefinition, variant: CardVariant): {
  readonly battle: any
  readonly context: JsonRecord
  readonly cardInstance: JsonRecord
  readonly target?: any
  readonly targetPosition?: { x: number; y: number }
} {
  const caster = namedPiece({
    instanceId: 'card-caster',
    templateId: 'test-caster',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 2,
    currentHp: 8,
    maxHp: 12,
    attack: 7,
    actionPoints: 10,
    maxActionPoints: 10,
  })
  const enemy = namedPiece({
    instanceId: 'card-enemy',
    templateId: 'test-enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 3,
    y: 2,
    currentHp: 9,
    maxHp: 12,
    attack: 4,
  })
  const ally = namedPiece({
    instanceId: 'card-ally',
    templateId: 'test-ally',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 3,
    currentHp: 5,
    maxHp: 12,
    attack: 5,
  })
  const watcher = namedPiece({
    instanceId: 'card-watcher',
    templateId: 'blue-watcher',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 1,
    y: 2,
    currentHp: 10,
    maxHp: 12,
    attack: 6,
  })
  const hashirama = namedPiece({
    instanceId: 'card-hashirama',
    templateId: 'hashirama-edo',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 1,
    y: 3,
    currentHp: 6,
    maxHp: 12,
    attack: 5,
  })
  const battle = makeState({
    pieces: [caster, enemy, ally, watcher, hashirama],
    currentPlayerId: 'player-red',
    width: 7,
    height: 7,
  }) as any
  battle.players[0].actionPoints = 10
  battle.players[0].maxActionPoints = 10

  const cardInstance = {
    cardId: card.id,
    instanceId: `card-instance-${card.id}`,
    effectModifiers: [],
  }
  battle.players[0].hand = [cardInstance]

  const target = variant === 'enemy' ? enemy : variant === 'ally' ? ally : undefined
  const targetPosition = variant === 'cell' ? { x: 5, y: 5 } : undefined
  const context: JsonRecord = {
    piece: caster,
    sourcePiece: caster,
    targetPiece: target,
    target,
    targetPosition,
    playerId: 'player-red',
    cardId: card.id,
    damage: 4,
    heal: 3,
    statusId: 'test-status',
    statusType: 'test-status',
    statuses: caster.statusTags,
    battle,
  }
  return { battle, context, cardInstance, target, targetPosition }
}

function runCard(card: CardDefinition, variant: CardVariant): unknown {
  const input = cardInput(card, variant)
  const runtime = new RuleRuntime({ rootSeed: ROOT_SEED })
  const triggerSystem = new TriggerSystem()
  let result: unknown
  let error: unknown

  try {
    result = withRuleExecutionContext(
      createRuleExecutionContext(triggerSystem),
      () => withRuleRuntime(runtime, () => executeCardFunction(
        card,
        'player-red',
        input.battle,
        input.context,
        input.target,
        input.targetPosition,
        undefined,
        [],
        input.cardInstance,
      )),
    )
  } catch (cause) {
    error = captureError(cause)
  }

  return snapshotValue({
    result,
    error,
    battle: input.battle,
    context: input.context,
    triggerRules: triggerSystem.getRules(),
    random: runtime.snapshot(),
  })
}

function loadRuleFromTemporaryProfile(
  definition: JsonRecord,
  id: string,
): TriggerRule {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-card-rule-corpus-'))
  const rulesDirectory = join(root, 'data', 'rules')
  mkdirSync(rulesDirectory, { recursive: true })
  writeFileSync(
    join(rulesDirectory, `${id}.json`),
    JSON.stringify({ ...cloneJson(definition), id }),
    'utf8',
  )

  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  try {
    const loaded = loadRuleById(id, true, true)
    if (!loaded || typeof loaded.effect !== 'function') {
      throw new Error(`RED-252 rule corpus fixture did not compile: ${id}`)
    }
    return loaded
  } finally {
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function ruleInput(rule: TriggerRule, variant: number): {
  readonly battle: any
  readonly context: JsonRecord
  readonly queues: JsonRecord
} {
  const source = namedPiece({
    instanceId: 'rule-source',
    templateId: 'test-source',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 2,
    currentHp: variant === 2 ? 3 : 9,
    maxHp: 12,
    attack: 6,
  })
  const enemy = namedPiece({
    instanceId: 'rule-enemy',
    templateId: 'test-enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 3,
    y: 2,
    currentHp: 8,
    maxHp: 12,
    attack: 4,
    statusTags: [
      { id: 'divine-shield', type: 'divine-shield', intensity: 1, stacks: 1, currentDuration: -1, currentUses: -1 },
    ],
  })
  const ally = namedPiece({
    instanceId: 'rule-ally',
    templateId: 'test-ally',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 3,
    currentHp: 5,
    maxHp: 12,
    attack: 5,
  })
  source.statusTags = [
    { id: 'damage-buff', type: 'damage-buff', intensity: 2, stacks: 1, currentDuration: -1, currentUses: 1 },
    { id: 'test-status', type: 'test-status', intensity: 1, stacks: 1, currentDuration: -1, currentUses: -1 },
  ]
  const battle = makeState({
    pieces: [source, enemy, ally],
    currentPlayerId: variant === 1 ? 'player-blue' : 'player-red',
    turnNumber: variant + 1,
    width: 7,
    height: 7,
  }) as any
  battle.players[0].actionPoints = 8
  battle.players[1].actionPoints = 8
  battle.players[0].hand = [{ cardId: 'soul-fragment', instanceId: 'rule-card-red' }]
  battle.players[1].hand = [{ cardId: 'soul-fragment', instanceId: 'rule-card-blue' }]

  const queueValues = {
    damage: [],
    heal: [],
    damageRedirect: [],
  } as JsonRecord
  const queues = {
    damage: {
      push: (value: unknown) => {
        queueValues.damage.push(value)
        return true
      },
    },
    heal: {
      push: (value: unknown) => {
        queueValues.heal.push(value)
        return true
      },
    },
    damageRedirect: {
      push: (value: unknown) => {
        queueValues.damageRedirect.push(value)
        return true
      },
    },
  }
  const sourcePiece = variant === 1 ? enemy : variant === 2 ? ally : source
  const targetPiece = variant === 2 ? ally : enemy
  const player = battle.players.find((entry: any) => entry.playerId === (variant === 1 ? 'player-blue' : 'player-red'))
  const context: JsonRecord = {
    type: rule.trigger.type,
    sourcePiece,
    targetPiece,
    rulePiece: source,
    piece: sourcePiece,
    player,
    playerId: player.playerId,
    triggerPlayerId: player.playerId,
    ruleOwnerPlayerId: source.ownerPlayerId,
    targetPieceId: targetPiece.instanceId,
    targetPosition: { x: targetPiece.x, y: targetPiece.y },
    targetX: targetPiece.x,
    targetY: targetPiece.y,
    turnNumber: battle.turn.turnNumber,
    damage: variant === 0 ? 7 : variant === 1 ? 3 : 9,
    heal: variant === 0 ? 2 : variant === 1 ? 5 : 4,
    damageType: 'true',
    rawDamage: variant === 0 ? 7 : variant === 1 ? 3 : 9,
    modifiedDamage: variant === 0 ? 7 : variant === 1 ? 3 : 9,
    statusId: variant === 1 ? 'divine-shield' : 'test-status',
    statusType: variant === 1 ? 'divine-shield' : 'test-status',
    statuses: source.statusTags,
    targets: [{ info: targetPiece, pos: { x: targetPiece.x, y: targetPiece.y } }],
    battle,
    damageQueue: queues.damage,
    healQueue: queues.heal,
    damageRedirectQueue: queues.damageRedirect,
  }
  return { battle, context, queues: queueValues }
}

function runRule(
  definition: JsonRecord,
  id: string,
  variant: number,
): unknown {
  const rule = loadRuleFromTemporaryProfile(definition, id)
  const input = ruleInput(rule, variant)
  const runtime = new RuleRuntime({ rootSeed: ROOT_SEED })
  const triggerSystem = new TriggerSystem()

  // Route the event through TriggerSystem while keeping the loaded effect out
  // of battle state. The wrapper is identical on both sides; the invoked
  // effect is still the function produced by the real loader above.
  const dispatchRule: TriggerRule = {
    ...rule,
    effect: (battle, context) => rule.effect(battle, context),
  }
  triggerSystem.addRule(dispatchRule)

  let result: unknown
  let error: unknown
  try {
    result = withRuleExecutionContext(
      createRuleExecutionContext(triggerSystem, {
        ruleResolver: (_battle, requestedId) => requestedId === id ? dispatchRule : null,
      }),
      () => withRuleRuntime(runtime, () => triggerSystem.checkTriggers(input.battle, input.context as any)),
    )
  } catch (cause) {
    error = captureError(cause)
  }

  return snapshotValue({
    result,
    error,
    battle: input.battle,
    context: input.context,
    queues: input.queues,
    triggerRules: triggerSystem.getRules(),
    random: runtime.snapshot(),
  })
}

afterEach(() => {
  delete process.env.RVB_PROFILE_ROOT
})

describe('RED-252 card and rule content graph corpus', () => {
  // Equal rejection or empty effects prove parity for that input only. The
  // corpus deliberately exercises every selected input and does not promote
  // an empty result into whole-definition migration acceptance.
  it('has importable card and rule entries in the frozen fixture', () => {
    expect(candidates.cards.length).toBeGreaterThan(0)
    expect(candidates.rules.length).toBeGreaterThan(0)
  })

  for (const candidate of candidates.cards) {
    it(`card ${candidate.id} preserves all target input paths`, () => {
      for (const variant of ['none', 'enemy', 'ally', 'cell'] as const) {
        expect(
          runCard(candidate.legacy, variant),
          `${candidate.id} legacy input ${variant}`,
        ).toEqual(runCard(candidate.graph, variant))
      }
    })
  }

  for (const candidate of candidates.rules) {
    it(`rule ${candidate.id} preserves common trigger contexts`, () => {
      for (let variant = 0; variant < 3; variant += 1) {
        expect(
          runRule(candidate.legacy, candidate.id, variant),
          `${candidate.id} legacy context ${variant}`,
        ).toEqual(runRule(candidate.graph, candidate.id, variant))
      }
    })
  }
})
