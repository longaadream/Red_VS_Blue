import type { ModeScopedContent } from './content-availability'
import type { AuthorEntityExtensionDeclarations } from './author-entity-extension'

export type PieceId = string

export const DEPLOYMENT_FIRST_MOVE_FREE_STATUS = 'deployment-first-move-free' as const

export type Faction = "red" | "blue" | "neutral" | "good" | "evil" | "light" | "dark"

export type PieceRarity = "common" | "rare" | "epic" | "legendary"

export interface PieceStats {
  maxHp: number
  attack: number
  defense: number
  moveRange: number
  speed?: number
  criticalRate?: number
}

export interface PieceSkill {
  skillId: string
  /** Stable identity for this installed skill instance. Old saves may omit it. */
  instanceId?: string
  level?: number
  currentCooldown?: number
  /** 剩余使用次数，限定技为1，其他技能为-1（无限制） */
  usesRemaining?: number
  /** Mutable state belonging to this concrete Skill instance. */
  extension?: Record<string, unknown>
  /** Typed declaration metadata for the concrete Skill extension. */
  authorExtensionDeclarations?: AuthorEntityExtensionDeclarations
  /** Runtime Cluster instances that contributed this Skill to its holder. */
  abilityGroupIds?: string[]
}

/**
 * Lazily assign deterministic identities to installed skill instances.
 *
 * Skill definitions are allowed to repeat on a piece, so a skill ID alone is
 * not an address. Existing saves do not carry the new field; assigning from
 * the owning piece and array position keeps those saves usable without
 * introducing a second process-global registry.
 */
export function ensurePieceSkillInstanceIds(
  piece: Pick<PieceInstance, 'instanceId' | 'skills'>,
): void {
  if (!Array.isArray(piece.skills)) return
  const used = new Set<string>()
  piece.skills.forEach((skill, index) => {
    if (!skill || typeof skill !== 'object') return
    const existing = typeof skill.instanceId === 'string' && skill.instanceId.length > 0
      ? skill.instanceId
      : undefined
    if (existing && !used.has(existing)) {
      used.add(existing)
      return
    }

    const base = `${piece.instanceId}:skill:${index}`
    let candidate = base
    let suffix = 1
    while (used.has(candidate)) {
      candidate = `${base}:${suffix}`
      suffix += 1
    }
    skill.instanceId = candidate
    used.add(candidate)
  })
}

/** Find a canonical installed skill object by its stable identity. */
export function findPieceSkillInstance(
  piece: Pick<PieceInstance, 'instanceId' | 'skills'>,
  instanceId: string,
  skillId?: string,
): PieceSkill | undefined {
  ensurePieceSkillInstanceIds(piece)
  return piece.skills.find(skill => (
    skill?.instanceId === instanceId
    && (skillId === undefined || skill.skillId === skillId)
  ))
}

/** Lazily assign deterministic identities to old status records. */
export function ensurePieceStatusInstanceIds(
  piece: Pick<PieceInstance, 'instanceId' | 'statusTags'>,
): void {
  if (!Array.isArray(piece.statusTags)) return
  const used = new Set<string>()
  piece.statusTags.forEach((status, index) => {
    if (!status || typeof status !== 'object') return
    const existing = typeof status.instanceId === 'string' && status.instanceId.length > 0
      ? status.instanceId
      : undefined
    if (existing && !used.has(existing)) {
      used.add(existing)
      return
    }
    const base = `${piece.instanceId}:status:${index}`
    let candidate = base
    let suffix = 1
    while (used.has(candidate)) {
      candidate = `${base}:${suffix}`
      suffix += 1
    }
    status.instanceId = candidate
    used.add(candidate)
  })
}

/** The serializable runtime result of explicitly acquiring an author Cluster. */
export interface PieceAbilityGroupInstance {
  /** Author definition ID. One definition is deduplicated per PieceInstance. */
  id: string
  /** Runtime identity allocated by the deterministic ID callback. */
  instanceId: string
  skills: string[]
  rules: string[]
  extension?: Record<string, unknown>
  /** Typed declaration metadata for the concrete Cluster extension. */
  authorExtensionDeclarations?: AuthorEntityExtensionDeclarations
}

