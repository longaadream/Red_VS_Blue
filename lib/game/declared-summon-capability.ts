import type { Faction } from './piece'
import type { AuthoredSummonCapabilityDeclaration } from './author-summon-schema'

/**
 * The declaration is shared by the authoring document validator and the
 * runtime queue writer.  Keep this module free of battle state and host
 * imports so the editor can enforce the same closed capability boundary.
 */
export interface SourceMirrorStatusDeclaration {
  readonly idPrefix: string
  readonly name: string
  readonly type: string
  readonly visible: boolean
  readonly remainingDuration: number
  readonly remainingUses: number
  readonly intensity: number
  readonly stacks: number
  readonly relatedRules: readonly string[]
}

export interface SourceMirrorSummonCapabilityDeclaration {
  readonly version: 1
  readonly recipe: 'source-mirror'
  readonly maxSummons: number
  readonly allowedVariants: readonly string[]
  readonly instanceIdPrefix: string
  readonly maxHp: number
  readonly attack: number
  readonly defense: number
  readonly moveRange: number
  readonly noKillCharge: boolean
  readonly resetBoundSkillCooldown: boolean
  readonly rules: readonly string[]
  readonly status: SourceMirrorStatusDeclaration
}

export interface DeclaredPieceSkillDeclaration {
  readonly skillId: string
  readonly level: number
  readonly currentCooldown: number
}

export interface StoredPieceFallbackDeclaration {
  readonly instanceIdPrefix: string
  readonly templateId: string
  readonly name: string
  readonly faction: Faction
  readonly maxHp: number
  readonly attack: number
  readonly defense: number
  readonly moveRange: number
  readonly skills: readonly DeclaredPieceSkillDeclaration[]
}

export interface StoredOrDeclaredPieceSummonCapabilityDeclaration {
  readonly version: 1
  readonly recipe: 'stored-or-declared-piece'
  readonly maxSummons: number
  readonly storageExtensionKey: string
  readonly ownerScopedStorageExtensionKey?: string
  readonly uniqueTemplateId: string
  readonly fallback: StoredPieceFallbackDeclaration
}

export type SummonCapabilityDeclaration =
  | SourceMirrorSummonCapabilityDeclaration
  | StoredOrDeclaredPieceSummonCapabilityDeclaration
  | AuthoredSummonCapabilityDeclaration

export type DeclaredSummonCapability = Readonly<SummonCapabilityDeclaration>

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyRuntimeKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function capabilityError(message: string): never {
  throw new TypeError(message)
}

function assertCapabilityKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (!hasOnlyRuntimeKeys(value, allowed)) {
    capabilityError(label + ' contains fields outside the closed capability schema')
  }
}

function readCapabilityString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    capabilityError(label + ' must be a non-empty string')
  }
  return value
}

function readCapabilityNumber(
  value: unknown,
  label: string,
  options: { integer?: boolean; minimum?: number } = {},
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || (options.integer && !Number.isSafeInteger(value))
    || (options.minimum !== undefined && value < options.minimum)
  ) {
    capabilityError(label + ' is outside the supported numeric range')
  }
  return value
}

function readCapabilityBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') capabilityError(label + ' must be boolean')
  return value
}

function readCapabilityStrings(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    capabilityError(label + ' must be a non-empty string array')
  }
  const strings = value.map((entry, index) => (
    readCapabilityString(entry, label + '[' + String(index) + ']')
  ))
  if (new Set(strings).size !== strings.length) {
    capabilityError(label + ' must not contain duplicates')
  }
  return Object.freeze(strings)
}

function parseSourceMirrorStatus(
  value: unknown,
  rules: readonly string[],
): SourceMirrorStatusDeclaration {
  if (!isRuntimeRecord(value)) capabilityError('source-mirror status must be a plain object')
  assertCapabilityKeys(value, [
    'idPrefix',
    'name',
    'type',
    'visible',
    'remainingDuration',
    'remainingUses',
    'intensity',
    'stacks',
    'relatedRules',
  ], 'source-mirror status')
  const relatedRules = readCapabilityStrings(value.relatedRules, 'source-mirror status.relatedRules')
  if (
    relatedRules.length !== rules.length
    || relatedRules.some((ruleId, index) => ruleId !== rules[index])
  ) {
    capabilityError('source-mirror status.relatedRules must exactly match capability rules')
  }
  return Object.freeze({
    idPrefix: readCapabilityString(value.idPrefix, 'source-mirror status.idPrefix'),
    name: readCapabilityString(value.name, 'source-mirror status.name'),
    type: readCapabilityString(value.type, 'source-mirror status.type'),
    visible: readCapabilityBoolean(value.visible, 'source-mirror status.visible'),
    remainingDuration: readCapabilityNumber(
      value.remainingDuration,
      'source-mirror status.remainingDuration',
      { integer: true },
    ),
    remainingUses: readCapabilityNumber(
      value.remainingUses,
      'source-mirror status.remainingUses',
      { integer: true },
    ),
    intensity: readCapabilityNumber(value.intensity, 'source-mirror status.intensity'),
    stacks: readCapabilityNumber(
      value.stacks,
      'source-mirror status.stacks',
      { integer: true, minimum: 1 },
    ),
    relatedRules,
  })
}

