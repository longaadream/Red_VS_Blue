import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  SKILLCODE_ABI_V1,
  SKILLCODE_ABI_V1_BUDGETS,
  SKILLCODE_ABI_V1_COMMAND_KINDS,
  SKILLCODE_ABI_V1_COMMAND_SCHEMAS,
  SKILLCODE_ABI_V1_DATA_SCHEMAS,
  SKILLCODE_ABI_V1_ERROR_CODES,
  SKILLCODE_ABI_V1_INPUT_SCHEMAS,
  SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS,
  SKILLCODE_ABI_V1_SURFACE_NAMES,
  SKILLCODE_ABI_V1_SURFACES,
  SkillCodeAbiV1Error,
  type SkillCodeAbiV1Budget,
  type SkillCodeAbiV1AnswerAuthority,
  type SkillCodeAbiV1Invocation,
  budgetForSkillCodeAbiV1,
  negotiateSkillCodeAbiV1,
  parseSkillCodeAbiV1Invocation,
  parseSkillCodeAbiV1Result,
} from '../../lib/game/skillcode-runtime/abi-v1'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../..')
const fixtureRoot = path.resolve(testDirectory, '../fixtures/skillcode/v1')

function fixture(group: 'valid' | 'invalid', name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureRoot, group, name), 'utf8'))
}

function expectCode(action: () => unknown, code: string) {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(SkillCodeAbiV1Error)
    expect((error as SkillCodeAbiV1Error).code).toBe(code)
    return
  }
  throw new Error(`Expected ${code}`)
}

function trustedIdentity(value: unknown) {
  const record = value as { content: SkillCodeAbiV1Invocation['content']; trace: SkillCodeAbiV1Invocation['trace'] }
  return { content: record.content, trace: record.trace }
}

function parseInvocation(value: unknown, answers?: readonly SkillCodeAbiV1AnswerAuthority[]): SkillCodeAbiV1Invocation {
  return parseSkillCodeAbiV1Invocation(value, trustedIdentity(value), answers)
}

function measuredResult(
  raw: unknown,
  invocation: SkillCodeAbiV1Invocation,
  overrides: Partial<SkillCodeAbiV1Budget> = {},
  pendingAuthority?: {
    ownerHandle: string
    authorityRevision: number
    replayId: string
    cursor: number
    selectionId: string
    kind: 'target' | 'option'
    choices: readonly string[]
    min: number
    max: number
  },
) {
  const value = structuredClone(raw) as Record<string, unknown>
  const commands = Array.isArray(value.commands) ? value.commands : []
  const existing = (value.budgetUsed ?? {}) as Partial<SkillCodeAbiV1Budget>
  const budgetUsed: { -readonly [K in keyof SkillCodeAbiV1Budget]: number } = {
    fuel: 0,
    memoryBytes: 0,
    outputBytes: 0,
    commandCount: commands.length,
    recursionDepth: 0,
    eventChainDepth: 0,
    pendingReplayDepth: 0,
    ...existing,
    ...overrides,
  }
  value.budgetUsed = budgetUsed
  let size = 0
  do {
    size = new TextEncoder().encode(JSON.stringify(value)).byteLength
    budgetUsed.outputBytes = size
  } while (new TextEncoder().encode(JSON.stringify(value)).byteLength !== size)
  return parseSkillCodeAbiV1Result(value, {
    invocation,
    measuredBudget: { ...budgetUsed },
    pendingAuthority,
  })
}

