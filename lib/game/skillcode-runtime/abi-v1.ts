/**
 * SkillCode ABI v1 contract (RED-151).
 *
 * This module is intentionally disconnected from the current trusted
 * dynamic-code runtime. RED-153 may consume it when the sandbox exists.
 */

export const SKILLCODE_ABI_V1 = 'rvb-skillcode/v1' as const

export const SKILLCODE_ABI_V1_SURFACE_NAMES = Object.freeze([
  'skillCode',
  'cardCode',
  'ruleSkillCode',
  'ruleTriggerSkill',
  'pendingEffectCode',
  'previewCode',
] as const)

export type SkillCodeAbiV1Surface = typeof SKILLCODE_ABI_V1_SURFACE_NAMES[number]

export const SKILLCODE_ABI_V1_ERROR_CODES = Object.freeze([
  'SKILLCODE_ABI_MISSING',
  'SKILLCODE_ABI_UNSUPPORTED',
  'SKILLCODE_SURFACE_UNSUPPORTED',
  'SKILLCODE_CAPABILITY_UNKNOWN',
  'SKILLCODE_CAPABILITY_DENIED',
  'SKILLCODE_INPUT_SCHEMA_INVALID',
  'SKILLCODE_OUTPUT_SCHEMA_INVALID',
  'SKILLCODE_HOST_REFERENCE_FORBIDDEN',
  'SKILLCODE_ASYNC_FORBIDDEN',
  'SKILLCODE_BUDGET_FUEL_EXCEEDED',
  'SKILLCODE_BUDGET_MEMORY_EXCEEDED',
  'SKILLCODE_BUDGET_OUTPUT_EXCEEDED',
  'SKILLCODE_BUDGET_COMMANDS_EXCEEDED',
  'SKILLCODE_BUDGET_RECURSION_EXCEEDED',
  'SKILLCODE_BUDGET_EVENT_CHAIN_EXCEEDED',
  'SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED',
  'SKILLCODE_EXECUTION_FAILED',
  'SKILLCODE_TRANSACTION_ROLLED_BACK',
] as const)

export type SkillCodeAbiV1ErrorCode = typeof SKILLCODE_ABI_V1_ERROR_CODES[number]

export type SkillCodeAbiV1Budget = Readonly<{
  fuel: number
  memoryBytes: number
  outputBytes: number
  commandCount: number
  recursionDepth: number
  eventChainDepth: number
  pendingReplayDepth: number
}>

const AUTHORITY_BUDGET: SkillCodeAbiV1Budget = Object.freeze({
  fuel: 100_000,
  memoryBytes: 16 * 1024 * 1024,
  outputBytes: 64 * 1024,
  commandCount: 256,
  recursionDepth: 64,
  eventChainDepth: 32,
  pendingReplayDepth: 8,
})

const PREVIEW_BUDGET: SkillCodeAbiV1Budget = Object.freeze({
  fuel: 20_000,
  memoryBytes: 4 * 1024 * 1024,
  outputBytes: 16 * 1024,
  commandCount: 0,
  recursionDepth: 64,
  eventChainDepth: 32,
  pendingReplayDepth: 8,
})

export const SKILLCODE_ABI_V1_BUDGETS = Object.freeze({
  authority: AUTHORITY_BUDGET,
  preview: PREVIEW_BUDGET,
})

export const SKILLCODE_ABI_V1_COMMAND_KINDS = Object.freeze([
  'card.add-to-hand',
  'card.discard',
  'damage.apply',
  'event.fire',
  'heal.apply',
  'piece.force-remove',
  'piece.teleport',
  'player-rule.add',
  'player-rule.remove',
  'player-skill.add',
  'player-skill.remove',
  'player-status.add',
  'player-status.remove',
  'rule.add',
  'rule.remove',
  'skill.add',
  'skill.remove',
  'status.add',
  'status.remove',
] as const)

export type SkillCodeAbiV1CommandKind = typeof SKILLCODE_ABI_V1_COMMAND_KINDS[number]

export type SkillCodeAbiV1CommandSchema = Readonly<{
  capability: string
  required: readonly string[]
  optional: readonly string[]
}>

export const SKILLCODE_ABI_V1_COMMAND_SCHEMAS: Readonly<Record<SkillCodeAbiV1CommandKind, SkillCodeAbiV1CommandSchema>> = Object.freeze({
  'card.add-to-hand': Object.freeze({ capability: 'addCardToHand', required: Object.freeze(['playerHandle', 'cardId']), optional: Object.freeze([]) }),
  'card.discard': Object.freeze({ capability: 'discardCard', required: Object.freeze(['cardInstanceHandle']), optional: Object.freeze([]) }),
  'damage.apply': Object.freeze({ capability: 'dealDamage', required: Object.freeze(['sourceHandle', 'targetHandles', 'amount', 'damageType']), optional: Object.freeze([]) }),
  'event.fire': Object.freeze({ capability: 'fireEvent', required: Object.freeze(['event', 'context']), optional: Object.freeze([]) }),
  'heal.apply': Object.freeze({ capability: 'healDamage', required: Object.freeze(['sourceHandle', 'targetHandles', 'amount']), optional: Object.freeze([]) }),
  'piece.force-remove': Object.freeze({ capability: 'context.forceRemoveEnemyPieceById', required: Object.freeze(['targetHandle']), optional: Object.freeze([]) }),
  'piece.teleport': Object.freeze({ capability: 'teleport', required: Object.freeze(['pieceHandle', 'x', 'y']), optional: Object.freeze([]) }),
  'player-rule.add': Object.freeze({ capability: 'addPlayerRuleById', required: Object.freeze(['playerHandle', 'ruleId']), optional: Object.freeze([]) }),
  'player-rule.remove': Object.freeze({ capability: 'removePlayerRuleById', required: Object.freeze(['playerHandle', 'ruleId']), optional: Object.freeze([]) }),
  'player-skill.add': Object.freeze({ capability: 'addPlayerSkillById', required: Object.freeze(['playerHandle', 'skillId']), optional: Object.freeze([]) }),
  'player-skill.remove': Object.freeze({ capability: 'removePlayerSkillById', required: Object.freeze(['playerHandle', 'skillId']), optional: Object.freeze([]) }),
  'player-status.add': Object.freeze({ capability: 'addPlayerStatusEffectById', required: Object.freeze(['playerHandle', 'status']), optional: Object.freeze([]) }),
  'player-status.remove': Object.freeze({ capability: 'removePlayerStatusEffectById', required: Object.freeze(['playerHandle', 'statusId']), optional: Object.freeze([]) }),
  'rule.add': Object.freeze({ capability: 'addRuleById', required: Object.freeze(['ownerHandle', 'ruleId']), optional: Object.freeze([]) }),
  'rule.remove': Object.freeze({ capability: 'removeRuleById', required: Object.freeze(['ownerHandle', 'ruleId']), optional: Object.freeze([]) }),
  'skill.add': Object.freeze({ capability: 'addSkillById', required: Object.freeze(['ownerHandle', 'skillId']), optional: Object.freeze([]) }),
  'skill.remove': Object.freeze({ capability: 'removeSkillById', required: Object.freeze(['ownerHandle', 'skillId']), optional: Object.freeze([]) }),
  'status.add': Object.freeze({ capability: 'addStatusEffectById', required: Object.freeze(['ownerHandle', 'status']), optional: Object.freeze([]) }),
  'status.remove': Object.freeze({ capability: 'removeStatusEffectById', required: Object.freeze(['ownerHandle', 'statusId']), optional: Object.freeze([]) }),
})

