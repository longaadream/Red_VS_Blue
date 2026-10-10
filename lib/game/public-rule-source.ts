import type { BattleState } from './turn'
import { getDataRoot } from '@/lib/app-paths'
import type { RuleExecutionContext } from './rule-runtime'
import {
  assertCardDefinition,
  executeSkillFunction,
  loadCardById,
  loadRuleById,
  loadSkillById,
  type CardDefinition,
  type SkillExecutionContext,
  type SkillExecutionResult,
} from './skills'
import {
  createRuleExecutionContext,
  RuleRuntime,
  withRuleExecutionContext,
  withRuleRuntime,
} from './rule-runtime'
import { TriggerSystem } from './triggers'

type JsonRecord = Record<string, unknown>

export interface PublicRuleSourceController {
  readonly ruleResolver: RuleExecutionContext['ruleResolver']
  readonly skillResolver: RuleExecutionContext['skillResolver']
  readonly cardResolver: RuleExecutionContext['cardResolver']
  hasUnsupportedAccess(): boolean
}

export class PublicRuleSourceError extends Error {}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

const ARMOR_SKILL_ID = 'tails-armor-assembly'
const ARMOR_MODULES = ['attack', 'defense', 'heal', 'speed'] as const
const ARMOR_GENERATOR_SEED = 0x41524d52

const PURE_TARGET_RULE_FIELDS = new Set(['currentHp', 'maxHp', 'attack', 'defense', 'moveRange'])
const PURE_TARGET_RULE_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'ne'])
const PURE_TARGET_RULE_KEYS = new Set(['id', 'name', 'description', 'targetValidation'])
const PURE_TARGET_VALIDATION_KEYS = new Set(['type', 'sourceField', 'targetField', 'operator', 'message'])

type ArmorModule = typeof ARMOR_MODULES[number]

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableJson(value[key])]),
  )
}

function hasOnlyKeys(value: JsonRecord, allowed: Set<string>, required: Set<string>): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.has(key))
    && [...required].every(key => Object.prototype.hasOwnProperty.call(value, key))
}

/**
 * Prove a target rule from the canonical resource itself. `loadRuleById`
 * intentionally compiles every rule to an effect function, so its compiled
 * shape alone cannot prove that the source had no executable effect. Read and
 * validate the raw canonical JSON first, then require the normal compiler to
 * accept the same pure declaration.
 */
export function isCanonicalPureTargetValidationRule(ruleId: unknown): ruleId is string {
  if (typeof ruleId !== 'string' || !/^rule-[a-z0-9-]+$/i.test(ruleId)) return false
  let raw: JsonRecord
  try {
    // Keep the same runtime loader path as loadRuleById so browser VFS builds
    // can provide their existing fs/path shims.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as { readFileSync(path: string, encoding: string): string }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as { join(...parts: string[]): string }
    raw = JSON.parse(fs.readFileSync(
      path.join(getDataRoot(), 'rules', `${ruleId}.json`),
      'utf8',
    )) as JsonRecord
  } catch {
    return false
  }

  if (!record(raw)
    || !hasOnlyKeys(raw, PURE_TARGET_RULE_KEYS, new Set(['id', 'name', 'description', 'targetValidation']))) return false
  if (raw.id !== ruleId || typeof raw.name !== 'string' || !raw.name
    || typeof raw.description !== 'string' || !raw.description) return false
  const validation = raw.targetValidation
  if (!record(validation)
    || !hasOnlyKeys(validation, PURE_TARGET_VALIDATION_KEYS, new Set(['type', 'sourceField', 'targetField', 'operator']))
    || validation.type !== 'comparePieceNumber'
    || typeof validation.sourceField !== 'string'
    || typeof validation.targetField !== 'string'
    || !PURE_TARGET_RULE_FIELDS.has(validation.sourceField)
    || !PURE_TARGET_RULE_FIELDS.has(validation.targetField)
    || typeof validation.operator !== 'string'
    || !PURE_TARGET_RULE_OPERATORS.has(validation.operator)
    || (validation.message !== undefined && typeof validation.message !== 'string')) return false

  try {
    const isolated = createRuleExecutionContext(new TriggerSystem())
    const compiled = withRuleExecutionContext(isolated, () => loadRuleById(ruleId, true, true))
    return !!compiled
      && compiled.trigger?.type === 'targetValidation'
      && JSON.stringify(stableJson(compiled.targetValidation)) === JSON.stringify(stableJson(validation))
  } catch {
    return false
  }
}

function armorModulesForCardId(cardId: string): [ArmorModule, ArmorModule] | undefined {
  if (!cardId.startsWith('armor-')) return undefined
  const values = cardId.slice('armor-'.length).split('-')
  if (values.length !== 2 || values[0] === values[1]) return undefined
  if (!values.every(value => (ARMOR_MODULES as readonly string[]).includes(value))) return undefined
  const modules = [...values].sort() as [ArmorModule, ArmorModule]
  return `armor-${modules.join('-')}` === cardId ? modules : undefined
}