/**
 * Per-piece ownership provenance for members installed by an ability group.
 * Empty/missing entries mean that the member predates Cluster acquisition (or
 * has been explicitly preserved by a direct host add).
 */
export interface PieceAbilityGroupOwnership {
  skills: Record<string, string[]>
  rules: Record<string, string[]>
  protectedSkills?: string[]
  protectedRules?: string[]
}

export interface PieceStatusTag {
  id: string
  type: string
  /** Stable identity for this concrete status instance; old saves are lazy-filled. */
  instanceId?: string
  extension?: Record<string, unknown>
  authorExtensionDeclarations?: AuthorEntityExtensionDeclarations
  name?: string
  currentDuration?: number
  remainingDuration?: number
  currentUses?: number
  intensity?: number
  stacks?: number
  value?: number
  relatedRules?: string[]
  visible?: boolean
  stacking?: 'none' | 'duration' | 'intensity' | 'independent'
  lifetime?: 'owner-turn-end' | 'event'
  appliedTurn?: number
  expiresAfterTurn?: number | null
  lastDurationTickTurn?: number
  statusAliases?: string[]
  statusOrigins?: PieceStatusTag[]
  [key: string]: unknown
}

/**
 * Persistent identity history for status records that predate instance IDs.
 *
 * `active` records IDs that have been bound to a status incarnation. When a
 * later flow observes that one of those IDs disappeared, it moves the ID to
 * `retired`; this keeps a restored save from binding the old reference to a
 * replacement at the same array position.
 */
export interface PieceStatusIdentityLedger {
  active: string[]
  retired: string[]
  next: number
}

export interface PieceTemplate extends ModeScopedContent {
  id: PieceId
  name: string
  faction: Faction
  description?: string
  rarity: PieceRarity
  image?: string
  stats: PieceStats
  skills: PieceSkill[]
  rules?: string[]
  /** Rules granted once to the owner at match setup, independent of deployment or survival. */
  playerRules?: string[]
  initialStatusTags?: PieceStatusTag[]
  isDefault?: boolean
  relatedCards?: string[]
  /** Data-driven setup effect executed while progressive reserves are initialized. */
  progressiveDeployment?: {
    reserveInitializationSkillId?: string
    openingVanguardPriority?: boolean
  }
}

export interface PieceInstance {
  extension?: Record<string, unknown>
  /** Persisted status identity history; absent on legacy pieces. */
  statusIdentityLedger?: PieceStatusIdentityLedger
  /** Explicitly acquired runtime Cluster instances for this piece. */
  abilityGroups?: PieceAbilityGroupInstance[]
  /** Serializable member ownership; never kept in a process-global registry. */
  abilityGroupOwnership?: PieceAbilityGroupOwnership
  /** Initial incarnation data; revival restores this before applying its own bonuses. */
  initialDefinition?: {
    stats: PieceStats
    skills: PieceSkill[]
    rules: string[]
    statusTags: PieceStatusTag[]
  }
  limitedSkillUses?: Record<string, number>
  spentPassives?: string[]
  instanceId: string
  /** Demo 初始阵容身份；召唤物不得继承。 */
  isCore?: boolean
  templateId: PieceId
  name: string
  ownerPlayerId: string
  faction: Faction
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  x: number | null
  y: number | null
  moveRange: number
  skills: PieceSkill[]
  displaySkills?: PieceSkill[]
  buffs: PieceBuff[]
  debuffs: PieceDebuff[]
  shield?: number
  ruleTags: string[] // 存储相关的规则ID数组
  statusTags: PieceStatusTag[] // 存储状态变量的标签数组，如"bleeding-duration"
  rules: any[] // 对该棋子生效的可执行规则；显示状态由 statusTags 表达
}

export interface PieceBuff {
  type: string
  value: number
  duration: number
  source: string
}

export interface PieceDebuff {
  type: string
  value: number
  duration: number
  source: string
}
