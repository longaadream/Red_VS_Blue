import type { BattlePresentationEvent, BattlePresentationCollision } from './battle-presentation-events'
import {
  projectBattlePresentationEvents,
  projectBattlePresentationEventsForViewer,
} from './battle-presentation-events'
import { recordBattlePresentation, recordedProjectilePaths } from './battle-presentation-recording'
import { toPublicBattleState } from './deployment'
import { createPublicRuleSource } from './public-rule-source'
import { skillChoicePromptKey } from './skill-choice-sequence'
import { loadSkillById } from './skills'
import { prepareAction } from './targeting'
import type { RuleExecutionContext } from './rule-runtime'
import {
  createRuleExecutionContext,
  isPreviewReactionPendingError,
  RuleRuntime,
  withRuleExecutionContext,
  withRuleRuntime,
} from './rule-runtime'
import { TriggerSystem } from './triggers'
import {
  applyBattleAction,
  type BattleAction,
  type BattleState,
} from './turn'

/**
 * RED-224 deliberately exposes a small, fail-closed preview surface.  The
 * input is a public snapshot and the executor gets no server rule registry,
 * no active trigger system and no active room runtime.
 */
export const PREVIEW_UNAVAILABLE_REASON = 'preview-unavailable'
export const PREVIEW_NEEDS_INPUT_REASON = 'preview-needs-input'

const PREVIEW_ROOT_SEED = 0x52564250
const PREVIEW_MAX_DEPTH = 80

export interface ReadyBattleActionPreview {
  status: 'ready'
  snapshot: BattleState
  events: BattlePresentationEvent[]
  durationMs: number
}

export interface UnavailableBattleActionPreview {
  status: 'unavailable'
  reason: typeof PREVIEW_UNAVAILABLE_REASON
  durationMs: number
}

export interface NeedsInputBattleActionPreview {
  status: 'needs-input'
  reason: typeof PREVIEW_NEEDS_INPUT_REASON
  durationMs: number
  /** Generated locally from the public replay, never a server transaction. */
  preparation?: JsonRecord
}

export type BattleActionPreview =
  | ReadyBattleActionPreview
  | UnavailableBattleActionPreview
  | NeedsInputBattleActionPreview

type JsonRecord = Record<string, unknown>

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0
}

function durationSince(start: number): number {
  const elapsed = nowMs() - start
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
}

function unavailable(start: number): UnavailableBattleActionPreview {
  return { status: 'unavailable', reason: PREVIEW_UNAVAILABLE_REASON, durationMs: durationSince(start) }
}

function needsInput(start: number, preparation?: JsonRecord): NeedsInputBattleActionPreview {
  return { status: 'needs-input', reason: PREVIEW_NEEDS_INPUT_REASON, durationMs: durationSince(start), ...(preparation ? { preparation } : {}) }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Reject anything that is not a finite, acyclic, plain JSON value. */
function isPureJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > PREVIEW_MAX_DEPTH) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => isPureJson(item, seen, depth + 1))
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.keys(value).every(key => isPureJson((value as JsonRecord)[key], seen, depth + 1))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function stateHasPendingInteraction(state: BattleState): boolean {
  const candidate = state as BattleState & JsonRecord
  return !!candidate.pendingOptionSelection
    || !!candidate.pendingTargetSelection
    || !!candidate.pendingBeginTurnChoice
    || !!candidate.pendingBeforeSkillChoice
}

const HIDDEN_INVENTORY_KEYS = [
  'deck',
  'drawPile',
  'drawDeck',
  'library',
  'deckCards',
  'privateHand',
  'secretHand',
] as const

function removeHiddenInventory(holder: JsonRecord): void {
  for (const key of HIDDEN_INVENTORY_KEYS) delete holder[key]
}

/**
 * The projection below proves the public rule sources before this check runs.
 * These remaining surfaces are rejected because their replay semantics still
 * depend on hidden or terminal state that is not represented in the preview
 * contract.
 */
function customCardRegistryChanged(state: BattleState, baseline: JsonRecord | undefined): boolean {
  const current = state.customCards
  const currentRecord = isRecord(current) ? current : undefined
  const currentKeys = currentRecord ? Object.keys(currentRecord) : []
  const baselineKeys = baseline ? Object.keys(baseline) : []
  if (currentKeys.length === 0 && baselineKeys.length === 0) return false
  if (!currentRecord || !baseline) return true
  return JSON.stringify(currentRecord) !== JSON.stringify(baseline)
}

function hasUnprovenExecutableState(state: BattleState, allowTerminal = false): boolean {
  if (state.deployment
    && state.deployment.status !== 'complete'
    && !isPreviewSafeProgressiveTurnReady(state)) return true
  if (!allowTerminal && state.terminalResult) return true

  return false
}

/**
 * A progressive reserve offer is still an interactive deployment transaction.
 * Once that transaction has settled, the public state keeps only its phase and
 * reserve counts. Ordinary action commands are then executable without any
 * deployment input, so the isolated preview may safely discard the metadata.
 */
function isPreviewSafeProgressiveTurnReady(state: BattleState): boolean {
  const deployment = state.deployment
  if (!deployment) return false
  if (deployment.mode !== 'progressive-reserve-v1' || deployment.status !== 'turn-ready') return false
  if (state.turn.phase !== 'action') return false
  const emptyList = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 0)
  return deployment.activePlayerId === undefined
    && deployment.offerTurnNumber === undefined
    && emptyList(deployment.offerPieceIds)
    && emptyList(deployment.offerPieces)
    && emptyList(deployment.legalPositions)
}

const PUBLIC_EXTENSION_KEYS = new Set(['contentMode', 'removedPieces', 'skillPresentation', 'tileEffects', 'minatoAnchors'])
const PRIVATE_EXTENSION_KEYS = new Set([
  'debugBattle', 'battleProfile', 'flowState', 'recallData', '__dryRunSkillPreflight',
  'adventureWorld', 'adventureCards',
])

