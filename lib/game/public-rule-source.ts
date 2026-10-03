import type { BattleState } from './turn'
import type { RuleExecutionContext } from './rule-runtime'
import { loadRuleById, loadSkillById } from './skills'

type JsonRecord = Record<string, unknown>

export interface PublicRuleSourceController {
  readonly ruleResolver: RuleExecutionContext['ruleResolver']
  readonly skillResolver: RuleExecutionContext['skillResolver']
  hasUnsupportedAccess(): boolean
}

export class PublicRuleSourceError extends Error {}

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

export function createPublicRuleSource(
  state: BattleState,
  viewerId: string,
): PublicRuleSourceController {
  const publicRuleIds = collectRuleIds(state, viewerId)
  let unsupported = false
  const ruleResolver: RuleExecutionContext['ruleResolver'] = (battle, ruleId) => {
    if (!publicRuleIds.has(ruleId) && !ruleIsDeclaredByVisibleStatus(battle, ruleId)) {
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

  return {
    ruleResolver,
    skillResolver,
    hasUnsupportedAccess: () => unsupported,
  }
}