export const SKILLCODE_ABI_V1_STATUS_FIELDS = Object.freeze({
  required: Object.freeze(['id', 'type']),
  optional: Object.freeze([
    'name', 'currentDuration', 'remainingDuration', 'currentUses', 'remainingUses',
    'intensity', 'stacks', 'value', 'extraValue', 'damage', 'relatedRules',
    'visible', 'sourceHandle', 'targetHandle', 'createdTurn',
  ]),
})

type InteractionMode = 'target-and-option' | 'option-only' | 'none'

export const SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS = Object.freeze({
  context: 'rvb-context-snapshot/v1',
  battle: 'rvb-battle-snapshot/v1',
  trigger: 'rvb-trigger-snapshot/v1',
  pending: 'rvb-pending-snapshot/v1',
  piece: 'rvb-piece-snapshot/v1',
  skill: 'rvb-skill-snapshot/v1',
  pendingPayload: 'rvb-pending-payload/v1',
} as const)

export type SkillCodeAbiV1DataFieldSchema = Readonly<
  | { kind: 'string' }
  | { kind: 'handle' }
  | { kind: 'finite-number' }
  | { kind: 'non-negative-integer' }
  | { kind: 'handle-array'; minItems: number; unique: true }
  | { kind: 'typed-record'; valueKind: 'string' | 'handle' | 'finite-number' }
>

export type SkillCodeAbiV1DataSchema = Readonly<{
  required: readonly string[]
  optional: readonly string[]
  fields: Readonly<Record<string, SkillCodeAbiV1DataFieldSchema>>
}>

const dataSchema = (
  required: readonly string[],
  optional: readonly string[],
  fields: Readonly<Record<string, SkillCodeAbiV1DataFieldSchema>>,
): SkillCodeAbiV1DataSchema => Object.freeze({
  required: Object.freeze([...required]),
  optional: Object.freeze([...optional]),
  fields: Object.freeze(fields),
})

const stringField = Object.freeze({ kind: 'string' } as const)
const handleField = Object.freeze({ kind: 'handle' } as const)
const finiteNumberField = Object.freeze({ kind: 'finite-number' } as const)
const nonNegativeIntegerField = Object.freeze({ kind: 'non-negative-integer' } as const)
const handleArrayField = (minItems: number) => Object.freeze({ kind: 'handle-array', minItems, unique: true } as const)

export const SKILLCODE_ABI_V1_DATA_SCHEMAS = Object.freeze({
  skillContext: dataSchema(['pieceHandle'], [], { pieceHandle: handleField }),
  cardContext: dataSchema(['cardInstanceHandle'], [], { cardInstanceHandle: handleField }),
  ruleContext: dataSchema(['event'], [], { event: stringField }),
  battle: dataSchema(
    ['stateHash', 'turnNumber', 'phase', 'pieceHandles', 'playerHandles'],
    [],
    { stateHash: stringField, turnNumber: nonNegativeIntegerField, phase: stringField, pieceHandles: handleArrayField(0), playerHandles: handleArrayField(0) },
  ),
  trigger: dataSchema(['event', 'targetHandle'], [], { event: stringField, targetHandle: handleField }),
  pending: dataSchema(['selectionId', 'selectedTargetHandles'], [], { selectionId: handleField, selectedTargetHandles: handleArrayField(1) }),
  piece: dataSchema(['handle', 'x', 'y'], [], { handle: handleField, x: finiteNumberField, y: finiteNumberField }),
  skill: dataSchema(['handle', 'range'], [], { handle: handleField, range: finiteNumberField }),
  pendingPayload: dataSchema([], ['handles', 'numbers', 'enums'], {
    handles: Object.freeze({ kind: 'typed-record', valueKind: 'handle' } as const),
    numbers: Object.freeze({ kind: 'typed-record', valueKind: 'finite-number' } as const),
    enums: Object.freeze({ kind: 'typed-record', valueKind: 'string' } as const),
  }),
} as const)

export type SkillCodeAbiV1DataSchemaName = keyof typeof SKILLCODE_ABI_V1_DATA_SCHEMAS

export type SkillCodeAbiV1InputFieldSchema = Readonly<
  | { kind: 'snapshot'; schemaVersion: string; dataSchema: SkillCodeAbiV1DataSchemaName }
  | { kind: 'payload'; schemaVersion: string; dataSchema: SkillCodeAbiV1DataSchemaName }
  | { kind: 'handle' }
  | { kind: 'handle-array'; minItems: number; unique: true }
  | { kind: 'answers'; maxItems: number }
  | { kind: 'non-negative-integer' }
>

const snapshot = (schemaVersion: string, schema: SkillCodeAbiV1DataSchemaName): SkillCodeAbiV1InputFieldSchema => Object.freeze({ kind: 'snapshot', schemaVersion, dataSchema: schema })
const handle = Object.freeze({ kind: 'handle' } as const)
const answers = Object.freeze({ kind: 'answers', maxItems: AUTHORITY_BUDGET.pendingReplayDepth } as const)

export const SKILLCODE_ABI_V1_INPUT_SCHEMAS: Readonly<Record<SkillCodeAbiV1Surface, Readonly<Record<string, SkillCodeAbiV1InputFieldSchema>>>> = Object.freeze({
  skillCode: Object.freeze({
    context: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.context, 'skillContext'),
    sourcePieceHandle: handle,
    battleSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle, 'battle'),
    answers,
  }),
  cardCode: Object.freeze({
    context: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.context, 'cardContext'),
    battleSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle, 'battle'),
    playerHandle: handle,
    answers,
  }),
  ruleSkillCode: Object.freeze({
    context: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.context, 'ruleContext'),
    battleSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle, 'battle'),
    ruleHandle: handle,
    answers,
  }),
  ruleTriggerSkill: Object.freeze({
    triggerSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.trigger, 'trigger'),
    battleSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle, 'battle'),
    ruleHandle: handle,
    sourcePieceHandle: handle,
  }),
  pendingEffectCode: Object.freeze({
    pendingSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.pending, 'pending'),
    battleSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle, 'battle'),
    playerHandle: handle,
    targetHandles: Object.freeze({ kind: 'handle-array', minItems: 1, unique: true } as const),
    payload: Object.freeze({ kind: 'payload', schemaVersion: SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.pendingPayload, dataSchema: 'pendingPayload' } as const),
  }),
  previewCode: Object.freeze({
    pieceSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.piece, 'piece'),
    skillSnapshot: snapshot(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.skill, 'skill'),
    currentCooldown: Object.freeze({ kind: 'non-negative-integer' } as const),
  }),
})

export type SkillCodeAbiV1StatusSemantics = Readonly<{
  pieceAdd: 'append' | 'replace-same-id' | 'unsupported'
  playerAdd: 'append' | 'unsupported'
  cardIntensityModifier: boolean
  pieceAfterStatusApplied: boolean
  pieceAfterStatusRemoved: boolean
  playerAfterStatusApplied: false
  playerAfterStatusRemoved: false
  pieceRelatedRuleCleanup: boolean
  pieceMissingDurationAndUses: 'preserve' | 'default-minus-one'
  playerMissingDurationAndUses: 'preserve'
}>