function sanitizePreviewState(state: BattleState): boolean {
  if (state.deployment) {
    if (state.deployment.status !== 'complete' && !isPreviewSafeProgressiveTurnReady(state)) return false
    delete state.deployment
  }
  delete state.terminalResult
  delete state.turnTimer
  for (const piece of [...state.pieces, ...(state.graveyard ?? [])]) {
    delete piece.initialDefinition
    delete piece.spentPassives
  }
  if (state.extensions) {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(state.extensions)) {
      if (PRIVATE_EXTENSION_KEYS.has(key)) continue
      // Unknown extension data may be private or an optional presentation
      // feature. Drop it from the isolated input so its mere presence cannot
      // change availability and reveal hidden state.
      if (!PUBLIC_EXTENSION_KEYS.has(key)) continue
      if (key === 'minatoAnchors') {
        // Retain only viewer-projected geometry needed for anchor targeting.
        sanitized[key] = Array.isArray(value) ? value.filter(entry =>
          isRecord(entry) && Number.isSafeInteger(entry.x) && Number.isSafeInteger(entry.y)
          && typeof entry.sourceId === 'string',
        ).map(entry => ({ x: entry.x, y: entry.y, sourceId: entry.sourceId,
          ...(typeof entry.ownerPlayerId === 'string' ? { ownerPlayerId: entry.ownerPlayerId } : {}),
        })) : []
        continue
      }
      sanitized[key] = value
    }
    if (Array.isArray(sanitized.tileEffects)) {
      const visibleTileEffects = sanitized.tileEffects.filter(effect => !isRecord(effect) || effect.visible !== false)
      if (visibleTileEffects.length > 0) sanitized.tileEffects = visibleTileEffects
      else delete sanitized.tileEffects
      // Canonical Amaterasu contact rules read a parallel cell store. Retain
      // only entries proved by the public board effect, never hidden cells.
      const visibleAmaterasu = visibleTileEffects.filter(effect => isRecord(effect) && effect.tileType === 'amaterasu')
      if (visibleAmaterasu.length && Array.isArray(state.extensions.amaterasuCells)) {
        const cells = state.extensions.amaterasuCells.filter(cell => isRecord(cell) && cell.visible !== false
          && visibleAmaterasu.some(effect => isRecord(effect) && effect.x === cell.x && effect.y === cell.y))
        if (cells.length) {
          sanitized.amaterasuCells = cells
          const owner = state.extensions.amaterasuOwnerPlayerId
          if (typeof owner === 'string' && state.players.some(player => player.playerId === owner)) sanitized.amaterasuOwnerPlayerId = owner
        }
      }
    }
    state.extensions = sanitized
  }
  return true
}

function isPublicRuleForViewer(
  rule: unknown,
  holder: JsonRecord,
  viewerId: string,
  initialRuleIds: Set<string> = new Set(),
): boolean {
  if (!isRecord(rule) || typeof rule.id !== 'string') return false
  const owner = normalized(holder.ownerPlayerId ?? holder.playerId)
  if (owner === viewerId) return true
  // `public` on an incoming opponent descriptor is not proof. Initial
  // definitions and visible status links are the only public sources we
  // accept before replacing descriptors with generated ID-only records.
  if (initialRuleIds.has(rule.id)) return true
  const statuses = Array.isArray(holder.statusTags) ? holder.statusTags : []
  return statuses.some(status => isRecord(status)
    && status.visible !== false
    && Array.isArray(status.relatedRules)
    && status.relatedRules.some(id => String(id) === rule.id))
}

function initialPublicRuleIds(holder: JsonRecord): Set<string> {
  const initial = isRecord(holder.initialDefinition) ? holder.initialDefinition : undefined
  const values = Array.isArray(initial?.rules) ? initial.rules : []
  // Summons also have an initialDefinition. Its rules describe the internal
  // incarnation, not necessarily the body visible to an opponent. In
  // particular, hidden initial statuses can own death/immobility rules.
  const statuses = Array.isArray(initial?.statusTags) ? initial.statusTags : []
  const privateRuleIds = new Set(statuses.flatMap(status => (
    isRecord(status) && status.visible === false && Array.isArray(status.relatedRules)
      ? status.relatedRules.map(String)
      : []
  )))
  return new Set(values.flatMap(value => {
    if (typeof value === 'string' && value.trim() && !privateRuleIds.has(value)) return [value]
    if (isRecord(value) && typeof value.id === 'string' && value.id.trim() && !privateRuleIds.has(value.id)) return [value.id]
    return []
  }))
}

function publicSkillPresentation(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.bindings)) return undefined
  if (Array.isArray(value.records) || value.sequences !== undefined) return undefined
  return value
}

