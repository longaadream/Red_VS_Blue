import { describe, expect, it, vi } from 'vitest'

import { BattleRuleError } from '@/lib/game/battle-types'
import {
  DEFAULT_EFFECT_CHAIN_LIMITS,
  EFFECT_BATCH_KINDS,
  EffectChainFatalError,
  createDamageQueueWriter,
  createDeclaredSummonQueueWriter,
  createEffectChain,
  createHealQueueWriter,
  createSummonQueueWriter,
  getActiveEffectChain,
  installEffectChain,
  isEffectChainFatalError,
  uninstallEffectChain,
  withEffectChain,
  type DamageRequest,
  type EffectChainOptions,
  type EffectHandlers,
  type EffectRequest,
  type HealRequest,
  type SummonRequest,
} from '@/lib/game/effect-batch'
import type { PieceInstance } from '@/lib/game/piece'
import { SuspendableActionPending } from '@/lib/game/suspendable-action-transaction'
import { makePiece } from '../helpers/minimal-state'

const SOURCE_MIRROR_CAPABILITY = {
  version: 1,
  recipe: 'source-mirror',
  maxSummons: 1,
  allowedVariants: ['summon', 'teleport'],
  instanceIdPrefix: 'mirror-',
  maxHp: 1,
  attack: 0,
  defense: 0,
  moveRange: 0,
  noKillCharge: true,
  resetBoundSkillCooldown: true,
  rules: ['fixture-rule'],
  status: {
    idPrefix: 'mirror-tag-',
    name: 'Mirror',
    type: 'mirror',
    visible: false,
    remainingDuration: -1,
    remainingUses: -1,
    intensity: 1,
    stacks: 1,
    relatedRules: ['fixture-rule'],
  },
} as const

const STORED_PIECE_CAPABILITY = {
  version: 1,
  recipe: 'stored-or-declared-piece',
  maxSummons: 1,
  storageExtensionKey: 'storedUniquePiece',
  uniqueTemplateId: 'unique-piece',
  fallback: {
    instanceIdPrefix: 'unique-piece-',
    templateId: 'unique-piece',
    name: 'Unique Piece',
    faction: 'red',
    maxHp: 10,
    attack: 2,
    defense: 1,
    moveRange: 3,
    skills: [{ skillId: 'unique-piece-skill', level: 1, currentCooldown: 0 }],
  },
} as const

// @ts-expect-error ADR-0022 intentionally rejects non-whitelisted effect kinds.
const forbiddenKind: EffectRequest = { kind: 'move' }
void forbiddenKind

const forbiddenCallback: SummonRequest = {
  kind: 'summon',
  contentId: 'internal:template',
  summons: [],
  // @ts-expect-error Summon requests cannot inject an arbitrary callback.
  callback: () => undefined,
}
void forbiddenCallback

type Results = {
  damage: string
  heal: string
  summon: string
  death: string
}

function piece(instanceId: string, currentHp = 10): PieceInstance {
  return makePiece({ instanceId, currentHp, maxHp: 10 }) as unknown as PieceInstance
}

function damage(attacker: PieceInstance, target: PieceInstance): DamageRequest {
  return {
    kind: 'damage',
    attacker,
    targets: [target],
    baseDamage: 1,
    damageType: 'physical',
    skillId: 'core-test',
  }
}

function heal(healer: PieceInstance, target: PieceInstance): HealRequest {
  return {
    kind: 'heal',
    healer,
    targets: [target],
    baseHeal: 1,
    skillId: 'core-test',
  }
}

function noOpHandlers(order: string[] = []): EffectHandlers<Results> {
  return {
    damage: (_request, context) => {
      order.push('damage')
      return context.batchId
    },
    heal: (_request, context) => {
      order.push('heal')
      return context.batchId
    },
    summon: (_request, context) => {
      order.push('summon')
      return context.batchId
    },
    death: (_request, context) => {
      order.push('death')
      return context.batchId
    },
  }
}

function chain(overrides: Partial<EffectChainOptions> = {}) {
  return createEffectChain({
    actionId: 'action-red-139',
    chainId: 'chain-red-139',
    turn: 7,
    rootSeed: 139,
    ...overrides,
  })
}