function parseSourceMirrorCapability(
  value: Record<string, unknown>,
): SourceMirrorSummonCapabilityDeclaration {
  assertCapabilityKeys(value, [
    'version',
    'recipe',
    'maxSummons',
    'allowedVariants',
    'instanceIdPrefix',
    'maxHp',
    'attack',
    'defense',
    'moveRange',
    'noKillCharge',
    'resetBoundSkillCooldown',
    'rules',
    'status',
  ], 'source-mirror capability')
  const rules = readCapabilityStrings(value.rules, 'source-mirror rules')
  const capability = Object.freeze({
    version: 1 as const,
    recipe: 'source-mirror' as const,
    maxSummons: readCapabilityNumber(
      value.maxSummons,
      'source-mirror maxSummons',
      { integer: true, minimum: 1 },
    ),
    allowedVariants: readCapabilityStrings(
      value.allowedVariants,
      'source-mirror allowedVariants',
    ),
    instanceIdPrefix: readCapabilityString(
      value.instanceIdPrefix,
      'source-mirror instanceIdPrefix',
    ),
    maxHp: readCapabilityNumber(value.maxHp, 'source-mirror maxHp', { minimum: 1 }),
    attack: readCapabilityNumber(value.attack, 'source-mirror attack', { minimum: 0 }),
    defense: readCapabilityNumber(value.defense, 'source-mirror defense', { minimum: 0 }),
    moveRange: readCapabilityNumber(
      value.moveRange,
      'source-mirror moveRange',
      { minimum: 0 },
    ),
    noKillCharge: readCapabilityBoolean(
      value.noKillCharge,
      'source-mirror noKillCharge',
    ),
    resetBoundSkillCooldown: readCapabilityBoolean(
      value.resetBoundSkillCooldown,
      'source-mirror resetBoundSkillCooldown',
    ),
    rules,
    status: parseSourceMirrorStatus(value.status, rules),
  })
  if (capability.maxSummons > 16 || capability.allowedVariants.length > 16) {
    capabilityError('source-mirror capability exceeds the sealed collection limit')
  }
  return capability
}

function parseDeclaredPieceSkills(value: unknown): readonly DeclaredPieceSkillDeclaration[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    capabilityError('stored piece fallback.skills must contain 1 to 32 declarations')
  }
  const skills = value.map((entry, index) => {
    if (!isRuntimeRecord(entry)) {
      capabilityError('stored piece fallback.skills[' + String(index) + '] must be a plain object')
    }
    assertCapabilityKeys(
      entry,
      ['skillId', 'level', 'currentCooldown'],
      'stored piece fallback skill',
    )
    return Object.freeze({
      skillId: readCapabilityString(
        entry.skillId,
        'stored piece fallback skill.skillId',
      ),
      level: readCapabilityNumber(
        entry.level,
        'stored piece fallback skill.level',
        { integer: true, minimum: 1 },
      ),
      currentCooldown: readCapabilityNumber(
        entry.currentCooldown,
        'stored piece fallback skill.currentCooldown',
        { integer: true, minimum: 0 },
      ),
    })
  })
  if (new Set(skills.map(skill => skill.skillId)).size !== skills.length) {
    capabilityError('stored piece fallback.skills must not contain duplicate skillId values')
  }
  return Object.freeze(skills)
}

function parseStoredPieceFallback(value: unknown): StoredPieceFallbackDeclaration {
  if (!isRuntimeRecord(value)) {
    capabilityError('stored piece fallback must be a plain object')
  }
  assertCapabilityKeys(value, [
    'instanceIdPrefix',
    'templateId',
    'name',
    'faction',
    'maxHp',
    'attack',
    'defense',
    'moveRange',
    'skills',
  ], 'stored piece fallback')
  if (value.faction !== 'red' && value.faction !== 'blue') {
    capabilityError('stored piece fallback.faction must be red or blue')
  }
  return Object.freeze({
    instanceIdPrefix: readCapabilityString(
      value.instanceIdPrefix,
      'stored piece fallback.instanceIdPrefix',
    ),
    templateId: readCapabilityString(
      value.templateId,
      'stored piece fallback.templateId',
    ),
    name: readCapabilityString(value.name, 'stored piece fallback.name'),
    faction: value.faction,
    maxHp: readCapabilityNumber(value.maxHp, 'stored piece fallback.maxHp', { minimum: 1 }),
    attack: readCapabilityNumber(value.attack, 'stored piece fallback.attack', { minimum: 0 }),
    defense: readCapabilityNumber(value.defense, 'stored piece fallback.defense', { minimum: 0 }),
    moveRange: readCapabilityNumber(
      value.moveRange,
      'stored piece fallback.moveRange',
      { minimum: 0 },
    ),
    skills: parseDeclaredPieceSkills(value.skills),
  })
}