describe('RED-151 SkillCode ABI v1 version and capability contract', () => {
  it('fail-closes missing and unsupported ABI versions with stable codes', () => {
    expect(negotiateSkillCodeAbiV1(SKILLCODE_ABI_V1)).toBe(SKILLCODE_ABI_V1)
    expectCode(() => parseSkillCodeAbiV1Invocation(fixture('invalid', 'missing-abi.json')), 'SKILLCODE_ABI_MISSING')
    expectCode(() => parseSkillCodeAbiV1Invocation(fixture('invalid', 'unknown-abi.json')), 'SKILLCODE_ABI_UNSUPPORTED')
    expectCode(() => parseSkillCodeAbiV1Invocation({ surface: 'skillCode', unknown: true }), 'SKILLCODE_ABI_MISSING')
  })

  it('accepts one structured fixture for every author surface', () => {
    const files = [
      'skill-code-request.json',
      'card-code-request.json',
      'rule-skill-code-request.json',
      'rule-trigger-skill-request.json',
      'pending-effect-code-request.json',
      'preview-code-request.json',
    ]
    expect(files.map(name => parseInvocation(fixture('valid', name)).surface).sort())
      .toEqual(Object.keys(SKILLCODE_ABI_V1_SURFACES).sort())
  })

  it('rejects unknown fields and capabilities without fallback', () => {
    expectCode(() => parseInvocation(fixture('invalid', 'unknown-field.json')), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation(fixture('invalid', 'unknown-capability.json')), 'SKILLCODE_CAPABILITY_DENIED')
    const base = fixture('valid', 'preview-code-request.json') as Record<string, unknown>
    const unknown = { ...base, requestedCapabilities: ['spawnProcess'] }
    expectCode(() => parseInvocation(unknown), 'SKILLCODE_CAPABILITY_UNKNOWN')
    const forbiddenConsole = { ...base, requestedCapabilities: ['console'] }
    expectCode(() => parseInvocation(forbiddenConsole), 'SKILLCODE_CAPABILITY_DENIED')
  })

  it('keeps the machine-readable whitelist traceable and surface-specific', () => {
    expect(SKILLCODE_ABI_V1_SURFACES.skillCode.capabilities).toContain('selectTarget')
    expect(SKILLCODE_ABI_V1_SURFACES.skillCode.capabilities).toContain('context.forceRemoveEnemyPieceById')
    expect(SKILLCODE_ABI_V1_SURFACES.skillCode.runtimeEvidence)
      .toContainEqual({ file: 'data/skills/obito-space-time.json' })
    expect(SKILLCODE_ABI_V1_SURFACES.cardCode.capabilities).not.toContain('teleport')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.capabilities).toContain('selectOption')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.capabilities).toContain('addSkillById')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.capabilities).toContain('removeSkillById')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.commandKinds).toContain('skill.add')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.commandKinds).toContain('skill.remove')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleTriggerSkill.interaction).toBe('none')
    expect(SKILLCODE_ABI_V1_SURFACES.pendingEffectCode.capabilities).toEqual(['Math', 'Date'])
    expect(SKILLCODE_ABI_V1_SURFACES.previewCode.authority).toBe(false)
    expect(SKILLCODE_ABI_V1_INPUT_SCHEMAS.previewCode.currentCooldown).toEqual({ kind: 'non-negative-integer' })
    expect(SKILLCODE_ABI_V1_SNAPSHOT_VERSIONS.battle).toBe('rvb-battle-snapshot/v1')
    expect(SKILLCODE_ABI_V1_SURFACES.skillCode.statusSemantics).toEqual({
      pieceAdd: 'append', playerAdd: 'append', cardIntensityModifier: false,
      pieceAfterStatusApplied: true, pieceAfterStatusRemoved: true,
      playerAfterStatusApplied: false, playerAfterStatusRemoved: false,
      pieceRelatedRuleCleanup: true,
      pieceMissingDurationAndUses: 'preserve', playerMissingDurationAndUses: 'preserve',
    })
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.statusSemantics.pieceAdd).toBe('replace-same-id')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.statusSemantics.pieceMissingDurationAndUses).toBe('default-minus-one')
    expect(SKILLCODE_ABI_V1_SURFACES.ruleSkillCode.statusSemantics.playerMissingDurationAndUses).toBe('preserve')
    expect(SKILLCODE_ABI_V1_SURFACES.cardCode.statusSemantics.cardIntensityModifier).toBe(true)
    expect(SKILLCODE_ABI_V1_DATA_SCHEMAS.battle.required).toEqual([
      'stateHash', 'turnNumber', 'phase', 'pieceHandles', 'playerHandles',
    ])
    expect(Object.isFrozen(SKILLCODE_ABI_V1_SURFACE_NAMES)).toBe(true)
    expect(Object.isFrozen(SKILLCODE_ABI_V1_ERROR_CODES)).toBe(true)
    expect(Object.isFrozen(SKILLCODE_ABI_V1_COMMAND_KINDS)).toBe(true)
    for (const contract of Object.values(SKILLCODE_ABI_V1_SURFACES)) {
      expect(Object.isFrozen(contract.commandKinds)).toBe(true)
      expect(contract.capabilities).not.toContain('console')
      expect(contract.runtimeEvidence.length).toBeGreaterThan(0)
      expect(contract.runtimeEvidence.every(evidence => evidence.file.length > 0)).toBe(true)
      for (const evidence of contract.runtimeEvidence) {
        expect(existsSync(path.resolve(repositoryRoot, evidence.file)), evidence.file).toBe(true)
      }
      expect(new Set(contract.capabilities).size).toBe(contract.capabilities.length)
    }
  })
})