function makeArmorGeneratorState(state: BattleState, viewerId: string): {
  battle: BattleState
  piece: SkillExecutionContext['piece']
} {
  const battle = cloneJson(state)
  const source = {
    instanceId: 'preview-armor-generator-source',
    templateId: 'tails',
    name: 'Tails',
    ownerPlayerId: viewerId,
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 1,
    maxHp: 1,
    attack: 1,
    defense: 1,
    moveRange: 1,
    statusTags: [],
    debuffs: [],
    buffs: [],
    skills: [],
    rules: [],
  } as unknown as SkillExecutionContext['piece']
  const owner = battle.players.find(player => normalized(player.playerId) === normalized(viewerId))
  battle.players = [
    {
      ...(owner ?? {
        playerId: viewerId,
        name: viewerId,
        chargePoints: 0,
        actionPoints: 0,
        maxActionPoints: 0,
        discardPile: [],
        hand: [],
      }),
      playerId: viewerId,
      hand: [],
      discardPile: [],
      rules: [],
      statusTags: [],
      skills: [],
    },
  ] as BattleState['players']
  battle.pieces = [source as BattleState['pieces'][number]]
  battle.graveyard = []
  battle.customCards = {}
  battle.actions = []
  battle.extensions = {}
  battle.turn = {
    ...battle.turn,
    currentPlayerId: viewerId,
    phase: 'action',
  }
  return { battle, piece: source }
}

/**
 * Re-run the canonical Armor Assembly skill in a fresh trusted scope. The
 * generated code is the authority's source of truth; this helper only admits
 * a snapshot definition after a full structural comparison with that output.
 */
function generatedArmorCard(
  state: BattleState,
  viewerId: string,
  cardId: string,
): CardDefinition | undefined {
  const selectedOption = armorModulesForCardId(cardId)
  if (!selectedOption) return undefined
  const isolated = makeArmorGeneratorState(state, viewerId)
  const executionContext = createRuleExecutionContext(new TriggerSystem())
  let result: SkillExecutionResult | undefined
  try {
    result = withRuleExecutionContext(executionContext, () => {
      const skill = loadSkillById(ARMOR_SKILL_ID, true)
      if (!skill) return undefined
      const context: SkillExecutionContext = {
        piece: isolated.piece,
        target: null,
        targetPosition: null,
        selectedOption,
        battle: isolated.battle,
        skill: {
          id: skill.id,
          name: skill.name,
          type: skill.type,
          powerMultiplier: skill.powerMultiplier,
          targeting: skill.targeting,
        },
      }
      return withRuleRuntime(
        new RuleRuntime({ rootSeed: ARMOR_GENERATOR_SEED, tick: 0 }),
        () => executeSkillFunction(skill, context, isolated.battle),
      )
    })
  } catch {
    return undefined
  }
  if (!result?.success) return undefined
  const generated = isolated.battle.customCards?.[cardId]
  if (!generated) return undefined
  let expected: CardDefinition
  try {
    expected = assertCardDefinition(cardId, generated)
  } catch {
    return undefined
  }
  return expected
}

function sameCardDefinition(candidate: unknown, expected: CardDefinition): candidate is CardDefinition {
  try {
    const asserted = assertCardDefinition(expected.id, candidate)
    return JSON.stringify(stableJson(asserted)) === JSON.stringify(stableJson(expected))
  } catch {
    return false
  }
}

/**
 * A rule is executable for a preview only when its source is public to this
 * viewer. The rule body is never taken from the snapshot: the ID is resolved
 * through the canonical data loader in a fresh RuleExecutionContext cache.
 */
function publicRuleForHolder(rule: JsonRecord, holder: JsonRecord, viewerId: string): boolean {
  if (rule.public === true || rule.visibility === 'public') return true
  const owner = String(holder.ownerPlayerId ?? holder.playerId ?? '').trim().toLowerCase()
  if (owner === viewerId) return true
  const statuses = Array.isArray(holder.statusTags) ? holder.statusTags : []
  return statuses.some(status => {
    if (!record(status) || status.visible === false) return false
    return Array.isArray(status.relatedRules)
      && status.relatedRules.some(id => String(id) === String(rule.id))
  })
}

