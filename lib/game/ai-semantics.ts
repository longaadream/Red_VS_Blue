import {
  AI_SEMANTICS_SCHEMA_VERSION,
  type AiCandidateActionFeatures,
  type AiCompatibility,
  type AiMechanic,
  type AiObservation,
  type AiStatusFeature,
  type AiTransitionFeatures,
} from './ai-types'

type BattleLike = { pieces?: any[]; players?: any[]; rules?: any[] }

const unique = <T,>(values: T[]) => [...new Set(values)]

/** Deliberately small, browser-safe stable fingerprint. It identifies contracts, not security. */
export function stableAiHash(value: unknown): string {
  const canonicalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(canonicalize)
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonicalize(input[key])]))
    return input
  }
  const text = JSON.stringify(canonicalize(value))
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function visibleStatuses(piece: any): AiStatusFeature[] {
  return (piece.statusTags || []).filter((tag: any) => tag && tag.visible !== false).map((tag: any) => ({
    type: String(tag.type || tag.id || 'unknown'), stacks: Number(tag.stacks ?? 1),
    duration: Number.isFinite(tag.remainingDuration ?? tag.currentDuration) ? Number(tag.remainingDuration ?? tag.currentDuration) : undefined,
    dispellable: tag.dispellable, visible: true,
  })).sort((left: AiStatusFeature, right: AiStatusFeature) => left.type.localeCompare(right.type))
}

export function observeAiState(state: BattleLike, playerId: string, hashes: { rulesHash: string; contentHash: string }): AiObservation {
  const project = (piece: any) => ({ id: String(piece.instanceId), hp: Number(piece.currentHp || 0), maxHp: Number(piece.maxHp || 0), x: Number(piece.x || 0), y: Number(piece.y || 0), statuses: visibleStatuses(piece) })
  const live = (state.pieces || []).filter(piece => piece.currentHp > 0)
  return {
    schemaVersion: AI_SEMANTICS_SCHEMA_VERSION, observationScope: 'public-state', ...hashes,
    allies: live.filter(piece => piece.ownerPlayerId === playerId).map(project).sort((a, b) => a.id.localeCompare(b.id)),
    enemies: live.filter(piece => piece.ownerPlayerId !== playerId).map(project).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function transitionFeatures(before: BattleLike, after: BattleLike): AiTransitionFeatures {
  const oldPieces = new Map((before.pieces || []).map(piece => [piece.instanceId, piece]))
  const newPieces = new Map((after.pieces || []).map(piece => [piece.instanceId, piece]))
  let hpDelta = 0; let statusAdded = 0; let statusRemoved = 0
  for (const [id, next] of newPieces) {
    const previous = oldPieces.get(id); if (!previous) continue
    hpDelta += Number(next.currentHp || 0) - Number(previous.currentHp || 0)
    const oldTags = new Set((previous.statusTags || []).map((tag: any) => tag.id || tag.type))
    const nextTags = new Set((next.statusTags || []).map((tag: any) => tag.id || tag.type))
    statusAdded += [...nextTags].filter(tag => !oldTags.has(tag)).length
    statusRemoved += [...oldTags].filter(tag => !nextTags.has(tag)).length
  }
  const resourceDelta = (after.players || []).reduce((total, player: any) => total + Number(player.actionPoints || 0) + Number(player.chargePoints || 0), 0)
    - (before.players || []).reduce((total, player: any) => total + Number(player.actionPoints || 0) + Number(player.chargePoints || 0), 0)
  const mechanics: AiMechanic[] = []
  if (hpDelta < 0) mechanics.push('damage'); if (hpDelta > 0) mechanics.push('heal')
  if (statusAdded || statusRemoved) mechanics.push('status')
  if (newPieces.size > oldPieces.size) mechanics.push('summon')
  if (resourceDelta) mechanics.push('resource')
  return { mechanics: unique(mechanics), hpDelta, piecesSummoned: Math.max(0, newPieces.size - oldPieces.size), piecesRemoved: Math.max(0, oldPieces.size - newPieces.size), statusAdded, statusRemoved, resourceDelta }
}

export function candidateActionFeatures(action: any, metadata: { mechanics?: AiMechanic[]; compatibility?: AiCompatibility; diagnostics?: string } = {}): AiCandidateActionFeatures {
  return { schemaVersion: AI_SEMANTICS_SCHEMA_VERSION, actionType: String(action.type), contentId: action.skillId || action.cardId, targetCount: Number(Boolean(action.targetPieceId || action.targetX !== undefined)) + (action.extraTargets?.length || 0), mechanics: metadata.mechanics || [], compatibility: metadata.compatibility || 'unsupported', diagnostics: metadata.diagnostics }
}