describe('RED-151 SkillCode ABI v1 structured boundary', () => {
  it('accepts schema-valid commands and pending results', () => {
    const invocation = parseInvocation(fixture('valid', 'skill-code-request.json'))
    expect(measuredResult(fixture('valid', 'skill-code-result.json'), invocation).status).toBe('ok')
    expect(measuredResult(fixture('valid', 'pending-result.json'), invocation, {}, {
      ownerHandle: 'player-1', authorityRevision: 7, replayId: 'replay-skill-0', cursor: 0, selectionId: 'target-0',
      kind: 'target', choices: ['piece-2'], min: 1, max: 1,
    }).status).toBe('pending')
  })

  it('rejects functions, Promises, custom prototypes, cycles, and non-finite values', () => {
    const base = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    const baseInput = base.input as Record<string, unknown>
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: { callback: () => undefined } } }), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: { task: Promise.resolve(1) } } }), 'SKILLCODE_ASYNC_FORBIDDEN')
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: { task: { then: () => undefined } } } }), 'SKILLCODE_ASYNC_FORBIDDEN')
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: { date: new Date(0) } } }), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: { value: Number.NaN } } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: cyclic } }), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')
    const polluted = JSON.parse('{"context":{},"sourcePieceHandle":"piece-1","battleSnapshot":{},"answers":[],"__proto__":{}}')
    expectCode(() => parseInvocation({ ...base, input: polluted }), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')
    let getterRuns = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { getterRuns += 1; return 'host' } })
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, context: accessor } }), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')
    expect(getterRuns).toBe(0)
    const sparse = Array(2)
    sparse[0] = 'answer'
    expectCode(() => parseInvocation({ ...base, input: { ...baseInput, answers: sparse } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
  })

  it('requires exact, surface-specific input fields', () => {
    const base = fixture('valid', 'preview-code-request.json') as Record<string, unknown>
    expectCode(() => parseInvocation({ ...base, input: { pieceSnapshot: {}, skillSnapshot: {} } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({ ...base, input: { pieceSnapshot: {}, skillSnapshot: {}, currentCooldown: 0, battle: {} } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
  })

  it('rejects accessors before executing them across invocation and result boundaries', () => {
    let getterRuns = 0
    const topLevel = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    Object.defineProperty(topLevel, 'abiVersion', {
      enumerable: true,
      get() { getterRuns += 1; return SKILLCODE_ABI_V1 },
    })
    expectCode(() => parseSkillCodeAbiV1Invocation(topLevel), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')

    const nested = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    Object.defineProperty(nested.content as object, 'id', {
      enumerable: true,
      get() { getterRuns += 1; return 'skill-fixture' },
    })
    expectCode(() => parseSkillCodeAbiV1Invocation(nested), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')

    const capability = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    Object.defineProperty(capability.requestedCapabilities as string[], '0', {
      enumerable: true,
      get() { getterRuns += 1; return 'selectTarget' },
    })
    expectCode(() => parseSkillCodeAbiV1Invocation(capability), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')

    const result: Record<string, unknown> = {}
    Object.defineProperty(result, 'status', {
      enumerable: true,
      get() { getterRuns += 1; return 'ok' },
    })
    expectCode(() => parseSkillCodeAbiV1Result(result), 'SKILLCODE_HOST_REFERENCE_FORBIDDEN')

    const coercion = { toString() { getterRuns += 1; return SKILLCODE_ABI_V1 } }
    expectCode(() => negotiateSkillCodeAbiV1(coercion), 'SKILLCODE_ABI_UNSUPPORTED')
    expect(getterRuns).toBe(0)
  })

  it('enforces typed handles, versioned snapshots, cooldowns, payloads, and replay answers', () => {
    const skill = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    const skillInput = skill.input as Record<string, unknown>
    expectCode(() => parseInvocation({ ...skill, input: { ...skillInput, sourcePieceHandle: {} } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({
      ...skill,
      input: { ...skillInput, battleSnapshot: { schemaVersion: 'rvb-battle-snapshot/v2', revision: 7, data: {} } },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({
      ...skill,
      input: { ...skillInput, context: { schemaVersion: 'rvb-context-snapshot/v1', revision: 7 } },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    const tooManyAnswers = Array.from({ length: 9 }, (_, cursor) => ({
      cursor, kind: 'target', replayId: `replay-${cursor}`, selectionId: `selection-${cursor}`, values: ['piece-2'],
    }))
    expectCode(() => parseInvocation({ ...skill, input: { ...skillInput, answers: tooManyAnswers } }), 'SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED')
    expectCode(() => parseInvocation({
      ...skill,
      input: { ...skillInput, answers: [{ cursor: 0, kind: 'target', replayId: 'r', selectionId: 's', values: ['x', 'x'] }] },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')

    const preview = fixture('valid', 'preview-code-request.json') as Record<string, unknown>
    const previewInput = preview.input as Record<string, unknown>
    expectCode(() => parseInvocation({ ...preview, input: { ...previewInput, currentCooldown: '0' } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')

    const pending = fixture('valid', 'pending-effect-code-request.json') as Record<string, unknown>
    const pendingInput = pending.input as Record<string, unknown>
    expectCode(() => parseInvocation({ ...pending, input: { ...pendingInput, targetHandles: [] } }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({
      ...pending,
      input: { ...pendingInput, payload: { schemaVersion: 'rvb-pending-payload/v2', data: {} } },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({
      ...pending,
      input: { ...pendingInput, payload: { schemaVersion: 'rvb-pending-payload/v1', data: { completelyUnknown: true } } },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation({
      ...pending,
      input: {
        ...pendingInput,
        battleSnapshot: { schemaVersion: 'rvb-battle-snapshot/v1', revision: 7, data: { completelyUnknown: true } },
      },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
  })

  it('binds replay answers to host identity, candidates, and selection bounds', () => {
    const raw = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    const input = raw.input as Record<string, unknown>
    const answer = { cursor: 0, kind: 'target', replayId: 'replay-1', selectionId: 'selection-1', values: ['piece-2'] }
    const authority: SkillCodeAbiV1AnswerAuthority = {
      cursor: 0, kind: 'target', replayId: 'replay-1', selectionId: 'selection-1',
      choices: ['piece-2', 'piece-3'], min: 1, max: 1,
    }
    const replay = { ...raw, input: { ...input, answers: [answer] } }
    expect(parseInvocation(replay, [authority]).surface).toBe('skillCode')
    expectCode(() => parseInvocation(replay), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation(replay, [{ ...authority, choices: ['piece-3'] }]), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation(replay, [{ ...authority, cursor: 1 }]), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    expectCode(() => parseInvocation(replay, [{ ...authority, min: 2, max: 2 }]), 'SKILLCODE_INPUT_SCHEMA_INVALID')
  })

  it('denies mutation commands and pending on non-authority surfaces', () => {
    const previewInvocation = parseInvocation(fixture('valid', 'preview-code-request.json'))
    const preview = {
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'previewCode',
      traceId: 'trace-preview',
      status: 'ok',
      commands: [{ kind: 'damage.apply', payload: {} }],
    }
    expectCode(() => measuredResult(preview, previewInvocation), 'SKILLCODE_CAPABILITY_DENIED')
    expectCode(() => measuredResult({ ...preview, commands: [], status: 'pending', pending: { kind: 'target', cursor: 0, payload: {} } }, previewInvocation), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')

    const triggerInvocation = parseInvocation(fixture('valid', 'rule-trigger-skill-request.json'))
    const trigger = {
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'ruleTriggerSkill',
      traceId: 'trace-trigger',
      status: 'pending',
      commands: [],
      pending: { kind: 'target', cursor: 0, payload: {} },
    }
    expectCode(() => measuredResult(trigger, triggerInvocation), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  })

  it('prevents pending or rejected results from carrying partial commands', () => {
    const invocation = parseInvocation(fixture('valid', 'skill-code-request.json'))
    const base = fixture('valid', 'pending-result.json') as Record<string, unknown>
    const commands = (fixture('valid', 'skill-code-result.json') as Record<string, unknown>).commands
    const authority = {
      ownerHandle: 'player-1', authorityRevision: 7, replayId: 'replay-skill-0', cursor: 0, selectionId: 'target-0',
      kind: 'target' as const, choices: ['piece-2'], min: 1, max: 1,
    }
    expectCode(() => measuredResult({ ...base, commands }, invocation, {}, authority), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expectCode(() => measuredResult({ ...base, commands: [], status: 'ok' }, invocation, {}, authority), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  })

  it('binds every command to a requested capability and exact payload schema', () => {
    const raw = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    const invocation = parseInvocation({ ...raw, requestedCapabilities: ['Math'] })
    expectCode(() => measuredResult(fixture('valid', 'skill-code-result.json'), invocation), 'SKILLCODE_CAPABILITY_DENIED')

    const authorized = parseInvocation(raw)
    const result = fixture('valid', 'skill-code-result.json') as Record<string, unknown>
    const commands = [{ kind: 'damage.apply', payload: { sourceHandle: 'piece-1', targetHandles: ['piece-2'], amount: 3 } }]
    expectCode(() => measuredResult({ ...result, commands }, authorized), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expect(SKILLCODE_ABI_V1_COMMAND_SCHEMAS['piece.force-remove'].capability)
      .toBe('context.forceRemoveEnemyPieceById')
    expect(SKILLCODE_ABI_V1_COMMAND_SCHEMAS['card.discard'].required).toEqual(['cardInstanceHandle'])

    const statusInvocation = parseInvocation({ ...raw, requestedCapabilities: ['addStatusEffectById'] })
    const statusCommand = {
      kind: 'status.add',
      payload: {
        ownerHandle: 'piece-1',
        status: { id: 'frozen-1', type: 'freeze', currentDuration: 1, intensity: 1, relatedRules: ['rule-freeze'] },
      },
    }
    expect(measuredResult({ ...result, commands: [statusCommand] }, statusInvocation).status).toBe('ok')
    expectCode(() => measuredResult({
      ...result,
      commands: [{ ...statusCommand, payload: { ...statusCommand.payload, status: { id: 'x', type: 'freeze', extension: true } } }],
    }, statusInvocation), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  })

  it('requires host-derived identity, trusted complete metering, and matching result identity', () => {
    const raw = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    expectCode(() => parseSkillCodeAbiV1Invocation(raw, {
      ...trustedIdentity(raw),
      trace: { ...(raw.trace as SkillCodeAbiV1Invocation['trace']), seed: 'forged' },
    }), 'SKILLCODE_INPUT_SCHEMA_INVALID')
    const invocation = parseInvocation(raw)
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(Object.isFrozen(invocation.input)).toBe(true)
    const result = fixture('valid', 'skill-code-result.json') as Record<string, unknown>
    expectCode(() => parseSkillCodeAbiV1Result(result), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expectCode(() => measuredResult({ ...result, traceId: 'other-trace' }, invocation), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expect(Object.isFrozen(measuredResult(result, invocation))).toBe(true)

    const prepared = structuredClone(result) as Record<string, unknown>
    const budgetUsed = prepared.budgetUsed as { -readonly [K in keyof SkillCodeAbiV1Budget]: number }
    budgetUsed.outputBytes = new TextEncoder().encode(JSON.stringify(prepared)).byteLength
    expectCode(() => parseSkillCodeAbiV1Result(prepared, {
      invocation,
      measuredBudget: { ...budgetUsed, fuel: budgetUsed.fuel + 1 },
    }), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
  })

  it('requires pending replay identity and rejected rollback diagnostics', () => {
    const invocation = parseInvocation(fixture('valid', 'skill-code-request.json'))
    const pending = fixture('valid', 'pending-result.json')
    const authority = {
      ownerHandle: 'player-1', authorityRevision: 7, replayId: 'replay-skill-0', cursor: 0, selectionId: 'target-0',
      kind: 'target' as const, choices: ['piece-2'], min: 1, max: 1,
    }
    expectCode(() => measuredResult(pending, invocation, {}, {
      ownerHandle: 'other-player', authorityRevision: 7, replayId: 'replay-skill-0', cursor: 0, selectionId: 'target-0',
      kind: 'target', choices: ['piece-2'], min: 1, max: 1,
    }), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expectCode(() => measuredResult(pending, invocation, {}, { ...authority, cursor: 1 }), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expectCode(() => measuredResult(pending, invocation, {}, { ...authority, choices: ['piece-3'] }), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    const limitedRaw = fixture('valid', 'skill-code-request.json') as Record<string, unknown>
    const limited = parseInvocation({ ...limitedRaw, requestedCapabilities: ['Math'] })
    expectCode(() => measuredResult(pending, limited, {}, authority), 'SKILLCODE_CAPABILITY_DENIED')

    const rejected = {
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'skillCode',
      traceId: 'trace-skill',
      status: 'rejected',
      commands: [],
      diagnostics: [{ code: 'SKILLCODE_EXECUTION_FAILED' }],
    }
    expectCode(() => measuredResult(rejected, invocation), 'SKILLCODE_OUTPUT_SCHEMA_INVALID')
    expect(measuredResult({
      ...rejected,
      diagnostics: [
        { code: 'SKILLCODE_EXECUTION_FAILED' },
        { code: 'SKILLCODE_TRANSACTION_ROLLED_BACK' },
      ],
    }, invocation).status).toBe('rejected')
  })
})

describe('RED-151 approved resource budgets', () => {
  it('freezes authority and preview measurements at the approved values', () => {
    expect(SKILLCODE_ABI_V1_BUDGETS.authority).toEqual({
      fuel: 100_000,
      memoryBytes: 16 * 1024 * 1024,
      outputBytes: 64 * 1024,
      commandCount: 256,
      recursionDepth: 64,
      eventChainDepth: 32,
      pendingReplayDepth: 8,
    })
    expect(budgetForSkillCodeAbiV1('previewCode')).toEqual({
      fuel: 20_000,
      memoryBytes: 4 * 1024 * 1024,
      outputBytes: 16 * 1024,
      commandCount: 0,
      recursionDepth: 64,
      eventChainDepth: 32,
      pendingReplayDepth: 8,
    })
  })

  it.each([
    ['fuel', 100_001, 'SKILLCODE_BUDGET_FUEL_EXCEEDED'],
    ['memoryBytes', 16 * 1024 * 1024 + 1, 'SKILLCODE_BUDGET_MEMORY_EXCEEDED'],
    ['recursionDepth', 65, 'SKILLCODE_BUDGET_RECURSION_EXCEEDED'],
    ['eventChainDepth', 33, 'SKILLCODE_BUDGET_EVENT_CHAIN_EXCEEDED'],
    ['pendingReplayDepth', 9, 'SKILLCODE_BUDGET_PENDING_REPLAY_EXCEEDED'],
  ] as const)('reports stable %s boundary errors', (key, used, code) => {
    const invocation = parseInvocation(fixture('valid', 'skill-code-request.json'))
    expectCode(() => measuredResult({
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'skillCode',
      traceId: 'trace-skill',
      status: 'ok',
      commands: [],
    }, invocation, { [key]: used }), code)
  })

  it('rejects command and serialized output amplification', () => {
    const invocation = parseInvocation(fixture('valid', 'skill-code-request.json'))
    const command = { kind: 'damage.apply', payload: { sourceHandle: 'piece-1', targetHandles: ['piece-2'], amount: 1, damageType: 'physical' } }
    expectCode(() => measuredResult({
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'skillCode',
      traceId: 'trace-skill',
      status: 'ok',
      commands: Array.from({ length: 257 }, () => command),
    }, invocation), 'SKILLCODE_BUDGET_COMMANDS_EXCEEDED')

    const previewInvocation = parseInvocation(fixture('valid', 'preview-code-request.json'))
    expectCode(() => measuredResult({
      abiVersion: SKILLCODE_ABI_V1,
      surface: 'previewCode',
      traceId: 'trace-preview',
      status: 'ok',
      value: 'x'.repeat(17 * 1024),
    }, previewInvocation), 'SKILLCODE_BUDGET_OUTPUT_EXCEEDED')
  })

  it('keeps every contract error code unique and stable', () => {
    expect(new Set(SKILLCODE_ABI_V1_ERROR_CODES).size).toBe(SKILLCODE_ABI_V1_ERROR_CODES.length)
  })
})