function collectRuleIds(state: BattleState, viewerId: string): Set<string> {
  const ids = new Set<string>()
  const holders: JsonRecord[] = [
    ...(state.pieces as unknown as JsonRecord[]),
    ...(state.players as unknown as JsonRecord[]),
  ]
  for (const holder of holders) {
    const rules = Array.isArray(holder.rules) ? holder.rules : []
    for (const raw of rules) {
      if (!record(raw) || typeof raw.id !== 'string' || !raw.id.trim()) {
        throw new PublicRuleSourceError('Public rule ID is missing')
      }
      if (!publicRuleForHolder(raw, holder, viewerId)) {
        // The viewer projection has already removed hidden status evidence;
        // ignore an unproven opponent rule rather than exposing its presence.
        continue
      }
      ids.add(raw.id)
    }
  }
  return ids
}

function ruleIsDeclaredByVisibleStatus(battle: unknown, ruleId: string): boolean {
  if (!record(battle)) return false
  const holders = [
    ...(Array.isArray(battle.pieces) ? battle.pieces : []),
    ...(Array.isArray(battle.players) ? battle.players : []),
  ]
  return holders.some(holder => record(holder)
    && Array.isArray(holder.statusTags)
    && holder.statusTags.some(status => record(status)
      && status.visible !== false
      && Array.isArray(status.relatedRules)
      && status.relatedRules.some(id => String(id) === ruleId)))
}

function ruleSourceIsOwnedByViewer(battle: unknown, metadata: unknown, viewerId: string): boolean {
  if (!record(battle) || !record(metadata) || typeof metadata.sourceId !== 'string') return false
  const holders = [
    ...(Array.isArray(battle.pieces) ? battle.pieces : []),
    ...(Array.isArray(battle.players) ? battle.players : []),
  ]
  return holders.some(holder => record(holder)
    && String(holder.ownerPlayerId ?? holder.playerId ?? '').trim().toLowerCase() === viewerId
    && String(holder.instanceId ?? holder.playerId ?? '') === metadata.sourceId)
}

export function createPublicRuleSource(
  state: BattleState,
  viewerId: string,
): PublicRuleSourceController {
  const publicRuleIds = collectRuleIds(state, viewerId)
  const visibleCardIds = new Set(
    state.players
      .filter(player => normalized(player.playerId) === normalized(viewerId))
      .flatMap(player => (player.hand || []).flatMap(card => (
        typeof card?.cardId === 'string' && card.cardId.trim() ? [card.cardId] : []
      ))),
  )
  let unsupported = false
  const ruleResolver: RuleExecutionContext['ruleResolver'] = (battle, ruleId, metadata) => {
    // Canonical skills can attach new rules to the viewer in the isolated
    // battle. Resolve those owned sources from canonical resources only.
    if (!publicRuleIds.has(ruleId) && !ruleIsDeclaredByVisibleStatus(battle, ruleId)
      && !ruleSourceIsOwnedByViewer(battle, metadata, viewerId)) {
      unsupported = true
      return null
    }
    try {
      // loadRuleById is the engine's canonical JSON -> TriggerRule compiler.
      // The scoped context gives it a fresh cache; no active rule closure is
      // copied from the room or from the incoming snapshot.
      const rule = loadRuleById(ruleId, true, true)
      if (!rule || typeof rule.effect !== 'function') {
        unsupported = true
        return null
      }
      return rule
    } catch {
      unsupported = true
      return null
    }
  }

  const skillResolver: RuleExecutionContext['skillResolver'] = (_battle, skillId) => {
    try {
      // Only the canonical fs/VirtualFS resource is executable. Never
      // evaluate a code string supplied by a battle snapshot: the dynamic
      // code runtime is trusted content, not a sandbox for callers.
      const loaded = loadSkillById(skillId, true)
      if (loaded) return loaded
    } catch {
      // The caller receives the stable unavailable result below.
    }
    unsupported = true
    return null
  }

  const cardResolver: RuleExecutionContext['cardResolver'] = (_battle, cardId, candidate) => {
    // Opponent hands are intentionally represented by stable hidden sentinels
    // in the public projection. Their definitions are unavailable by design;
    // the existing trigger path already skips them when no executable source
    // is present, so they must not poison an otherwise public preview.
    if (cardId === 'hidden') return null
    if (typeof cardId !== 'string' || !visibleCardIds.has(cardId)) {
      unsupported = true
      return null
    }

    try {
      // Static cards are always loaded from the canonical content root. A
      // same-ID snapshot replacement can never override their executable
      // source.
      const canonical = loadCardById(cardId, false, true)
      if (canonical) return canonical
    } catch {
      // Dynamic cards below are admitted only through a verified generator.
    }

    const expected = generatedArmorCard(state, viewerId, cardId)
    if (expected && sameCardDefinition(candidate, expected)) return expected

    // A custom registry entry is data from the snapshot, not an authority
    // source. Unknown IDs, forged definitions, and altered Armor code all
    // remain unavailable without evaluating their code.
    unsupported = true
    return null
  }

  return {
    ruleResolver,
    skillResolver,
    cardResolver,
    hasUnsupportedAccess: () => unsupported,
  }
}