function applyPublicDisplayBindings(projected: BattleState, viewerId: string): void {
  const extension = projected.extensions as JsonRecord | undefined
  const presentation = publicSkillPresentation(extension?.skillPresentation)
  const bindings = new Map<string, JsonRecord>()
  if (presentation) {
    for (const raw of presentation.bindings as unknown[]) {
      if (!isRecord(raw) || typeof raw.targetId !== 'string' || !isRecord(raw.display)) continue
      bindings.set(raw.targetId, raw.display)
    }
  }
  for (const piece of projected.pieces) {
    const holder = piece as unknown as JsonRecord
    if (normalized(piece.ownerPlayerId) === viewerId) continue
    const display = bindings.get(piece.instanceId)
    if (display) {
      for (const [key, value] of Object.entries(display)) {
        if (['name', 'templateId', 'currentHp', 'maxHp', 'attack', 'defense', 'moveRange', 'skills', 'statusTags'].includes(key)) {
          holder[key] = cloneJson(value)
        }
      }
    } else {
      const legacyFields: Record<string, string> = {
        displayCurrentHp: 'currentHp',
        displayMaxHp: 'maxHp',
        displayAttack: 'attack',
        displayDefense: 'defense',
        displayMoveRange: 'moveRange',
        displaySkills: 'skills',
        displayStatusTags: 'statusTags',
      }
      for (const [sourceKey, targetKey] of Object.entries(legacyFields)) {
        if (holder[sourceKey] !== undefined) holder[targetKey] = cloneJson(holder[sourceKey])
      }
      // Legacy source-mirror displays follow the living source's health and
      // statuses in the board model. Use that same public appearance rather
      // than the summon-time snapshot or the hidden 99-HP incarnation.
      const master = projected.pieces.find(candidate => (
        candidate.instanceId === holder.masterPieceId && candidate.currentHp > 0
      ))
      if (master) {
        holder.currentHp = master.currentHp
        holder.maxHp = master.maxHp
        if (holder.displayStatusTags !== undefined) holder.statusTags = cloneJson(master.statusTags)
        if (master.initialDefinition) holder.initialDefinition = cloneJson(master.initialDefinition)
        else delete holder.initialDefinition
      }
    }
    for (const key of [
      'masterPieceId', 'displayCurrentHp', 'displayMaxHp', 'displayAttack',
      'displayDefense', 'displayMoveRange', 'displaySkills', 'displayStatusTags',
      'noKillCharge',
    ]) delete holder[key]
  }
}

const PUBLIC_TERRAIN_RULES = {
  amaterasu: 'rule-sasuke-amaterasu-move',
  'lethal-toxin': 'rule-blackwidow-toxin-player',
} as const

type PublicTerrainProof = {
  ruleIds: Set<string>
  statusTags: JsonRecord[]
}

type PublicTerrainProofCollection = {
  proofs: Map<string, PublicTerrainProof>
  incomplete: boolean
}

function addPublicTerrainProof(
  proofs: Map<string, PublicTerrainProof>,
  playerId: string,
  ruleId: string,
  status?: JsonRecord,
): void {
  const proof = proofs.get(playerId) ?? { ruleIds: new Set<string>(), statusTags: [] }
  proof.ruleIds.add(ruleId)
  if (status && typeof status.id === 'string'
    && !proof.statusTags.some(candidate => candidate.id === status.id)) {
    proof.statusTags.push(status)
  }
  proofs.set(playerId, proof)
}

function publicToxinStatus(status: JsonRecord): JsonRecord {
  // The canonical toxin rule reads only this public, tile-linked subset. Do
  // not carry an opponent's unrelated status metadata into the executor.
  const result: JsonRecord = {}
  for (const key of ['id', 'type', 'intensity', 'value', 'extraValue', 'sourceId', 'currentDuration']) {
    if (status[key] !== undefined) result[key] = cloneJson(status[key])
  }
  return result
}

function collectPublicTerrainProofs(state: BattleState, viewerId: string): PublicTerrainProofCollection {
  const proofs = new Map<string, PublicTerrainProof>()
  const extensions = state.extensions as JsonRecord | undefined
  if (!extensions) return { proofs, incomplete: false }
  let incomplete = false
  const effects = Array.isArray(extensions.tileEffects)
    ? extensions.tileEffects.filter(isRecord).filter(effect => effect.visible !== false)
    : []
  const players = state.players as unknown as JsonRecord[]
  const playerFor = (playerId: string): JsonRecord | undefined => players.find(player => (
    isRecord(player) && normalized(player.playerId) === playerId
  ))

  const amaterasuCells = Array.isArray(extensions.amaterasuCells)
    ? extensions.amaterasuCells.filter(isRecord).filter(cell => cell.visible !== false)
    : []
  const amaterasuOwner = normalized(extensions.amaterasuOwnerPlayerId)
  for (const effect of effects) {
    if (effect.tileType !== 'amaterasu') continue
    const cell = amaterasuCells.find(candidate => candidate.x === effect.x && candidate.y === effect.y)
    const effectOwner = normalized(effect.ownerPlayerId)
    if (!cell) {
      // A generic presentation marker without a source/owner is not enough
      // to infer an executable opponent rule. Once a canonical owner or
      // source marker is present, however, a missing public cell proof must
      // fail closed instead of silently dropping a known terrain effect.
      const knownOwner = amaterasuOwner || effectOwner
      if (knownOwner !== viewerId && (knownOwner || effect.sourceId !== undefined)) incomplete = true
      continue
    }
    const cellOwner = normalized(cell.ownerPlayerId)
    // The canonical Itachi skill can rewrite the global owner while retaining
    // older cells with a previous owner. Prefer the authoritative public
    // extension owner, then fall back to per-cell/tile metadata for older
    // snapshots that do not have it.
    const owner = amaterasuOwner || cellOwner || effectOwner
    if (!owner || (!amaterasuOwner && cellOwner && effectOwner && cellOwner !== effectOwner)) {
      incomplete = true
      continue
    }
    if (owner === viewerId) continue
    if (!playerFor(owner)) {
      incomplete = true
      continue
    }
    // The cell and owner are the public proof. The source piece may be dead or
    // already in the graveyard while the permanent terrain remains active, and
    // older canonical Amaterasu cells do not carry sourcePieceId.
    addPublicTerrainProof(proofs, owner, PUBLIC_TERRAIN_RULES.amaterasu)
  }

  for (const effect of effects) {
    if (effect.tileType !== 'lethal-toxin') continue
    const owner = normalized(effect.ownerPlayerId)
    const sourceId = typeof effect.sourceId === 'string' ? effect.sourceId : ''
    if (!owner) {
      incomplete = true
      continue
    }
    if (owner === viewerId) continue
    const player = playerFor(owner)
    if (!player || !sourceId) {
      incomplete = true
      continue
    }
    const statuses = Array.isArray(player.statusTags) ? player.statusTags.filter(isRecord) : []
    const status = statuses.find(candidate => candidate.visible !== false
      && candidate.type === 'lethal-toxin'
      && candidate.id === sourceId
      && typeof candidate.sourceId === 'string'
      && candidate.sourceId.length > 0
      && candidate.value === effect.x
      && candidate.extraValue === effect.y)
    if (!status) {
      // A visible toxin tile without its matching public status is an
      // incomplete network projection. Never invent its coordinates/damage or
      // silently present a result that omits a known public effect.
      incomplete = true
      continue
    }
    addPublicTerrainProof(proofs, owner, PUBLIC_TERRAIN_RULES['lethal-toxin'], publicToxinStatus(status))
  }
  return { proofs, incomplete }
}