function fatalSignal(): EffectChainFatalError {
  return new EffectChainFatalError(
    'RVB_EFFECT_CHAIN_STATE_INVALID',
    'first-signal probe',
    {
      actionId: 'action-red-139',
      chainId: 'chain-red-139',
      kind: null,
      depth: null,
      processed: 0,
      limit: 100,
      turn: 7,
      rootSeed: 139,
      detached: false,
      budget: 'state',
    },
  )
}

function pendingSignal(consumerId = 'first-signal-probe'): SuspendableActionPending {
  return new SuspendableActionPending(
    {
      consumerKind: 'rule',
      consumerId,
      eventType: 'red139FirstSignalProbe',
      consumerOrdinal: 0,
    },
    {
      kind: 'option',
      playerId: 'player-red',
      title: 'Continue?',
      options: ['continue'],
      canCancel: false,
    },
  )
}

describe('RED-139 EffectChain core scheduler', () => {
  it('freezes the whitelist and default action budgets', () => {
    expect(EFFECT_BATCH_KINDS).toEqual(['damage', 'heal', 'summon', 'death'])
    expect(DEFAULT_EFFECT_CHAIN_LIMITS).toEqual({
      maxDepth: 20,
      maxBatches: 100,
      maxDispatches: 1000,
    })

    expect(() => chain({ limits: { maxDepth: 21 } })).toThrow(BattleRuleError)
    expect(() => chain({ limits: { maxBatches: 101 } })).toThrow(BattleRuleError)
    expect(() => chain({ limits: { maxDispatches: 1001 } })).toThrow(BattleRuleError)
  })

  it('keeps the first control signal across fatal and pending kinds', () => {
    const pendingFirst = chain()
    const pending = pendingSignal()
    expect(pendingFirst.latchPending(pending)).toBe(pending)
    expect(() => pendingFirst.latchFatal(fatalSignal())).toThrow(pending)
    expect(() => pendingFirst.assertHealthy()).toThrow(pending)

    const fatalFirst = chain()
    const fatal = fatalSignal()
    expect(fatalFirst.latchFatal(fatal)).toBe(fatal)
    expect(() => fatalFirst.latchPending(pendingSignal())).toThrow(fatal)
    expect(() => fatalFirst.assertHealthy()).toThrow(fatal)
  })

  it('restores enqueueMany before relatching an exact pending signal', () => {
    const effectChain = chain()
    const pending = pendingSignal('enqueue-many-pending')
    const checkpoint = effectChain.snapshot()
    const request = new Proxy(damage(piece('attacker'), piece('target')), {
      get: (target, key, receiver) => {
        if (key === 'kind') {
          effectChain.latchPending(pending)
          throw new Error('enqueueMany getter failed after pending')
        }
        return Reflect.get(target, key, receiver)
      },
    })

    let caught: unknown
    try {
      effectChain.enqueueMany([request])
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(pending)
    expect(() => effectChain.assertHealthy()).toThrow(pending)
    expect(effectChain.pendingCount).toBe(0)
    expect(effectChain.processedBatches).toBe(0)
    expect(effectChain.processedDispatches).toBe(0)
    effectChain.acknowledgePending(pending)
    expect(effectChain.snapshot()).toEqual(checkpoint)
  })

  it('restores a writer checkpoint before relatching an exact pending signal', () => {
    const effectChain = chain()
    const writer = createDamageQueueWriter(effectChain)
    const pending = pendingSignal('writer-pending')
    const checkpoint = effectChain.snapshot()
    const attacker = piece('attacker')
    const target = piece('target')
    const input = new Proxy({
      attacker,
      target,
      damage: 1,
      damageType: 'true' as const,
      skillId: 'writer-pending-probe',
    }, {
      get: (value, key, receiver) => {
        if (key === 'target') {
          effectChain.latchPending(pending)
          throw new Error('writer getter failed after pending')
        }
        return Reflect.get(value, key, receiver)
      },
    })

    let caught: unknown
    try {
      writer.push(input)
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(pending)
    expect(() => effectChain.assertHealthy()).toThrow(pending)
    expect(effectChain.pendingCount).toBe(0)
    expect(effectChain.processedBatches).toBe(0)
    expect(effectChain.processedDispatches).toBe(0)
    effectChain.acknowledgePending(pending)
    expect(effectChain.snapshot()).toEqual(checkpoint)
  })

  it('restores FIFO and counters before relatching a drain-time pending signal', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const pending = pendingSignal('drain-pending')
    const effectChain = chain({
      createBatchId: metadata => {
        if (metadata.batchSequence === 1) {
          throw new Error('second batch ID failed after pending')
        }
        return `${metadata.chainId}:${metadata.kind}:${metadata.batchSequence}`
      },
    })
    effectChain.enqueue(damage(attacker, target))
    effectChain.enqueue(heal(attacker, target))

    let caught: unknown
    try {
      effectChain.drain({
        ...noOpHandlers(),
        damage: (_request, context, active) => {
          active.latchPending(pending)
          return context.batchId
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(pending)
    expect(() => effectChain.assertHealthy()).toThrow(pending)
    expect(effectChain.state).toBe('idle')
    expect(effectChain.pendingCount).toBe(2)
    expect(effectChain.processedBatches).toBe(0)
    expect(effectChain.processedDispatches).toBe(0)
    expect(effectChain.snapshot()).toMatchObject({
      nextEnqueueSequence: 2,
      nextBatchSequence: 0,
      ledger: [{ kind: 'damage' }, { kind: 'heal' }],
      pendingSignal: pending,
    })
    expect(effectChain.records.map(record => record.type)).toEqual([
      'enqueue',
      'enqueue',
      'batch:start',
      'batch:finish',
    ])
  })

  it('keeps a handler pending ahead of a later batch-finally failure', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const pending = pendingSignal('batch-finally-pending')
    const effectChain = chain()
    effectChain.enqueue(damage(attacker, target))

    let caught: unknown
    try {
      effectChain.drain({
        ...noOpHandlers(),
        damage: (_request, _context, active) => {
          active.latchPending(pending)
          ;(active as any).batchStack = []
          throw pending
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(pending)
    expect(() => effectChain.assertHealthy()).toThrow(pending)
    expect(effectChain.state).toBe('idle')
    expect(effectChain.pendingCount).toBe(1)
    expect(effectChain.processedBatches).toBe(0)
    expect(effectChain.processedDispatches).toBe(0)
  })


  it('rejects a stored unique-piece capability that declares more than one summon', () => {
    const effectChain = chain()
    const before = effectChain.snapshot()
    let caught: any

    try {
      createDeclaredSummonQueueWriter(effectChain, 'stored-unique-probe', {
        ...STORED_PIECE_CAPABILITY,
        maxSummons: 2,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY',
      context: expect.objectContaining({ kind: 'summon', skillId: 'stored-unique-probe' }),
    })
    expect(caught.cause?.message).toContain('maxSummons must be exactly 1')
    expect(effectChain.snapshot()).toEqual(before)
  })
  it('rejects an unknown kind before ID allocation or scheduler mutation', () => {
    const createBatchId = vi.fn(() => 'should-not-run')
    const effectChain = chain({ createBatchId })
    const before = effectChain.snapshot()

    let caught: unknown
    try {
      effectChain.enqueue({ kind: 'teleport' } as never)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(caught).toBeInstanceOf(BattleRuleError)
    expect(isEffectChainFatalError(caught)).toBe(true)
    expect((caught as EffectChainFatalError).code).toBe('RVB_EFFECT_CHAIN_UNKNOWN_KIND')
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'action-red-139',
      chainId: 'chain-red-139',
      kind: 'teleport',
      processed: 0,
      turn: 7,
      rootSeed: 139,
      detached: false,
      budget: 'kind',
    })
    expect(createBatchId).not.toHaveBeenCalled()
    expect(effectChain.snapshot()).toEqual(before)
  })

  it('uses one FIFO ledger across kinds and binds child parent/depth at writer creation', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const effectChain = chain()
    effectChain.enqueue(damage(attacker, target))
    effectChain.enqueue({
      kind: 'summon',
      contentId: 'internal:template',
      summons: [],
      sourceId: attacker.instanceId,
    })

    const order: string[] = []
    const handlers: EffectHandlers<Results> = {
      ...noOpHandlers(order),
      damage: (_request, context, active) => {
        order.push('damage')
        const writer = createHealQueueWriter(active)
        writer.push({ healer: attacker, target, heal: 2, skillId: 'queued-heal' })
        expect(active.currentBatch).toBe(context)
        return context.batchId
      },
    }

    const executions = effectChain.drain(handlers)
    expect(order).toEqual(['damage', 'summon', 'heal'])
    expect(executions.map(item => item.kind)).toEqual(['damage', 'summon', 'heal'])
    expect(executions.map(item => item.context.enqueueSequence)).toEqual([0, 1, 2])
    expect(executions[2].context).toMatchObject({
      batchId: 'chain-red-139:heal:2',
      parentBatchId: 'chain-red-139:damage:0',
      depth: 1,
    })
    expect(effectChain.processedBatches).toBe(3)
    expect(effectChain.processedDispatches).toBe(3)
    expect(effectChain.pendingCount).toBe(0)
    expect(effectChain.state).toBe('idle')
  })

  it('runs an endogenous DeathBatch before queued FIFO children with explicit origin metadata', () => {
    const attacker = piece('attacker')
    const target = piece('target', 0)
    const effectChain = chain()
    effectChain.enqueue(damage(attacker, target))

    const order: string[] = []
    let deathContext: unknown
    const handlers: EffectHandlers<Results> = {
      ...noOpHandlers(),
      damage: (_request, context, active) => {
        order.push('damage:start')
        active.runEndogenousDeath(
          {
            kind: 'death',
            candidates: [{ piece: target, attacker, skillId: 'lethal-hit' }],
          },
          'damage:death',
          (_death, nested) => {
            order.push('death')
            deathContext = nested
            return nested.batchId
          },
        )
        createHealQueueWriter(active).push({ healer: attacker, target: attacker, heal: 1 })
        order.push('damage:end')
        return context.batchId
      },
      heal: (_request, context) => {
        order.push('heal')
        return context.batchId
      },
    }

    effectChain.drain(handlers)
    expect(order).toEqual(['damage:start', 'death', 'damage:end', 'heal'])
    expect(deathContext).toMatchObject({
      batchId: 'chain-red-139:death:1',
      parentBatchId: 'chain-red-139:damage:0',
      depth: 1,
      originStage: 'damage:death',
      enqueueSequence: undefined,
    })
    expect(effectChain.processedBatches).toBe(3)
    expect(effectChain.records.filter(record => record.type === 'batch:start').map(record => record.kind))
      .toEqual(['damage', 'death', 'heal'])
  })

  it('enforces the shared depth and batch budgets and rolls scheduler state back on failure', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const depthChain = chain()

    let depthError: unknown
    try {
      depthChain.enqueue(heal(attacker, target), { depth: 21 })
    } catch (error) {
      depthError = error
    }
    expect(depthError).toBeInstanceOf(EffectChainFatalError)
    expect((depthError as EffectChainFatalError).context).toMatchObject({
      kind: 'heal',
      depth: 21,
      processed: 21,
      limit: 20,
      sourceId: 'attacker',
      targetId: 'target',
      budget: 'depth',
    })
    expect(depthChain.pendingCount).toBe(0)

    const batchChain = chain({ limits: { maxBatches: 2 } })
    batchChain.enqueue(damage(attacker, target))
    batchChain.enqueue(heal(attacker, target))
    batchChain.enqueue({
      kind: 'summon',
      contentId: 'internal:template',
      summons: [],
      sourceId: attacker.instanceId,
    })

    let batchError: unknown
    try {
      batchChain.drain(noOpHandlers())
    } catch (error) {
      batchError = error
    }
    expect(batchError).toBeInstanceOf(EffectChainFatalError)
    expect((batchError as EffectChainFatalError).context).toMatchObject({
      batchId: 'chain-red-139:summon:2',
      kind: 'summon',
      processed: 3,
      limit: 2,
      budget: 'batches',
      enqueueSequence: 2,
    })
    expect(batchChain.state).toBe('idle')
    expect(batchChain.processedBatches).toBe(0)
    expect(batchChain.processedDispatches).toBe(0)
    expect(batchChain.pendingCount).toBe(3)
  })

  it('counts batch handlers and trigger dispatches against one 1000-dispatch budget', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const effectChain = chain({ limits: { maxDispatches: 2 } })
    effectChain.enqueue(damage(attacker, target))

    const handlers: EffectHandlers<Results> = {
      ...noOpHandlers(),
      damage: (_request, context, active) => {
        active.recordDispatch({
          kind: 'damage',
          sourceId: attacker.instanceId,
          skillId: 'dispatch-loop',
          targetId: target.instanceId,
        }, 2)
        return context.batchId
      },
    }

    let caught: unknown
    try {
      effectChain.drain(handlers)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      batchId: 'chain-red-139:damage:0',
      kind: 'damage',
      processed: 3,
      limit: 2,
      sourceId: 'attacker',
      skillId: 'dispatch-loop',
      targetId: 'target',
      budget: 'dispatches',
    })
    expect(effectChain.processedDispatches).toBe(0)
    expect(effectChain.pendingCount).toBe(1)
  })

  it('fails direct facade reentry with the current batch diagnostics', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const effectChain = chain()
    effectChain.enqueue(damage(attacker, target))

    const handlers: EffectHandlers<Results> = {
      ...noOpHandlers(),
      damage: (_request, context, active) => {
        active.assertFacadeAllowed('heal', {
          sourceId: attacker.instanceId,
          skillId: 'illegal-direct-heal',
          targetId: target.instanceId,
        })
        return context.batchId
      },
    }

    expect(() => effectChain.drain(handlers)).toThrow(
      expect.objectContaining({
        code: 'RVB_EFFECT_CHAIN_REENTRANT',
        context: expect.objectContaining({
          batchId: 'chain-red-139:damage:0',
          kind: 'heal',
          depth: 0,
          sourceId: 'attacker',
          targetId: 'target',
        }),
      }),
    )
    expect(effectChain.pendingCount).toBe(1)
    expect(effectChain.processedBatches).toBe(0)
  })

  it('snapshots and restores ledger, counters, recorder, and deterministic sequences', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const effectChain = chain()
    const first = effectChain.enqueue(damage(attacker, target))
    const checkpoint = effectChain.snapshot()

    effectChain.enqueue(heal(attacker, target))
    effectChain.recordDispatch({}, 2)
    effectChain.restore(checkpoint)
    const replacement = effectChain.enqueue({
      kind: 'summon',
      contentId: 'internal:template',
      summons: [],
    })

    expect(first.enqueueSequence).toBe(0)
    expect(replacement.enqueueSequence).toBe(1)
    expect(effectChain.processedDispatches).toBe(0)
    expect(effectChain.records.filter(record => record.type === 'enqueue')).toHaveLength(2)

    const order: string[] = []
    const executions = effectChain.drain(noOpHandlers(order))
    expect(order).toEqual(['damage', 'summon'])
    expect(executions.map(item => item.context.batchId)).toEqual([
      'chain-red-139:damage:0',
      'chain-red-139:summon:1',
    ])

    const other = chain({ chainId: 'other-chain' })
    expect(() => other.restore(checkpoint)).toThrow(
      expect.objectContaining({ code: 'RVB_EFFECT_CHAIN_SNAPSHOT_INVALID' }),
    )
  })

  it('distinguishes detached chains and includes complete fatal metadata', () => {
    const attacker = piece('source')
    const target = piece('target')
    const detached = chain({ detached: true })

    let caught: unknown
    try {
      detached.enqueue(damage(attacker, target), { depth: 21, parentBatchId: 'parent-batch' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toEqual(expect.objectContaining({
      actionId: 'action-red-139',
      chainId: 'chain-red-139',
      parentBatchId: 'parent-batch',
      kind: 'damage',
      depth: 21,
      processed: 21,
      limit: 20,
      turn: 7,
      rootSeed: 139,
      sourceId: 'source',
      skillId: 'core-test',
      targetId: 'target',
      targetIds: ['target'],
      detached: true,
    }))
    expect(isEffectChainFatalError({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_DEPTH_LIMIT',
      context: {},
    })).toBe(true)
  })

  it('binds a frozen summon declaration and rejects call-time recipe injection', () => {
    const effectChain = chain()
    const writer = createDeclaredSummonQueueWriter(
      effectChain,
      'fixture-summon',
      SOURCE_MIRROR_CAPABILITY,
    )
    const before = effectChain.snapshot()

    let caught: unknown
    try {
      writer.push({
      sourceId: 'source',
      summons: [{
        x: 1,
        y: 2,
        variant: 'summon',
        recipe: 'injected',
      }],
      } as never)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY' })
    expect(effectChain.snapshot()).toEqual(before)


    let repeated: unknown
    try {
      writer.push({
        sourceId: 'source',
        summons: [{ x: 1, y: 2, variant: 'summon' }],
      })
    } catch (error) {
      repeated = error
    }
    expect(repeated).toBe(caught)

    const freshChain = chain()
    const freshWriter = createDeclaredSummonQueueWriter(
      freshChain,
      'fixture-summon',
      SOURCE_MIRROR_CAPABILITY,
    )
    freshWriter.push({
      sourceId: 'source',
      summons: [{ x: 1, y: 2, variant: 'summon' }],
    })
    let captured: SummonRequest | undefined
    freshChain.drain({
      damage: () => undefined,
      heal: () => undefined,
      summon: request => {
        captured = request
      },
      death: () => undefined,
    })
    expect(captured).toMatchObject({
      contentId: 'fixture-summon',
      skillId: 'fixture-summon',
      sourceId: 'source',
      summons: [{ x: 1, y: 2, variant: 'summon' }],
    })
    expect(Object.isFrozen(captured?.capability)).toBe(true)
    expect(Object.isFrozen(
      (captured?.capability as typeof SOURCE_MIRROR_CAPABILITY).rules,
    )).toBe(true)
  })

  it.each([
    ['null summons', { summons: null, sourceId: 'source' }],
    ['non-array summons', { summons: { x: 1, y: 2 }, sourceId: 'source' }],
    ['null summon spec', { summons: [null], sourceId: 'source' }],
  ])('rejects malformed declared summon input with structured fatal diagnostics: %s', (_label, input) => {
    const effectChain = chain()
    const writer = createDeclaredSummonQueueWriter(
      effectChain,
      'fixture-summon',
      SOURCE_MIRROR_CAPABILITY,
    )
    const before = effectChain.snapshot()

    let caught: unknown
    try {
      writer.push(input as never)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect(isEffectChainFatalError(caught)).toBe(true)
    expect((caught as EffectChainFatalError).code).toMatch(/^RVB_EFFECT_CHAIN_/)
    expect((caught as EffectChainFatalError).context).toEqual(expect.objectContaining({
      actionId: 'action-red-139',
      chainId: 'chain-red-139',
      kind: 'summon',
      depth: 0,
      processed: 0,
      turn: 7,
      rootSeed: 139,
      sourceId: 'source',
      skillId: 'fixture-summon',
      detached: false,
      budget: 'binding',
    }))
    expect(effectChain.snapshot()).toEqual(before)
  })

  it('rejects malformed capability metadata before exposing a writer', () => {
    const effectChain = chain()
    const before = effectChain.snapshot()
    const declaration = {
      ...SOURCE_MIRROR_CAPABILITY,
      rules: ['fixture-rule'],
      status: {
        ...SOURCE_MIRROR_CAPABILITY.status,
        relatedRules: ['different-rule'],
      },
    }

    expect(() => createDeclaredSummonQueueWriter(
      effectChain,
      'fixture-summon',
      declaration,
    )).toThrow(expect.objectContaining({
      code: 'RVB_EFFECT_CHAIN_SUMMON_CAPABILITY',
      context: expect.objectContaining({
        kind: 'summon',
        skillId: 'fixture-summon',
        budget: 'binding',
      }),
    }))
    expect(effectChain.snapshot()).toEqual(before)
  })

  it('installs and safely uninstalls transient chains without deleting a different chain', () => {
    const scope = {}
    const first = chain({ chainId: 'first' })
    const second = chain({ chainId: 'second' })
    const cleanup = installEffectChain(scope, first)

    expect(getActiveEffectChain(scope)).toBe(first)
    uninstallEffectChain(scope, second)
    expect(getActiveEffectChain(scope)).toBe(first)
    expect(() => installEffectChain(scope, second)).toThrow(BattleRuleError)

    cleanup()
    expect(getActiveEffectChain(scope)).toBeUndefined()
    uninstallEffectChain(scope)

    expect(() => withEffectChain(scope, second, () => {
      expect(getActiveEffectChain(scope)).toBe(second)
      throw new Error('stop')
    })).toThrow('stop')
    expect(getActiveEffectChain(scope)).toBeUndefined()
  })

  it('keeps the current damageQueue push shape while writing the shared ledger', () => {
    const attacker = piece('attacker')
    const target = piece('target')
    const effectChain = chain()
    const writer = createDamageQueueWriter(effectChain)

    expect(writer.push({
      attacker,
      target,
      damage: 3,
      damageType: 'magical',
      skillId: 'queued-damage',
      killerPlayerId: 'player-red',
    })).toBe(1)

    const [execution] = effectChain.drain(noOpHandlers())
    expect(execution.request).toMatchObject({
      kind: 'damage',
      attacker,
      targets: [target],
      baseDamage: 3,
      damageType: 'magical',
      skillId: 'queued-damage',
      killerPlayerId: 'player-red',
    })
  })
})