const unsupportedStatusSemantics: SkillCodeAbiV1StatusSemantics = Object.freeze({
  pieceAdd: 'unsupported',
  playerAdd: 'unsupported',
  cardIntensityModifier: false,
  pieceAfterStatusApplied: false,
  pieceAfterStatusRemoved: false,
  playerAfterStatusApplied: false,
  playerAfterStatusRemoved: false,
  pieceRelatedRuleCleanup: false,
  pieceMissingDurationAndUses: 'preserve',
  playerMissingDurationAndUses: 'preserve',
})

export type SkillCodeAbiV1SurfaceContract = Readonly<{
  field: string
  functionForm: string
  authority: boolean
  interaction: InteractionMode
  capabilities: readonly string[]
  commandKinds: readonly SkillCodeAbiV1CommandKind[]
  input: Readonly<Record<string, SkillCodeAbiV1InputFieldSchema>>
  statusSemantics: SkillCodeAbiV1StatusSemantics
  output: readonly string[]
  pending: string
  errors: string
  unsupported: readonly string[]
  runtimeEvidence: readonly Readonly<{ file: string; symbol?: string }>[]
}>

const skillCommands = SKILLCODE_ABI_V1_COMMAND_KINDS
const cardCommands = Object.freeze([
  'card.add-to-hand', 'card.discard', 'damage.apply', 'heal.apply',
  'player-rule.add', 'player-rule.remove', 'rule.add', 'rule.remove',
  'status.add', 'status.remove',
] as const satisfies readonly SkillCodeAbiV1CommandKind[])
const ruleCommands = Object.freeze([
  'card.add-to-hand', 'damage.apply', 'event.fire', 'heal.apply',
  'player-rule.add', 'player-rule.remove', 'player-skill.add', 'player-skill.remove',
  'player-status.add', 'player-status.remove', 'rule.add', 'rule.remove',
  'status.add', 'status.remove',
] as const satisfies readonly SkillCodeAbiV1CommandKind[])
const triggerCommands = Object.freeze([
  'card.add-to-hand', 'card.discard', 'damage.apply', 'heal.apply',
  'player-rule.add', 'player-rule.remove', 'player-skill.add', 'player-skill.remove',
  'player-status.add', 'player-status.remove', 'rule.add', 'rule.remove',
  'skill.add', 'skill.remove', 'status.add', 'status.remove',
] as const satisfies readonly SkillCodeAbiV1CommandKind[])
const noCommands = Object.freeze([] as const)

export const SKILLCODE_ABI_V1_SURFACES: Readonly<Record<SkillCodeAbiV1Surface, SkillCodeAbiV1SurfaceContract>> = Object.freeze({
  skillCode: Object.freeze({
    field: 'data/skills/*.json#code',
    functionForm: 'function executeSkill(context)',
    authority: true,
    interaction: 'target-and-option',
    capabilities: Object.freeze([
      'select', 'selectTarget', 'selectOption', 'teleport', 'dealDamage', 'healDamage',
      'traceProjectile', 'addStatusEffectById', 'removeStatusEffectById',
      'getAllEnemiesInRange', 'getAllAlliesInRange', 'calculateDistance',
      'isTargetInRange', 'addRuleById', 'removeRuleById', 'addPlayerRuleById',
      'removePlayerRuleById', 'addPlayerSkillById', 'removePlayerSkillById',
      'addPlayerStatusEffectById', 'removePlayerStatusEffectById', 'addSkillById',
      'removeSkillById', 'addCardToHand', 'discardCard', 'getHand', 'fireEvent',
      'context.forceRemoveEnemyPieceById', 'Math', 'Date',
    ]),
    commandKinds: skillCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.skillCode,
    statusSemantics: Object.freeze({
      pieceAdd: 'append', playerAdd: 'append', cardIntensityModifier: false,
      pieceAfterStatusApplied: true, pieceAfterStatusRemoved: true,
      playerAfterStatusApplied: false, playerAfterStatusRemoved: false,
      pieceRelatedRuleCleanup: true,
      pieceMissingDurationAndUses: 'preserve', playerMissingDurationAndUses: 'preserve',
    }),
    output: Object.freeze(['status', 'value', 'commands', 'pending', 'diagnostics', 'budgetUsed']),
    pending: 'Target/option requests stop execution; the authority action replays from its root with stable answers.',
    errors: 'Any compile, capability, schema, budget, or execution failure rejects the candidate transaction.',
    unsupported: Object.freeze(['host BattleState references', 'async work', 'ambient host globals including console', 'direct state mutation other than the explicit force-remove command']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'executeSkillFunction' }),
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'context.forceRemoveEnemyPieceById' }),
      Object.freeze({ file: 'data/skills/obito-space-time.json' }),
      Object.freeze({ file: 'scripts/audit-skillcode-compat.mjs' }),
    ]),
  }),
  cardCode: Object.freeze({
    field: 'data/cards/*.json#code',
    functionForm: 'function executeCard(context)',
    authority: true,
    interaction: 'target-and-option',
    capabilities: Object.freeze([
      'selectTarget', 'selectOption', 'dealDamage', 'healDamage', 'addCardToHand',
      'discardCard', 'getHand', 'addStatusEffectById', 'removeStatusEffectById',
      'addRuleById', 'removeRuleById', 'addPlayerRuleById', 'removePlayerRuleById',
      'Math', 'Date',
    ]),
    commandKinds: cardCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.cardCode,
    statusSemantics: Object.freeze({
      pieceAdd: 'append', playerAdd: 'unsupported', cardIntensityModifier: true,
      pieceAfterStatusApplied: false, pieceAfterStatusRemoved: false,
      playerAfterStatusApplied: false, playerAfterStatusRemoved: false,
      pieceRelatedRuleCleanup: false,
      pieceMissingDurationAndUses: 'preserve', playerMissingDurationAndUses: 'preserve',
    }),
    output: Object.freeze(['status', 'value', 'commands', 'pending', 'diagnostics', 'budgetUsed']),
    pending: 'Target/option requests replay the card action from the authority root; no sourcePiece is implied.',
    errors: 'Failure rejects payment, discard, and all candidate commands.',
    unsupported: Object.freeze(['guaranteed sourcePiece', 'host BattleState references', 'console', 'async work', 'direct state mutation']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'executeCardFunction' }),
      Object.freeze({ file: 'scripts/audit-skillcode-compat.mjs' }),
    ]),
  }),
  ruleSkillCode: Object.freeze({
    field: 'data/rules/*.json#skillCode',
    functionForm: 'statement body in the Rule skill wrapper',
    authority: true,
    interaction: 'option-only',
    capabilities: Object.freeze([
      'dealDamage', 'healDamage', 'addCardToHand', 'checkToxin', 'addStatusEffectById',
      'removeStatusEffectById', 'addPlayerRuleById', 'removePlayerRuleById',
      'addRuleById', 'removeRuleById', 'addPlayerStatusEffectById',
      'removePlayerStatusEffectById', 'addPlayerSkillById', 'removePlayerSkillById',
      'selectOption', 'fireEvent', 'Math', 'Date',
    ]),
    commandKinds: ruleCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.ruleSkillCode,
    statusSemantics: Object.freeze({
      pieceAdd: 'replace-same-id', playerAdd: 'append', cardIntensityModifier: false,
      pieceAfterStatusApplied: false, pieceAfterStatusRemoved: true,
      playerAfterStatusApplied: false, playerAfterStatusRemoved: false,
      pieceRelatedRuleCleanup: false,
      pieceMissingDurationAndUses: 'default-minus-one', playerMissingDurationAndUses: 'preserve',
    }),
    output: Object.freeze(['status', 'value', 'commands', 'pending', 'diagnostics', 'budgetUsed']),
    pending: 'Only declared option interaction is supported; replay resumes through the authority Rule queue.',
    errors: 'Failure restores Rule trigger limits and rejects the candidate transaction.',
    unsupported: Object.freeze(['selectTarget', 'teleport', 'traceProjectile', 'host references', 'async work']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'loadRuleById' }),
      Object.freeze({ file: 'scripts/audit-skillcode-compat.mjs' }),
    ]),
  }),
  ruleTriggerSkill: Object.freeze({
    field: 'data/rules/*.json#effect.type=triggerSkill',
    functionForm: 'referenced executeSkill(context) with an adapted trigger snapshot',
    authority: true,
    interaction: 'none',
    capabilities: Object.freeze([
      'dealDamage', 'healDamage', 'addStatusEffectById', 'removeStatusEffectById',
      'addRuleById', 'removeRuleById', 'addPlayerRuleById', 'removePlayerRuleById',
      'addPlayerSkillById', 'removePlayerSkillById', 'addPlayerStatusEffectById',
      'removePlayerStatusEffectById', 'addSkillById', 'removeSkillById',
      'addCardToHand', 'discardCard', 'getHand', 'Math', 'Date',
    ]),
    commandKinds: triggerCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.ruleTriggerSkill,
    statusSemantics: Object.freeze({
      pieceAdd: 'append', playerAdd: 'append', cardIntensityModifier: false,
      pieceAfterStatusApplied: false, pieceAfterStatusRemoved: true,
      playerAfterStatusApplied: false, playerAfterStatusRemoved: false,
      pieceRelatedRuleCleanup: false,
      pieceMissingDurationAndUses: 'preserve', playerMissingDurationAndUses: 'preserve',
    }),
    output: Object.freeze(['status', 'value', 'commands', 'diagnostics', 'budgetUsed']),
    pending: 'Not supported in v1; a triggerSkill must finish synchronously with targets already in the event.',
    errors: 'Failure restores trigger counters and rejects the candidate event transaction.',
    unsupported: Object.freeze(['select', 'selectTarget', 'selectOption', 'teleport', 'traceProjectile', 'fireEvent', 'console', 'pending']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'loadRuleById -> executeSkill' }),
      Object.freeze({ file: 'lib/game/rule-loader.ts' }),
    ]),
  }),
  pendingEffectCode: Object.freeze({
    field: 'serialized pending.effectCode',
    functionForm: 'function(ctx)',
    authority: true,
    interaction: 'none',
    capabilities: Object.freeze(['Math', 'Date']),
    commandKinds: noCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.pendingEffectCode,
    statusSemantics: unsupportedStatusSemantics,
    output: Object.freeze(['status', 'value', 'diagnostics', 'budgetUsed']),
    pending: 'A continuation may not create another pending request; depth is counted by the authority replay root.',
    errors: 'Failure rejects the continuation and leaves the authority root state unchanged.',
    unsupported: Object.freeze(['closures', 'all mutation helpers', 'ctx.dealDamage', 'nested pending', 'host references', 'async work']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/turn.ts', symbol: 'pendingTargetSelect' }),
      Object.freeze({ file: 'scripts/audit-skillcode-compat.mjs' }),
    ]),
  }),
  previewCode: Object.freeze({
    field: 'data/skills/*.json#previewCode',
    functionForm: 'function calculatePreview(piece, skillDef, currentCooldown)',
    authority: false,
    interaction: 'none',
    capabilities: Object.freeze(['calculateDistance', 'Math']),
    commandKinds: noCommands,
    input: SKILLCODE_ABI_V1_INPUT_SCHEMAS.previewCode,
    statusSemantics: unsupportedStatusSemantics,
    output: Object.freeze(['status', 'value', 'diagnostics', 'budgetUsed']),
    pending: 'Not supported; preview is a synchronous display-only calculation.',
    errors: 'Failure returns a diagnostic to the caller; it never changes authority state or enables trusted fallback.',
    unsupported: Object.freeze(['all mutation helpers', 'randomness', 'real time', 'pending', 'host references', 'async work']),
    runtimeEvidence: Object.freeze([
      Object.freeze({ file: 'lib/game/skills.ts', symbol: 'calculateSkillPreview' }),
    ]),
  }),
})