/**
 * Always project before checking executable content. This prevents the
 * presence of an opponent's hidden status/rule from changing the result.
 */
function publicViewerExecutionSnapshot(snapshot: BattleState, viewerId: string): BattleState {
  // `toPublicBattleState` accepts the authoritative presentation store. A
  // network snapshot may already contain its public `{ bindings, ... }`
  // projection, which is intentionally not a store and must not be projected
  // a second time.
  const sourceExtensions = (snapshot as unknown as JsonRecord).extensions
  const publicPresentation = isRecord(sourceExtensions)
    ? publicSkillPresentation(sourceExtensions.skillPresentation)
    : undefined
  let projectionInput = snapshot
  if (publicPresentation && isRecord(sourceExtensions)) {
    const copiedExtensions = { ...sourceExtensions }
    delete copiedExtensions.skillPresentation
    projectionInput = { ...snapshot, extensions: copiedExtensions } as BattleState
  }
  const projected = toPublicBattleState(projectionInput, viewerId)
  if (publicPresentation) {
    projected.extensions = {
      ...(projected.extensions ?? {}),
      skillPresentation: cloneJson(publicPresentation),
    }
  }
  applyPublicDisplayBindings(projected, viewerId)
  if (projected.extensions) delete projected.extensions.skillPresentation
  const terrainProofCollection = collectPublicTerrainProofs(projected, viewerId)
  if (terrainProofCollection.incomplete) {
    throw new Error('Public terrain proof is incomplete')
  }
  const terrainProofs = terrainProofCollection.proofs
  for (const piece of projected.pieces) {
    const holder = piece as unknown as JsonRecord
    if (normalized(piece.ownerPlayerId) !== viewerId) {
      const initialRuleIds = initialPublicRuleIds(holder)
      const currentRules = Array.isArray(piece.rules) ? piece.rules : []
      const visibleRules = currentRules
        .filter(rule => isPublicRuleForViewer(rule, holder, viewerId, initialRuleIds))
        .flatMap(rule => {
          if (!isRecord(rule) || typeof rule.id !== 'string') return []
          // Rebuild the descriptor from its proven public ID. Preserve only
          // public runtime limits; never carry a snapshot effect/closure or
          // unverified metadata into the isolated engine.
          const publicRule: JsonRecord = { id: rule.id, public: true }
          if (isRecord(rule.limits)) publicRule.limits = cloneJson(rule.limits)
          return [publicRule]
        })
      const visibleRuleIds = new Set(visibleRules.flatMap(rule => (
        isRecord(rule) && typeof rule.id === 'string' ? [rule.id] : []
      )))
      // A serialized public piece may retain only its initial definition and
      // omit the hydrated executable rule. Re-add an ID-only public source so
      // the scoped resolver can compile the canonical rule in the fresh cache.
      for (const ruleId of initialRuleIds) {
        if (!visibleRuleIds.has(ruleId)) visibleRules.push({ id: ruleId, public: true })
      }
      piece.rules = visibleRules
    }
    if (normalized(piece.ownerPlayerId) !== viewerId) piece.ruleTags = []
    removeHiddenInventory(holder)
  }
  for (const player of projected.players) {
    const holder = player as unknown as JsonRecord
    if (normalized(player.playerId) !== viewerId && Array.isArray(player.rules)) {
      player.rules = player.rules.filter(rule => isPublicRuleForViewer(rule, holder, viewerId))
    }
    if (normalized(player.playerId) !== viewerId) {
      const proof = terrainProofs.get(normalized(player.playerId))
      if (proof) {
        const rules = Array.isArray(player.rules) ? player.rules : []
        for (const ruleId of proof.ruleIds) {
          if (!rules.some(rule => isRecord(rule) && rule.id === ruleId)) rules.push({ id: ruleId, public: true })
        }
        player.rules = rules
        player.statusTags = proof.statusTags
      } else {
        player.statusTags = []
      }
    }
    removeHiddenInventory(holder)
  }
  removeHiddenInventory(projected as unknown as JsonRecord)
  return projected
}

function actionFields(action: BattleAction): BattleAction {
  const source = action as unknown as JsonRecord
  const result: JsonRecord = {}
  for (const key of ['type', 'playerId', 'pieceId', 'skillId', 'cardInstanceId', 'toX', 'toY']) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) result[key] = source[key]
  }
  for (const key of [
    'path',
    'selectedOption',
    'targetX',
    'targetY',
    'targetPieceId',
    'extraTargets',
    'skillChoices',
    'selectionId',
    'stateRevision',
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) result[key] = source[key]
  }
  return result as BattleAction
}

function skillSteps(skill: JsonRecord): unknown[] {
  const targeting = skill.targeting
  if (!isRecord(targeting) || !Array.isArray(targeting.steps)) return []
  return targeting.steps
}

function requiresMoreThanOneSelection(skill: JsonRecord): boolean {
  const targeting = isRecord(skill.targeting) ? skill.targeting : undefined
  const steps = skillSteps(skill)
  if (steps.length > 1) return true
  if (targeting && (targeting.selectionMode === 'multi' || Number(targeting.maxSelections ?? 1) > 1)) return true
  return steps.some(step => {
    if (!isRecord(step)) return true
    return step.selectionMode === 'multi'
      || Number(step.max ?? step.maxSelections ?? 1) > 1
      || Number(step.min ?? step.minSelections ?? 0) > 1
  })
}