function parseStoredPieceCapability(
  value: Record<string, unknown>,
): StoredOrDeclaredPieceSummonCapabilityDeclaration {
  assertCapabilityKeys(value, [
    'version',
    'recipe',
    'maxSummons',
    'storageExtensionKey',
    'ownerScopedStorageExtensionKey',
    'uniqueTemplateId',
    'fallback',
  ], 'stored-or-declared-piece capability')
  const storageExtensionKey = readCapabilityString(
    value.storageExtensionKey,
    'stored-or-declared-piece storageExtensionKey',
  )
  if (
    !/^[A-Za-z][A-Za-z0-9_]*$/.test(storageExtensionKey)
    || storageExtensionKey === '__proto__'
    || storageExtensionKey === 'prototype'
    || storageExtensionKey === 'constructor'
  ) {
    capabilityError('stored-or-declared-piece storageExtensionKey is unsafe')
  }
  const ownerScopedStorageExtensionKey = value.ownerScopedStorageExtensionKey === undefined
    ? undefined
    : readCapabilityString(
      value.ownerScopedStorageExtensionKey,
      'stored-or-declared-piece ownerScopedStorageExtensionKey',
    )
  if (
    ownerScopedStorageExtensionKey !== undefined
    && (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(ownerScopedStorageExtensionKey)
      || ownerScopedStorageExtensionKey === '__proto__'
      || ownerScopedStorageExtensionKey === 'prototype'
      || ownerScopedStorageExtensionKey === 'constructor'
      || ownerScopedStorageExtensionKey === storageExtensionKey
    )
  ) {
    capabilityError('stored-or-declared-piece ownerScopedStorageExtensionKey is unsafe')
  }
  const fallback = parseStoredPieceFallback(value.fallback)
  const uniqueTemplateId = readCapabilityString(
    value.uniqueTemplateId,
    'stored-or-declared-piece uniqueTemplateId',
  )
  if (uniqueTemplateId !== fallback.templateId) {
    capabilityError('stored-or-declared-piece uniqueTemplateId must match fallback.templateId')
  }
  const maxSummons = readCapabilityNumber(
    value.maxSummons,
    'stored-or-declared-piece maxSummons',
    { integer: true, minimum: 1 },
  )
  if (maxSummons !== 1) {
    capabilityError('stored-or-declared-piece maxSummons must be exactly 1')
  }
  return Object.freeze({
    version: 1 as const,
    recipe: 'stored-or-declared-piece' as const,
    maxSummons,
    storageExtensionKey,
    ownerScopedStorageExtensionKey,
    uniqueTemplateId,
    fallback,
  })
}

function parseAuthoredCapability(value: Record<string, unknown>): AuthoredSummonCapabilityDeclaration {
  assertCapabilityKeys(value, ['version', 'recipe', 'maxSummons', 'modes'], 'authored-piece capability')
  const maxSummons = readCapabilityNumber(value.maxSummons, 'authored-piece maxSummons', { integer: true, minimum: 1 })
  if (maxSummons > 64 || !Array.isArray(value.modes) || value.modes.length === 0 || value.modes.length > 2
    || new Set(value.modes).size !== value.modes.length || value.modes.some(mode => !['new-instance', 'return-instance'].includes(String(mode)))) {
    capabilityError('authored-piece modes or batch size is invalid')
  }
  return Object.freeze({ version: 1, recipe: 'authored-piece', maxSummons, modes: Object.freeze([...value.modes]) }) as AuthoredSummonCapabilityDeclaration
}

export function parseDeclaredSummonCapability(value: unknown): DeclaredSummonCapability {
  if (!isRuntimeRecord(value)) {
    capabilityError('summonCapability must be a plain object')
  }
  if (value.version !== 1) capabilityError('summonCapability.version must be 1')
  if (value.recipe === 'source-mirror') return parseSourceMirrorCapability(value)
  if (value.recipe === 'stored-or-declared-piece') return parseStoredPieceCapability(value)
  if (value.recipe === 'authored-piece') return parseAuthoredCapability(value)
  capabilityError('summonCapability.recipe is not supported')
}