export const SKILLCODE_ABI_V1_KNOWN_CAPABILITIES = Object.freeze([
  ...new Set([
    ...Object.values(SKILLCODE_ABI_V1_SURFACES).flatMap(contract => contract.capabilities),
    // Injected by the trusted runtime, but intentionally forbidden in ABI v1.
    'console',
  ]),
].sort())

export type SkillCodeAbiV1Invocation = Readonly<{
  abiVersion: typeof SKILLCODE_ABI_V1
  surface: SkillCodeAbiV1Surface
  content: Readonly<{ id: string; version: string; sourceHash: string }>
  trace: Readonly<{ id: string; seed: string; logicalTime: number }>
  requestedCapabilities: readonly string[]
  input: Readonly<Record<string, unknown>>
}>

export type SkillCodeAbiV1TrustedIdentity = Readonly<{
  content: SkillCodeAbiV1Invocation['content']
  trace: SkillCodeAbiV1Invocation['trace']
}>

export type SkillCodeAbiV1AnswerAuthority = Readonly<{
  cursor: number
  selectionId: string
  replayId: string
  kind: 'target' | 'option'
  choices: readonly string[]
  min: number
  max: number
}>

export type SkillCodeAbiV1Command = Readonly<{
  kind: SkillCodeAbiV1CommandKind
  payload: Readonly<Record<string, unknown>>
}>

export type SkillCodeAbiV1Result = Readonly<{
  abiVersion: typeof SKILLCODE_ABI_V1
  surface: SkillCodeAbiV1Surface
  traceId: string
  status: 'ok' | 'pending' | 'rejected'
  value?: unknown
  commands?: readonly SkillCodeAbiV1Command[]
  pending?: Readonly<{
    kind: 'target' | 'option'
    cursor: number
    payload: Readonly<Record<string, unknown>>
    ownerHandle: string
    authorityRevision: number
    rootTraceId: string
    replayId: string
    replayDepth: number
    content: SkillCodeAbiV1Invocation['content']
  }>
  diagnostics?: readonly Readonly<{ code: SkillCodeAbiV1ErrorCode; message?: string; path?: string }>[]
  budgetUsed: SkillCodeAbiV1Budget
}>

export type SkillCodeAbiV1ResultValidation = Readonly<{
  invocation: SkillCodeAbiV1Invocation
  measuredBudget: SkillCodeAbiV1Budget
  pendingAuthority?: Readonly<{
    ownerHandle: string
    authorityRevision: number
    replayId: string
    cursor: number
    selectionId: string
    kind: 'target' | 'option'
    choices: readonly string[]
    min: number
    max: number
  }>
}>

export class SkillCodeAbiV1Error extends Error {
  constructor(
    public readonly code: SkillCodeAbiV1ErrorCode,
    message: string,
    public readonly path = '$',
  ) {
    super(`${code} at ${path}: ${message}`)
    this.name = 'SkillCodeAbiV1Error'
  }
}