function selectionNeedsInput(skill: JsonRecord, action: BattleAction): boolean {
  if (requiresMoreThanOneSelection(skill)) return true
  const steps = skillSteps(skill)
  if (steps.length === 0) return false
  const step = steps[0]
  if (!isRecord(step)) return true
  const actionRecord = action as unknown as JsonRecord
  const hasTarget = typeof actionRecord.targetPieceId === 'string'
    || (Number.isFinite(actionRecord.targetX) && Number.isFinite(actionRecord.targetY))
  const kind = String(step.kind ?? step.type ?? '').toLowerCase()
  if ((kind === 'option' || kind === 'choice') && actionRecord.selectedOption === undefined) return true
  if ((kind === 'target' || kind === 'piece' || kind === 'cell') && !hasTarget) return true
  return false
}

function loadCanonicalPublicSkill(skillId: string): JsonRecord | undefined {
  try {
    // Keep the preflight cache out of the authority/default loader scope. The
    // actual preview installs another fresh scope before compiling the code.
    const preflightContext = createRuleExecutionContext(new TriggerSystem())
    const loaded = withRuleExecutionContext(preflightContext, () => loadSkillById(skillId, true))
    return isRecord(loaded) ? loaded : undefined
  } catch {
    return undefined
  }
}

function publicSkillDefinition(state: BattleState, skillId: string, preparationOnly = false): JsonRecord | undefined {
  const embedded = state.skillsById?.[skillId] as unknown
  const canonical = loadCanonicalPublicSkill(skillId)
  if (isRecord(embedded) && isRecord(canonical)
    && typeof embedded.code === 'string' && typeof canonical.code === 'string'
    && embedded.code !== canonical.code) return undefined
  const skill = canonical
  if (!isRecord(skill) || !isPureJson(skill)) return undefined
  if (typeof skill.id !== 'string' || skill.id !== skillId || typeof skill.code !== 'string' || skill.code.length === 0) return undefined
  // The runtime detector below is sticky across checkpoints. This lexical
  // guard also closes resources that can reach randomness through a compiled
  // surface which does not receive the scoped Math object.
  if (!preparationOnly && /\bMath\s*\.\s*random\s*\(/.test(skill.code)) return undefined
  // A declaration which itself names a rule/capability is not a public pure skill source.
  if (!preparationOnly && (skill.statusTag || skill.summonCapability || skill.deathParasitism)) return undefined
  return skill
}

function createStickyPreviewRuntime(): { runtime: RuleRuntime; randomAccessed: () => boolean } {
  const runtime = new RuleRuntime({ rootSeed: PREVIEW_ROOT_SEED, tick: 0 })
  let accessed = false
  const nextRandom = runtime.nextRandom.bind(runtime)
  const nextInt = runtime.nextInt.bind(runtime)
  runtime.nextRandom = ((streamName: string) => {
    accessed = true
    return nextRandom(streamName)
  }) as RuleRuntime['nextRandom']
  runtime.nextInt = ((streamName: string, maxExclusive: number) => {
    accessed = true
    return nextInt(streamName, maxExclusive)
  }) as RuleRuntime['nextInt']
  return {
    runtime,
    // Suspendable actions can execute in a reconstructed runtime and restore
    // its committed cursors into this one. Those draws bypass the method
    // hooks above; the isolated runtime starts at zero on every attempt.
    // Instance IDs use their own streams and do not select gameplay outcomes.
    randomAccessed: () => accessed || Object.entries(runtime.snapshot().cursors)
      .some(([name, cursor]) => !name.startsWith('instance-id/') && cursor > 0),
  }
}

function previewReactionKey(
  kind: 'rule' | 'reactiveCard',
  consumerId: string,
  sourceId: string | undefined,
  eventType: string,
): string {
  return `${kind}:${consumerId}:${sourceId ?? ''}:${eventType}`
}

function redactStatus(value: unknown): unknown {
  if (!isRecord(value) || value.visible === false) return undefined
  const status = { ...value }
  delete status.relatedRules
  delete status.statusOrigins
  return status
}

function redactPiece(piece: unknown): unknown {
  if (!isRecord(piece)) return undefined
  const result = { ...piece }
  delete result.initialDefinition
  delete result.limitedSkillUses
  delete result.spentPassives
  delete result.ruleTags
  delete result.rules
  delete result.masterPieceId
  delete result.displayCurrentHp
  delete result.displayMaxHp
  delete result.displayAttack
  delete result.displayDefense
  delete result.displayMoveRange
  delete result.displaySkills
  delete result.displayStatusTags
  delete result.noKillCharge
  result.statusTags = Array.isArray(piece.statusTags)
    ? piece.statusTags.map(redactStatus).filter(Boolean)
    : []
  if (Array.isArray(piece.buffs)) result.buffs = piece.buffs.map(value => {
    if (!isRecord(value)) return value
    const copy = { ...value }
    delete copy.source
    return copy
  })
  if (Array.isArray(piece.debuffs)) result.debuffs = piece.debuffs.map(value => {
    if (!isRecord(value)) return value
    const copy = { ...value }
    delete copy.source
    return copy
  })
  return result
}

function redactSkill(skill: unknown): unknown {
  if (!isRecord(skill)) return undefined
  const result = { ...skill }
  delete result.code
  delete result.previewCode
  // Authoring artifacts carry executable structure just like generated code.
  delete result.contentGraph
  delete result.contentGraphField
  delete result.contentGraphCompilerVersion
  delete result.contentGraphEntries
    delete result.gameplayModules
  delete result.statusTag
  delete result.summonCapability
  delete result.deathParasitism
  return result
}

function redactActionLog(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  const result: JsonRecord = {}
  for (const key of ['type', 'playerId', 'turn']) if (value[key] !== undefined) result[key] = value[key]
  if (isRecord(value.payload)) {
    const payload: JsonRecord = {}
    for (const key of [
      'pieceId', 'pieceTemplateId', 'skillId', 'fromX', 'fromY', 'toX', 'toY', 'path',
      'amount', 'value', 'movementKind', 'targetPieceId', 'targetCell',
    ]) if (value.payload[key] !== undefined) payload[key] = value.payload[key]
    if (Object.keys(payload).length > 0) result.payload = payload
  }
  return result
}

function visiblePresentationMarkers(snapshot: BattleState, viewerId: string): JsonRecord[] {
  const alreadyPublic = publicSkillPresentation(snapshot.extensions?.skillPresentation)
  const presentation = alreadyPublic ?? publicSkillPresentation(
    toPublicBattleState(snapshot, viewerId).extensions?.skillPresentation,
  )
  return Array.isArray(presentation?.markers) ? presentation.markers.flatMap(marker => {
    if (!isRecord(marker)) return []
    return [Object.fromEntries(Object.entries(marker).filter(([key]) => (
      ['id', 'x', 'y', 'label', 'icon'].includes(key)
    )))]
  }) : []
}

function publicPredictedState(state: BattleState, viewerId: string, skillId: string | undefined, baselineMarkers: JsonRecord[]): BattleState {
  // Hypothetical victories have no authoritative replay archive. Remove only
  // the terminal envelope from a copy, retaining the normal privacy projection.
  state = { ...state }
  delete state.terminalResult
  const projected = publicViewerExecutionSnapshot(state, viewerId) as unknown as JsonRecord
  // Return only presentation data from the already viewer-projected state.
  // Never carry executable/private extension stores into the hypothetical board.
  const publicProjection = toPublicBattleState(state, viewerId)
  const publicExtensions: JsonRecord = {}
  if (Array.isArray(publicProjection.extensions?.tileEffects)) {
    publicExtensions.tileEffects = publicProjection.extensions.tileEffects
      .filter(effect => isRecord(effect) && effect.visible !== false)
      .map(effect => Object.fromEntries(Object.entries(effect).filter(([key]) => (
        ['id', 'x', 'y', 'sourceId', 'tileType', 'type', 'icon', 'iconPosition', 'presentation', 'presentationStep'].includes(key)
      ))))
  }
  const markerKey = (marker: JsonRecord) => `${String(marker.id)}:${String(marker.x)},${String(marker.y)}`
  const markers = new Map(baselineMarkers.map(marker => [markerKey(marker), marker]))
  for (const marker of visiblePresentationMarkers(state, viewerId)) markers.set(markerKey(marker), marker)
  if (markers.size) {
    publicExtensions.skillPresentation = { version: 1, bindings: [], indicators: [], cues: [], markers: [...markers.values()] }
  }
  if (Object.keys(publicExtensions).length) projected.extensions = publicExtensions
  else delete projected.extensions
  delete projected.customCards
  delete projected.deployment
  delete projected.turnTimer
  delete projected.terminalResult
  delete projected.pendingOptionSelection
  delete projected.pendingTargetSelection
  delete projected.actions
  removeHiddenInventory(projected)
  if (skillId) projected.skillsById = {
    [skillId]: redactSkill(state.skillsById?.[skillId]),
  }
  else delete projected.skillsById
  if (Array.isArray(projected.pieces)) projected.pieces = projected.pieces.map(redactPiece).filter(Boolean)
  if (Array.isArray(projected.graveyard)) projected.graveyard = projected.graveyard.map(redactPiece).filter(Boolean)
  if (Array.isArray(projected.players)) {
    projected.players = projected.players.map(player => {
      if (!isRecord(player)) return player
      const result = { ...player }
      delete result.rules
      delete result.statusTags
      removeHiddenInventory(result)
      return result
    })
  }
  if (Array.isArray(projected.actions)) projected.actions = projected.actions.map(redactActionLog).filter(Boolean)
  return projected as unknown as BattleState
}

function safeEvents(events: readonly BattlePresentationEvent[]): BattlePresentationEvent[] {
  return events.map((event, index) => {
    const copy = cloneJson(event)
    const record = copy as unknown as JsonRecord
    delete record.visibleToPlayerIds
    delete record.ruleId
    delete record.causePath
    delete record.history
    delete record.historyChainId
    delete record.payload
    if (typeof record.batchId === 'string') record.batchId = `preview-batch-${index}`
    return copy
  })
}

function actionId(action: BattleAction): string {
  const record = action as unknown as JsonRecord
  return `preview:${String(record.type)}:${String(record.pieceId)}:${String(record.skillId)}:${String(record.cardInstanceId)}`
}

/**
 * Synchronously preview one viewer-owned root skill action in an isolated
 * public state.  This function never exposes the internal runtime or raw
 * executor output; any unsupported/uncertain result is discarded.
 */
function runPublicSkillAction(
  snapshot: BattleState,
  action: BattleAction,
  viewerId: string,
  collectOwnedChoices: boolean,
): BattleActionPreview {
  const started = nowMs()
  try {
    // Live room snapshots can still contain undefined fields and compiled
    // rule functions. They are removed by the public JSON projection below;
    // rejecting the authority-shaped object before projection would make the
    // browser preview fail for otherwise public actions.
    if (!isRecord(snapshot) || !action || typeof action !== 'object' || Array.isArray(action)
      || typeof viewerId !== 'string' || !viewerId.trim()) return unavailable(started)

    const viewer = normalized(viewerId)
    const safeAction = actionFields(action)
    if (!isPureJson(safeAction)) return unavailable(started)
    const actionRecord = action as unknown as JsonRecord
    const isMove = actionRecord.type === 'move'
    const isCard = actionRecord.type === 'playCard'
    const isSkill = actionRecord.type === 'useBasicSkill' || actionRecord.type === 'useChargeSkill'
    if (!isMove && !isSkill && !isCard) return unavailable(started)
    const baselineMarkers = visiblePresentationMarkers(snapshot, viewer)
    const publicSnapshot = publicViewerExecutionSnapshot(snapshot, viewer)
    if (!isPureJson(publicSnapshot)) return unavailable(started)
    if (stateHasPendingInteraction(publicSnapshot)) return needsInput(started)
    if (normalized(actionRecord.playerId) !== viewer) return unavailable(started)
    if (!isMove && !isCard && !collectOwnedChoices && Array.isArray(actionRecord.extraTargets) && actionRecord.extraTargets.length > 0) return needsInput(started)
    const source = !isCard
      ? publicSnapshot.pieces.find(piece => piece.instanceId === actionRecord.pieceId)
      : undefined
    if (!isCard && (!source || normalized(source.ownerPlayerId) !== viewer)) return unavailable(started)
    const owner = isCard
      ? publicSnapshot.players.find(player => normalized(player.playerId) === viewer)
      : undefined
    const card = isCard
      ? owner?.hand.find(entry => entry.instanceId === actionRecord.cardInstanceId)
      : undefined
    if (isCard && (!owner || !card || normalized(card.ownerPlayerId) !== viewer)) return unavailable(started)
    if (normalized(publicSnapshot.turn?.currentPlayerId) !== viewer || publicSnapshot.turn.phase !== 'action') return unavailable(started)
    if (hasUnprovenExecutableState(publicSnapshot)) return unavailable(started)
    const skillId = typeof actionRecord.skillId === 'string' ? actionRecord.skillId : undefined
    const cardId = isCard && typeof card?.cardId === 'string' ? card.cardId : undefined
    let skill: JsonRecord | undefined
    let cardDefinition: JsonRecord | undefined
    if (isSkill) {
      if (!skillId || !source?.skills?.some(skillEntry => skillEntry.skillId === skillId)) return unavailable(started)
      skill = publicSkillDefinition(publicSnapshot, skillId, collectOwnedChoices)
      if (!skill) return unavailable(started)
      if (!collectOwnedChoices && selectionNeedsInput(skill, safeAction)) return needsInput(started)
    } else if (isCard && cardId && card) {
      const cardSource = createPublicRuleSource(publicSnapshot, viewer)
      const resolved = cardSource.cardResolver?.(
        publicSnapshot,
        cardId,
        publicSnapshot.customCards?.[cardId],
        { sourceId: card.instanceId, skillId: cardId },
      )
      if (!resolved || cardSource.hasUnsupportedAccess()) return unavailable(started)
      cardDefinition = resolved as unknown as JsonRecord
    }

    // Use JSON-only state plus the selected public skill.  Never hydrate from
    // the server content registry in this surface.
    const safeState = cloneJson(publicSnapshot)
    if (isCard && cardId && cardDefinition && isRecord(safeState.customCards)) {
      // Targeting preflight reads the snapshot registry directly. Replace the
      // selected entry with the already verified canonical/generated copy so
      // forged metadata cannot influence a preparation response.
      safeState.customCards[cardId] = cloneJson(cardDefinition)
    }
    if (!sanitizePreviewState(safeState)) return unavailable(started)
    if (skillId && skill) {
      const safeSkill = cloneJson(skill)
      safeState.skillsById = { [skillId]: safeSkill as unknown as BattleState['skillsById'][string] }
    }
    const skippedReactions = new Set<string>()
    let randomAccessed = false
    let predicted: BattleState | undefined
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const attemptState = cloneJson(safeState)
      const publicRuleSource = createPublicRuleSource(attemptState, viewer)
      const runtimeScope = createStickyPreviewRuntime()
      const isolatedTriggerSystem = new TriggerSystem()
      let pendingReactionKey: string | undefined
      const context: RuleExecutionContext = createRuleExecutionContext(isolatedTriggerSystem, {
        ruleResolver: publicRuleSource.ruleResolver,
        skillResolver: publicRuleSource.skillResolver,
        cardResolver: publicRuleSource.cardResolver,
        previewReactionPolicy: {
          shouldSkipConsumer: (kind, consumerId, sourceId, eventType) => skippedReactions.has(
            previewReactionKey(kind, consumerId, sourceId, eventType),
          ),
          onPendingConsumer: (kind, consumerId, sourceId, eventType) => {
            const owner = attemptState.pieces.find(piece => piece.instanceId === sourceId)?.ownerPlayerId
              ?? attemptState.players.find(player => player.playerId === sourceId)?.playerId
            if (collectOwnedChoices && normalized(owner) === viewer) return false
            const key = previewReactionKey(kind, consumerId, sourceId, eventType)
            if (skippedReactions.has(key)) return false
            pendingReactionKey = key
            return true
          },
        },
      })
      try {
        if (collectOwnedChoices || isCard) {
          const preparation = withRuleRuntime(runtimeScope.runtime, () => withRuleExecutionContext(
            context, () => prepareAction(attemptState, safeAction),
          ))
          if (runtimeScope.randomAccessed() || publicRuleSource.hasUnsupportedAccess()) return unavailable(started)
          if (preparation.kind === 'invalid') return unavailable(started)
          if (preparation.kind !== 'ready') {
            const publicPreparation: JsonRecord = { kind: preparation.kind, continuation: false,
              source: {
                type: isCard ? 'card' : 'skill',
                id: isCard ? cardId : skillId,
                ...(source?.instanceId ? { pieceId: source.instanceId } : {}),
              } }
            const record = preparation as unknown as JsonRecord
            for (const key of ['title', 'selectionId', 'stateRevision', 'targetType', 'range', 'filter', 'rangeCells',
              'candidates', 'options', 'selectionMode', 'minSelections', 'maxSelections', 'canCancel', 'min', 'max', 'step']) {
              if (record[key] !== undefined) publicPreparation[key] = cloneJson(record[key])
            }
            return needsInput(started, publicPreparation)
          }
          // Public input metadata can be prepared even for effects that are
          // outside the supported preview executor. Never execute those
          // effects merely because their root choices have been completed.
          if (skill?.statusTag || skill?.summonCapability || skill?.deathParasitism
            || cardDefinition?.statusTag || cardDefinition?.summonCapability || cardDefinition?.deathParasitism
            || /\bMath\s*\.\s*random\s*\(/.test(String(skill?.code ?? ''))
            || /\bMath\s*\.\s*random\s*\(/.test(String(cardDefinition?.code ?? ''))) return unavailable(started)
        }
        predicted = recordBattlePresentation(
          attemptState,
          () => withRuleRuntime(runtimeScope.runtime, () => withRuleExecutionContext(
            context,
            () => applyBattleAction(attemptState, safeAction),
          )),
          result => result,
          { observeProjectilePaths: collectOwnedChoices },
        )
      } catch (error) {
        randomAccessed ||= runtimeScope.randomAccessed()
        if (isPreviewReactionPendingError(error) && pendingReactionKey) {
          if (isMove) return needsInput(started)
          skippedReactions.add(pendingReactionKey)
          continue
        }
        throw error
      }
      randomAccessed ||= runtimeScope.randomAccessed()
      if (randomAccessed || publicRuleSource.hasUnsupportedAccess()) return unavailable(started)
      break
    }

    if (!predicted || randomAccessed) return unavailable(started)
    if (customCardRegistryChanged(predicted, isRecord(safeState.customCards) ? safeState.customCards : undefined)) return unavailable(started)
    if (stateHasPendingInteraction(predicted)) {
      return needsInput(started, collectOwnedChoices ? publicNextSkillChoice(predicted, viewer) : undefined)
    }
    if (hasUnprovenExecutableState(predicted, true)) return unavailable(started)
    const postExecutionCheck = cloneJson(predicted)
    if (!sanitizePreviewState(postExecutionCheck)) return unavailable(started)

    const publicState = publicPredictedState(predicted, viewerId, skillId, baselineMarkers)
    const rawEvents = projectBattlePresentationEvents({
      actionId: actionId(safeAction),
      command: safeAction,
      beforeState: safeState,
      afterState: predicted,
    })
    const events = safeEvents(projectBattlePresentationEventsForViewer(rawEvents, viewerId))
    if (collectOwnedChoices) {
      for (const trace of recordedProjectilePaths(predicted) ?? []) {
        const cells = [trace.origin, ...trace.facts.filter(fact => fact.type === 'cell').map(fact => ({ x: fact.x, y: fact.y }))]
        if (cells.length < 2) continue
        const last = trace.facts.at(-1)
        const end = cells.at(-1)!
        events.push({
          eventId: `preview-path-${events.length}`, rootEventId: events[0]?.rootEventId ?? 'preview-root',
          actionId: actionId(safeAction), sequence: events.length, kind: 'passive', iconId: 'action-passive',
          actorPlayerId: viewerId, priority: 30, skippable: true,
          presentation: {
            cue: 'projectile', pathCells: cells.map(cell => ({ x: cell.x, y: cell.y })), endPoint: { ...end },
            endReason: last?.type === 'terrain' && last.blocksProjectile ? 'blocked' : last?.type === 'boundary' ? 'boundary' : 'resolved',
            collisions: trace.facts.flatMap<BattlePresentationCollision>(fact => {
              if (fact.type === 'piece') return [{ kind: 'piece' as const, x: fact.x, y: fact.y, pieceId: fact.piece.instanceId, blocking: false }]
              if (fact.type === 'terrain' && fact.blocksProjectile) return [{ kind: 'terrain' as const, x: fact.x, y: fact.y, terrainType: String(fact.tile.props?.type ?? 'terrain'), blocking: true }]
              return []
            }),
          },
        })
      }
    }
    return { status: 'ready', snapshot: publicState, events, durationMs: durationSince(started) }
  } catch {
    // Error details may include rule IDs, private state or loader paths.
    return unavailable(started)
  }
}

function publicNextSkillChoice(state: BattleState, viewer: string): JsonRecord | undefined {
  const pending = state.pendingTargetSelection ?? state.pendingOptionSelection
  if (!pending || normalized(pending.playerId) !== viewer || !pending.source) return undefined
  const source: JsonRecord = { type: pending.source.type, id: pending.source.id }
  if (pending.source.pieceId) source.pieceId = pending.source.pieceId
  const result: JsonRecord = {
    kind: state.pendingTargetSelection ? 'needTarget' : 'needOption',
    source, continuation: true,
    promptKey: skillChoicePromptKey(state.pendingTargetSelection ? 'target' : 'option', pending as unknown as JsonRecord),
  }
  const record = pending as unknown as JsonRecord
  for (const key of ['title', 'selectionId', 'stateRevision', 'range', 'filter', 'rangeCells', 'candidates', 'options',
    'selectionMode', 'minSelections', 'maxSelections', 'canCancel', 'min', 'max', 'step']) {
    if (record[key] !== undefined) result[key] = cloneJson(record[key])
  }
  if (state.pendingTargetSelection) {
    result.targetType = state.pendingTargetSelection.targetType === 'piece' ? 'piece' : 'cell'
  }
  return result
}

/** Read-only local preparation for public post-root choices. */
export function preparePublicSkillAction(snapshot: BattleState, action: BattleAction, viewerId: string): BattleActionPreview {
  return runPublicSkillAction(snapshot, action, viewerId, true)
}

export function previewBattleAction(snapshot: BattleState, action: BattleAction, viewerId: string): BattleActionPreview {
  return runPublicSkillAction(snapshot, action, viewerId, Object.hasOwn(action ?? {}, 'skillChoices')
    || (action as unknown as JsonRecord)?.selectedOption !== undefined
    || (Array.isArray((action as unknown as JsonRecord)?.extraTargets) && ((action as unknown as JsonRecord).extraTargets as unknown[]).length > 0))
}