const invocationKeys = ['abiVersion', 'content', 'input', 'requestedCapabilities', 'surface', 'trace'] as const
const resultKeys = ['abiVersion', 'budgetUsed', 'commands', 'diagnostics', 'pending', 'status', 'surface', 'traceId', 'value'] as const
const commandKinds = new Set<string>(SKILLCODE_ABI_V1_COMMAND_KINDS)
const surfaces = new Set<string>(SKILLCODE_ABI_V1_SURFACE_NAMES)
const errorCodes = new Set<string>(SKILLCODE_ABI_V1_ERROR_CODES)
const validatedInvocations = new WeakSet<object>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function fail(code: SkillCodeAbiV1ErrorCode, message: string, path = '$'): never {
  throw new SkillCodeAbiV1Error(code, message, path)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: SkillCodeAbiV1ErrorCode = 'SKILLCODE_INPUT_SCHEMA_INVALID',
) {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', `dangerous object key ${key}`, `${path}.${key}`)
    }
    if (!allowedSet.has(key)) fail(code, `unknown field ${key}`, `${path}.${key}`)
  }
}

function assertJsonBoundary(
  value: unknown,
  path: string,
  seen = new Set<object>(),
  depth = 0,
  schemaCode: SkillCodeAbiV1ErrorCode = 'SKILLCODE_INPUT_SCHEMA_INVALID',
): void {
  if (depth > AUTHORITY_BUDGET.recursionDepth) {
    fail('SKILLCODE_BUDGET_RECURSION_EXCEEDED', `boundary depth exceeds ${AUTHORITY_BUDGET.recursionDepth}`, path)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(schemaCode, 'number must be finite', path)
    return
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'undefined') {
    fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', `unsupported boundary value ${typeof value}`, path)
  }
  if (value instanceof Promise) fail('SKILLCODE_ASYNC_FORBIDDEN', 'Promise cannot cross the ABI boundary', path)
  if (typeof value !== 'object') fail(schemaCode, 'unsupported value', path)
  if (seen.has(value)) fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'cyclic reference', path)
  seen.add(value)
  let descriptors: PropertyDescriptorMap
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'symbol property', path)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'uninspectable host object', path)
  }
  const thenDescriptor = descriptors.then
  if (thenDescriptor && (thenDescriptor.get || typeof thenDescriptor.value === 'function')) {
    fail('SKILLCODE_ASYNC_FORBIDDEN', 'Promise/thenable cannot cross the ABI boundary', path)
  }
  let hasInheritedThen = false
  try {
    const prototype = Object.getPrototypeOf(value)
    const inheritedThen = prototype && Object.getOwnPropertyDescriptor(prototype, 'then')
    hasInheritedThen = Boolean(inheritedThen && (inheritedThen.get || typeof inheritedThen.value === 'function'))
  } catch {
    fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'uninspectable host object', path)
  }
  if (hasInheritedThen) fail('SKILLCODE_ASYNC_FORBIDDEN', 'Promise/thenable cannot cross the ABI boundary', path)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'accessor property', `${path}.${key}`)
    if (!descriptor.enumerable && !(Array.isArray(value) && key === 'length')) {
      fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'non-enumerable property', `${path}.${key}`)
    }
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'non-standard array prototype', path)
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor) fail(schemaCode, 'sparse array is not allowed', `${path}[${index}]`)
      assertJsonBoundary(descriptor.value, `${path}[${index}]`, seen, depth + 1, schemaCode)
    }
  } else {
    if (!isPlainRecord(value)) fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', 'non-plain object/prototype', path)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail('SKILLCODE_HOST_REFERENCE_FORBIDDEN', `dangerous object key ${key}`, `${path}.${key}`)
      }
      assertJsonBoundary(descriptor.value, `${path}.${key}`, seen, depth + 1, schemaCode)
    }
  }
  seen.delete(value)
}

function cloneFrozenJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    const result: unknown[] = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      result[index] = cloneFrozenJson(descriptors[String(index)].value)
    }
    return Object.freeze(result) as T
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) result[key] = cloneFrozenJson(descriptor.value)
  return Object.freeze(result) as T
}

function requireString(
  value: unknown,
  path: string,
  code: SkillCodeAbiV1ErrorCode = 'SKILLCODE_INPUT_SCHEMA_INVALID',
): string {
  if (typeof value !== 'string' || value.length === 0) fail(code, 'non-empty string required', path)
  return value
}

function requireSafeInteger(value: unknown, path: string, code: SkillCodeAbiV1ErrorCode): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(code, 'non-negative safe integer required', path)
  return Number(value)
}

function requireHandle(value: unknown, path: string) {
  requireString(value, path, 'SKILLCODE_INPUT_SCHEMA_INVALID')
  if (String(value).trim() !== value) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'handle must not contain surrounding whitespace', path)
}

function validateDataField(value: unknown, schema: SkillCodeAbiV1DataFieldSchema, path: string) {
  switch (schema.kind) {
    case 'string':
      requireString(value, path)
      break
    case 'handle':
      requireHandle(value, path)
      break
    case 'finite-number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'finite number required', path)
      break
    case 'non-negative-integer':
      requireSafeInteger(value, path, 'SKILLCODE_INPUT_SCHEMA_INVALID')
      break
    case 'handle-array':
      if (!Array.isArray(value) || value.length < schema.minItems) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `at least ${schema.minItems} handles required`, path)
      value.forEach((item, index) => requireHandle(item, `${path}[${index}]`))
      if (new Set(value).size !== value.length) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'duplicate handle', path)
      break
    case 'typed-record':
      if (!isPlainRecord(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'typed record required', path)
      for (const [key, item] of Object.entries(value)) {
        if (key.length === 0) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'typed record key must not be empty', path)
        validateDataField(item, { kind: schema.valueKind } as SkillCodeAbiV1DataFieldSchema, `${path}.${key}`)
      }
      break
  }
}

function validateDataObject(value: unknown, schemaName: SkillCodeAbiV1DataSchemaName, path: string) {
  if (!isPlainRecord(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'schema data must be a plain object', path)
  const schema = SKILLCODE_ABI_V1_DATA_SCHEMAS[schemaName]
  assertExactKeys(value, [...schema.required, ...schema.optional], path)
  for (const key of schema.required) {
    if (!(key in value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `missing field ${key}`, `${path}.${key}`)
  }
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    if (key in value) validateDataField(value[key], fieldSchema, `${path}.${key}`)
  }
}

function validateSnapshotInput(value: unknown, schemaVersion: string, schemaName: SkillCodeAbiV1DataSchemaName, path: string) {
  if (!isPlainRecord(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'snapshot must be a plain object', path)
  assertExactKeys(value, ['data', 'revision', 'schemaVersion'], path)
  if (value.schemaVersion !== schemaVersion) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `expected ${schemaVersion}`, `${path}.schemaVersion`)
  requireSafeInteger(value.revision, `${path}.revision`, 'SKILLCODE_INPUT_SCHEMA_INVALID')
  validateDataObject(value.data, schemaName, `${path}.data`)
}

function validateAnswersInput(value: unknown, maxItems: number, path: string) {
  if (!Array.isArray(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answers must be an array', path)
  if (value.length > maxItems) fail('SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED', `answers exceed ${maxItems}`, path)
  const identities = new Set<string>()
  value.forEach((answer, index) => {
    const answerPath = `${path}[${index}]`
    if (!isPlainRecord(answer)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answer must be a plain object', answerPath)
    assertExactKeys(answer, ['cursor', 'kind', 'replayId', 'selectionId', 'values'], answerPath)
    const cursor = requireSafeInteger(answer.cursor, `${answerPath}.cursor`, 'SKILLCODE_INPUT_SCHEMA_INVALID')
    requireString(answer.selectionId, `${answerPath}.selectionId`)
    requireString(answer.replayId, `${answerPath}.replayId`)
    if (answer.kind !== 'target' && answer.kind !== 'option') fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'invalid answer kind', `${answerPath}.kind`)
    if (!Array.isArray(answer.values)
      || answer.values.some(item => typeof item !== 'string' || item.length === 0)
      || new Set(answer.values).size !== answer.values.length) {
      fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answer values must be a unique string array', `${answerPath}.values`)
    }
    const identity = `${cursor}\u0000${answer.selectionId}\u0000${answer.replayId}`
    if (identities.has(identity)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'duplicate answer identity', answerPath)
    identities.add(identity)
  })
}

function validateAnswerAuthorities(
  value: unknown,
  authorities: readonly SkillCodeAbiV1AnswerAuthority[] | undefined,
  path: string,
) {
  if (!Array.isArray(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answers must be an array', path)
  const trusted = authorities ?? []
  if (value.length !== trusted.length) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answers must match host authority count', path)
  value.forEach((rawAnswer, index) => {
    const answer = rawAnswer as Record<string, unknown>
    const authority = trusted[index]
    const values = answer.values as string[]
    if (answer.cursor !== authority.cursor
      || answer.selectionId !== authority.selectionId
      || answer.replayId !== authority.replayId
      || answer.kind !== authority.kind
      || values.length < authority.min
      || values.length > authority.max
      || values.some(item => !authority.choices.includes(item))) {
      fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'answer does not match host pending authority', `${path}[${index}]`)
    }
  })
}

function validateInputField(value: unknown, schema: SkillCodeAbiV1InputFieldSchema, path: string) {
  switch (schema.kind) {
    case 'snapshot':
      validateSnapshotInput(value, schema.schemaVersion, schema.dataSchema, path)
      break
    case 'payload':
      if (!isPlainRecord(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'payload envelope must be a plain object', path)
      assertExactKeys(value, ['data', 'schemaVersion'], path)
      if (value.schemaVersion !== schema.schemaVersion) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `expected ${schema.schemaVersion}`, `${path}.schemaVersion`)
      validateDataObject(value.data, schema.dataSchema, `${path}.data`)
      break
    case 'handle':
      requireHandle(value, path)
      break
    case 'handle-array':
      if (!Array.isArray(value) || value.length < schema.minItems) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `at least ${schema.minItems} handle required`, path)
      value.forEach((item, index) => requireHandle(item, `${path}[${index}]`))
      if (schema.unique && new Set(value).size !== value.length) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'duplicate handle', path)
      break
    case 'answers':
      validateAnswersInput(value, schema.maxItems, path)
      break
    case 'non-negative-integer':
      requireSafeInteger(value, path, 'SKILLCODE_INPUT_SCHEMA_INVALID')
      break
  }
}

function identityMatches(actual: SkillCodeAbiV1Invocation, expected: SkillCodeAbiV1TrustedIdentity): boolean {
  return actual.content.id === expected.content.id
    && actual.content.version === expected.content.version
    && actual.content.sourceHash === expected.content.sourceHash
    && actual.trace.id === expected.trace.id
    && actual.trace.seed === expected.trace.seed
    && actual.trace.logicalTime === expected.trace.logicalTime
}

export function negotiateSkillCodeAbiV1(value: unknown): typeof SKILLCODE_ABI_V1 {
  if (value === undefined || value === null || value === '') fail('SKILLCODE_ABI_MISSING', 'ABI version is required', '$.abiVersion')
  if (value !== SKILLCODE_ABI_V1) fail('SKILLCODE_ABI_UNSUPPORTED', 'unsupported ABI version', '$.abiVersion')
  return SKILLCODE_ABI_V1
}

export function budgetForSkillCodeAbiV1(surface: SkillCodeAbiV1Surface): SkillCodeAbiV1Budget {
  return surface === 'previewCode' ? PREVIEW_BUDGET : AUTHORITY_BUDGET
}

export function parseSkillCodeAbiV1Invocation(
  value: unknown,
  trustedIdentity?: SkillCodeAbiV1TrustedIdentity,
  trustedAnswers?: readonly SkillCodeAbiV1AnswerAuthority[],
): SkillCodeAbiV1Invocation {
  if (!isPlainRecord(value)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'invocation must be a plain object')
  assertJsonBoundary(value, '$')
  negotiateSkillCodeAbiV1(value.abiVersion)
  if (typeof value.surface !== 'string' || !surfaces.has(value.surface)) {
    fail('SKILLCODE_SURFACE_UNSUPPORTED', 'unsupported surface', '$.surface')
  }
  assertExactKeys(value, invocationKeys, '$')
  const surface = value.surface as SkillCodeAbiV1Surface
  if (!isPlainRecord(value.content)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'content identity required', '$.content')
  assertExactKeys(value.content, ['id', 'sourceHash', 'version'], '$.content')
  requireString(value.content.id, '$.content.id')
  requireString(value.content.version, '$.content.version')
  requireString(value.content.sourceHash, '$.content.sourceHash')
  if (!isPlainRecord(value.trace)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'trace identity required', '$.trace')
  assertExactKeys(value.trace, ['id', 'logicalTime', 'seed'], '$.trace')
  requireString(value.trace.id, '$.trace.id')
  requireString(value.trace.seed, '$.trace.seed')
  if (!Number.isSafeInteger(value.trace.logicalTime) || Number(value.trace.logicalTime) < 0) {
    fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'logicalTime must be a non-negative safe integer', '$.trace.logicalTime')
  }
  if (!isPlainRecord(value.input)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'input snapshot must be a plain object', '$.input')
  const inputSchema = SKILLCODE_ABI_V1_SURFACES[surface].input
  const inputKeys = Object.keys(inputSchema)
  assertExactKeys(value.input, inputKeys, '$.input')
  for (const key of inputKeys) {
    if (!(key in value.input)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', `missing field ${key}`, `$.input.${key}`)
  }
  for (const [key, schema] of Object.entries(inputSchema)) validateInputField(value.input[key], schema, `$.input.${key}`)
  if ('answers' in inputSchema) validateAnswerAuthorities(value.input.answers, trustedAnswers, '$.input.answers')
  if (!trustedIdentity || !identityMatches(value as unknown as SkillCodeAbiV1Invocation, trustedIdentity)) {
    fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'content and trace identity must match host-derived identity', '$.content')
  }
  if (!Array.isArray(value.requestedCapabilities)) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'capability list required', '$.requestedCapabilities')
  const allowed = new Set(SKILLCODE_ABI_V1_SURFACES[surface].capabilities)
  const known = new Set<string>(SKILLCODE_ABI_V1_KNOWN_CAPABILITIES)
  const requested = value.requestedCapabilities.map((capability, index) => requireString(capability, `$.requestedCapabilities[${index}]`))
  if (new Set(requested).size !== requested.length) fail('SKILLCODE_INPUT_SCHEMA_INVALID', 'duplicate capability', '$.requestedCapabilities')
  for (const capability of requested) {
    if (!known.has(capability)) fail('SKILLCODE_CAPABILITY_UNKNOWN', `unknown capability ${capability}`, '$.requestedCapabilities')
    if (!allowed.has(capability)) fail('SKILLCODE_CAPABILITY_DENIED', `${capability} is not allowed for ${surface}`, '$.requestedCapabilities')
  }
  const parsed = cloneFrozenJson(value) as unknown as SkillCodeAbiV1Invocation
  validatedInvocations.add(parsed as object)
  return parsed
}

function utf8Size(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

const numericBudgetKeys: Array<keyof SkillCodeAbiV1Budget> = [
  'fuel', 'memoryBytes', 'outputBytes', 'commandCount', 'recursionDepth',
  'eventChainDepth', 'pendingReplayDepth',
]

const codeByBudgetKey: Record<keyof SkillCodeAbiV1Budget, SkillCodeAbiV1ErrorCode> = {
  fuel: 'SKILLCODE_BUDGET_FUEL_EXCEEDED',
  memoryBytes: 'SKILLCODE_BUDGET_MEMORY_EXCEEDED',
  outputBytes: 'SKILLCODE_BUDGET_OUTPUT_EXCEEDED',
  commandCount: 'SKILLCODE_BUDGET_COMMANDS_EXCEEDED',
  recursionDepth: 'SKILLCODE_BUDGET_RECURSION_EXCEEDED',
  eventChainDepth: 'SKILLCODE_BUDGET_EVENT_CHAIN_EXCEEDED',
  pendingReplayDepth: 'SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED',
}

function validateStatusPayload(value: unknown, path: string) {
  if (!isPlainRecord(value)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'status must be a plain object', path)
  const fields = [...SKILLCODE_ABI_V1_STATUS_FIELDS.required, ...SKILLCODE_ABI_V1_STATUS_FIELDS.optional]
  assertExactKeys(value, fields, path, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  for (const key of SKILLCODE_ABI_V1_STATUS_FIELDS.required) {
    if (!(key in value)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `missing field ${key}`, `${path}.${key}`)
  }
  requireString(value.id, `${path}.id`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  requireString(value.type, `${path}.type`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  for (const key of ['name', 'sourceHandle', 'targetHandle'] as const) {
    if (value[key] !== undefined) requireString(value[key], `${path}.${key}`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  }
  for (const key of ['currentDuration', 'remainingDuration', 'currentUses', 'remainingUses', 'createdTurn'] as const) {
    const field = value[key]
    if (field !== undefined && (!Number.isSafeInteger(field) || Number(field) < -1)) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `${key} must be a safe integer >= -1`, `${path}.${key}`)
    }
  }
  for (const key of ['intensity', 'stacks', 'value', 'extraValue', 'damage'] as const) {
    const field = value[key]
    if (field !== undefined && (typeof field !== 'number' || !Number.isFinite(field))) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `${key} must be finite`, `${path}.${key}`)
    }
  }
  if (value.visible !== undefined && typeof value.visible !== 'boolean') {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'visible must be boolean', `${path}.visible`)
  }
  if (value.relatedRules !== undefined) {
    if (!Array.isArray(value.relatedRules)
      || value.relatedRules.some(rule => typeof rule !== 'string' || rule.length === 0)
      || new Set(value.relatedRules).size !== value.relatedRules.length) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'relatedRules must be a unique string array', `${path}.relatedRules`)
    }
  }
}

function validateCommandPayload(kind: SkillCodeAbiV1CommandKind, payload: Record<string, unknown>, path: string) {
  const schema = SKILLCODE_ABI_V1_COMMAND_SCHEMAS[kind]
  assertExactKeys(payload, [...schema.required, ...schema.optional], path, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  for (const key of schema.required) {
    if (!(key in payload)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `missing field ${key}`, `${path}.${key}`)
  }
  for (const [key, field] of Object.entries(payload)) {
    const fieldPath = `${path}.${key}`
    if (key === 'status') {
      validateStatusPayload(field, fieldPath)
    } else if (key === 'targetHandles') {
      if (!Array.isArray(field) || field.length === 0 || field.some(item => typeof item !== 'string' || item.length === 0)) {
        fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'targetHandles must be a non-empty string array', fieldPath)
      }
      if (new Set(field).size !== field.length) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'duplicate target handle', fieldPath)
    } else if (key === 'amount') {
      if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'amount must be a finite non-negative number', fieldPath)
    } else if (key === 'x' || key === 'y') {
      if (!Number.isSafeInteger(field)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'coordinate must be a safe integer', fieldPath)
    } else if (key === 'context') {
      if (!isPlainRecord(field)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'event context must be a plain object', fieldPath)
    } else if (typeof field !== 'string' || field.length === 0) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'non-empty string required', fieldPath)
    }
  }
}

function validatePendingPayload(kind: 'target' | 'option', payload: Record<string, unknown>, path: string) {
  const listKey = kind === 'target' ? 'candidateHandles' : 'optionIds'
  assertExactKeys(payload, ['selectionId', listKey, 'min', 'max', 'prompt'], path, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  requireString(payload.selectionId, `${path}.selectionId`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  const choices = payload[listKey]
  if (!Array.isArray(choices) || choices.length === 0 || choices.some(choice => typeof choice !== 'string' || choice.length === 0)) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `${listKey} must be a non-empty string array`, `${path}.${listKey}`)
  }
  if (new Set(choices).size !== choices.length) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `duplicate ${listKey}`, `${path}.${listKey}`)
  const min = requireSafeInteger(payload.min, `${path}.min`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  const max = requireSafeInteger(payload.max, `${path}.max`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  if (min > max || max > choices.length) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'invalid selection cardinality', path)
  if (payload.prompt !== undefined && typeof payload.prompt !== 'string') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'prompt must be a string', `${path}.prompt`)
}

function sameStringArray(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function sameContentIdentity(
  value: Record<string, unknown>,
  expected: SkillCodeAbiV1Invocation['content'],
  path: string,
) {
  assertExactKeys(value, ['id', 'sourceHash', 'version'], path, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  if (value.id !== expected.id || value.version !== expected.version || value.sourceHash !== expected.sourceHash) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending content identity does not match root invocation', path)
  }
}

export function parseSkillCodeAbiV1Result(
  value: unknown,
  validation?: SkillCodeAbiV1ResultValidation,
): SkillCodeAbiV1Result {
  if (!isPlainRecord(value)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'result must be a plain object')
  assertJsonBoundary(value, '$', new Set<object>(), 0, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  negotiateSkillCodeAbiV1(value.abiVersion)
  if (typeof value.surface !== 'string' || !surfaces.has(value.surface)) fail('SKILLCODE_SURFACE_UNSUPPORTED', 'invalid surface', '$.surface')
  for (const key of Object.keys(value)) {
    if (!(resultKeys as readonly string[]).includes(key)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `unknown field ${key}`, `$.${key}`)
  }
  if (!validation || !validatedInvocations.has(validation.invocation as object)) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'a host-validated invocation and trusted meter are required', '$validation')
  }
  const surface = value.surface as SkillCodeAbiV1Surface
  if (surface !== validation.invocation.surface) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'surface does not match invocation', '$.surface')
  if (requireString(value.traceId, '$.traceId', 'SKILLCODE_OUTPUT_SCHEMA_INVALID') !== validation.invocation.trace.id) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'traceId does not match invocation', '$.traceId')
  }
  if (value.status !== 'ok' && value.status !== 'pending' && value.status !== 'rejected') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'invalid status', '$.status')

  const commands = value.commands === undefined ? [] : value.commands
  if (!Array.isArray(commands)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'commands must be an array', '$.commands')
  const contract = SKILLCODE_ABI_V1_SURFACES[surface]
  const allowedCommands = new Set<string>(contract.commandKinds)
  const requestedCapabilities = new Set(validation.invocation.requestedCapabilities)
  commands.forEach((command, index) => {
    if (!isPlainRecord(command)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'command must be a plain object', `$.commands[${index}]`)
    assertExactKeys(command, ['kind', 'payload'], `$.commands[${index}]`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    if (typeof command.kind !== 'string' || !commandKinds.has(command.kind)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'unknown command kind', `$.commands[${index}].kind`)
    if (!allowedCommands.has(command.kind)) fail('SKILLCODE_CAPABILITY_DENIED', `${command.kind} is not allowed for ${surface}`, `$.commands[${index}].kind`)
    if (!isPlainRecord(command.payload)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'command payload must be a plain object', `$.commands[${index}].payload`)
    const kind = command.kind as SkillCodeAbiV1CommandKind
    const capability = SKILLCODE_ABI_V1_COMMAND_SCHEMAS[kind].capability
    if (!requestedCapabilities.has(capability)) fail('SKILLCODE_CAPABILITY_DENIED', `${kind} requires requested capability ${capability}`, `$.commands[${index}].kind`)
    validateCommandPayload(kind, command.payload, `$.commands[${index}].payload`)
  })

  if (value.pending !== undefined) {
    if (contract.interaction === 'none') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `pending is unsupported for ${surface}`, '$.pending')
    if (!isPlainRecord(value.pending)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending must be a plain object', '$.pending')
    assertExactKeys(value.pending, ['authorityRevision', 'content', 'cursor', 'kind', 'ownerHandle', 'payload', 'replayDepth', 'replayId', 'rootTraceId'], '$.pending', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    if (value.pending.kind !== 'target' && value.pending.kind !== 'option') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'invalid pending kind', '$.pending.kind')
    if (contract.interaction === 'option-only' && value.pending.kind !== 'option') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'only option pending is supported', '$.pending.kind')
    requireSafeInteger(value.pending.cursor, '$.pending.cursor', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    if (!isPlainRecord(value.pending.payload)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending payload must be a plain object', '$.pending.payload')
    const pendingKind = value.pending.kind as 'target' | 'option'
    validatePendingPayload(pendingKind, value.pending.payload, '$.pending.payload')
    const pendingCapability = pendingKind === 'target' ? 'selectTarget' : 'selectOption'
    if (!requestedCapabilities.has(pendingCapability)) {
      fail('SKILLCODE_CAPABILITY_DENIED', `${pendingKind} pending requires requested capability ${pendingCapability}`, '$.pending.kind')
    }
    requireString(value.pending.ownerHandle, '$.pending.ownerHandle', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    requireSafeInteger(value.pending.authorityRevision, '$.pending.authorityRevision', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    requireString(value.pending.rootTraceId, '$.pending.rootTraceId', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    requireString(value.pending.replayId, '$.pending.replayId', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    requireSafeInteger(value.pending.replayDepth, '$.pending.replayDepth', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    if (!isPlainRecord(value.pending.content)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending content identity required', '$.pending.content')
    sameContentIdentity(value.pending.content, validation.invocation.content, '$.pending.content')
    const authority = validation.pendingAuthority
    const listKey = pendingKind === 'target' ? 'candidateHandles' : 'optionIds'
    if (!authority
      || value.pending.ownerHandle !== authority.ownerHandle
      || value.pending.authorityRevision !== authority.authorityRevision
      || value.pending.replayId !== authority.replayId
      || value.pending.cursor !== authority.cursor
      || value.pending.payload.selectionId !== authority.selectionId
      || pendingKind !== authority.kind
      || !sameStringArray(value.pending.payload[listKey], authority.choices)
      || value.pending.payload.min !== authority.min
      || value.pending.payload.max !== authority.max
      || value.pending.rootTraceId !== validation.invocation.trace.id) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending authority/replay identity mismatch', '$.pending')
    }
  }

  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'diagnostics must be an array', '$.diagnostics')
    value.diagnostics.forEach((diagnostic, index) => {
      if (!isPlainRecord(diagnostic)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'diagnostic must be a plain object', `$.diagnostics[${index}]`)
      assertExactKeys(diagnostic, ['code', 'message', 'path'], `$.diagnostics[${index}]`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
      if (typeof diagnostic.code !== 'string' || !errorCodes.has(diagnostic.code)) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'unknown diagnostic code', `$.diagnostics[${index}].code`)
      if (diagnostic.message !== undefined && typeof diagnostic.message !== 'string') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'diagnostic message must be a string', `$.diagnostics[${index}].message`)
      if (diagnostic.path !== undefined && typeof diagnostic.path !== 'string') fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'diagnostic path must be a string', `$.diagnostics[${index}].path`)
    })
  }

  if (value.status === 'pending' && value.pending === undefined) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending status requires pending data', '$.pending')
  if (value.status !== 'pending' && value.pending !== undefined) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending data requires pending status', '$.pending')
  if (value.status !== 'ok' && commands.length > 0) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending/rejected results cannot carry partial commands', '$.commands')
  const diagnosticCodes = Array.isArray(value.diagnostics)
    ? value.diagnostics.map(diagnostic => (diagnostic as Record<string, unknown>).code)
    : []
  if (value.status === 'rejected') {
    if (!diagnosticCodes.includes('SKILLCODE_TRANSACTION_ROLLED_BACK')
      || !diagnosticCodes.some(code => code !== 'SKILLCODE_TRANSACTION_ROLLED_BACK')) {
      fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'rejected result requires a primary error and rollback diagnostic', '$.diagnostics')
    }
  } else if (diagnosticCodes.includes('SKILLCODE_TRANSACTION_ROLLED_BACK')) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'successful or pending result cannot claim rollback', '$.diagnostics')
  }

  const budget = budgetForSkillCodeAbiV1(surface)
  if (commands.length > budget.commandCount) fail('SKILLCODE_BUDGET_COMMANDS_EXCEEDED', `${commands.length} commands exceeds ${budget.commandCount}`, '$.commands')
  const serializedBytes = utf8Size(value)
  if (serializedBytes > budget.outputBytes) fail('SKILLCODE_BUDGET_OUTPUT_EXCEEDED', `serialized output exceeds ${budget.outputBytes} bytes`)
  if (!isPlainRecord(value.budgetUsed) || !isPlainRecord(validation.measuredBudget)) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'complete result and trusted host budget counters are required', '$.budgetUsed')
  }
  assertExactKeys(value.budgetUsed, numericBudgetKeys, '$.budgetUsed', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  assertExactKeys(validation.measuredBudget as unknown as Record<string, unknown>, numericBudgetKeys, '$validation.measuredBudget', 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  for (const key of numericBudgetKeys) {
    const reported = requireSafeInteger(value.budgetUsed[key], `$.budgetUsed.${key}`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    const measured = requireSafeInteger(validation.measuredBudget[key], `$validation.measuredBudget.${key}`, 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    if (reported !== measured) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', `${key} does not match trusted host meter`, `$.budgetUsed.${key}`)
    if (measured > budget[key]) fail(codeByBudgetKey[key], `${key} exceeds ${budget[key]}`, `$validation.measuredBudget.${key}`)
  }
  if (validation.measuredBudget.commandCount !== commands.length) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'command count does not match output', '$.budgetUsed.commandCount')
  if (validation.measuredBudget.outputBytes !== serializedBytes) fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'output bytes do not match UTF-8 serialized result', '$.budgetUsed.outputBytes')
  if (value.pending !== undefined && validation.measuredBudget.pendingReplayDepth !== value.pending.replayDepth) {
    fail('SKILLCODE_OUTPUT_SCHEMA_INVALID', 'pending replay depth does not match trusted meter', '$.pending.replayDepth')
  }
  return cloneFrozenJson(value) as unknown as SkillCodeAbiV1Result
}
