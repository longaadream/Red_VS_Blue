/* eslint-disable @typescript-eslint/no-explicit-any -- RED-139 exercises data-driven template and trigger fixtures */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import {
  createEffectChain,
  withEffectChain,
  type EffectChain,
  type SummonRequest,
  type TemplateSummonSpec,
} from '@/lib/game/effect-batch'
import {
  RANDOM_STREAM_NAMES,
  RuleRuntime,
  getRuleDate,
  getRuleMath,
  withRuleRuntime,
} from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import {
  createTemplateSummonBatchHandler,
  summonPiece,
  type TemplateSummonBatchDependencies,
  type TemplateSummonBatchResult,
} from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

type TemplateFixture = {
  id: string
  name: string
  rules?: string[]
  initialStatusTags?: Array<Record<string, unknown>>
}

function createPiece(
  template: TemplateFixture,
  ownerPlayerId: string,
  faction: TemplateSummonSpec['faction'],
  x: number,
  y: number,
  index: number,
) {
  return {
    ...makePiece({
      instanceId: template.id + '-instance-' + String(index),
      templateId: template.id,
      ownerPlayerId: ownerPlayerId as any,
      faction: faction as any,
      x,
      y,
      rules: [],
      statusTags: [],
    }),
    name: template.name,
    skills: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
  } as any
}

function executeTemplateBatch(
  state: any,
  summons: readonly TemplateSummonSpec[],
  templates: Record<string, TemplateFixture>,
  chainId = 'red139-template-chain',
): { result: TemplateSummonBatchResult; chain: EffectChain } {
  const chain = createEffectChain({
    actionId: 'red139-template-action',
    chainId,
    turn: state.turn.turnNumber,
    rootSeed: 139,
  })
  const request: SummonRequest = {
    kind: 'summon',
    contentId: 'internal:template',
    summons,
  }
  const dependencies: TemplateSummonBatchDependencies<TemplateFixture> = {
    getPieceById: id => templates[id],
    createPieceInstance: createPiece,
  }
  chain.enqueue(request)
  const executions = withEffectChain(state, chain, () => chain.drain({
    damage: () => {
      throw new Error('unexpected damage batch')
    },
    heal: () => {
      throw new Error('unexpected heal batch')
    },
    summon: createTemplateSummonBatchHandler(state, dependencies),
    death: () => {
      throw new Error('unexpected death batch')
    },
  }))
  return {
    result: executions[0].result as TemplateSummonBatchResult,
    chain,
  }
}

function eventRule(
  id: string,
  type: string,
  effect: (
    battle: any,
    context: any,
  ) => { success?: boolean; message?: string; blocked?: boolean } | void,
) {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => ({
      success: true,
      ...(effect(battle, context) ?? {}),
    }),
  }
}

function runTemplateFacade(
  state: any,
  options: any,
  templates: Record<string, TemplateFixture>,
  factory: TemplateSummonBatchDependencies<TemplateFixture>['createPieceInstance'] = createPiece,
) {
  return summonPiece(
    state,
    options,
    id => templates[id],
    factory as any,
  ) as any
}

describe('RED-139 internal template SummonBatch handler', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('commits all complete pieces before stable after events and aligns results to input', () => {
    const state = makeState({ pieces: [] }) as any
    const afterSnapshots: any[] = []
    globalTriggerSystem.addRule(eventRule(
      'red139-template-after-observer',
      'afterPieceSummoned',
      (battle, context) => {
        afterSnapshots.push({
          subject: context.sourcePiece.instanceId,
          batchId: context.effectBatchId,
          chainId: context.effectChainId,
          parentBatchId: context.parentEffectBatchId,
          depth: context.effectDepth,
          hasDamageWriter: typeof context.damageQueue?.push === 'function',
          hasHealWriter: typeof context.healQueue?.push === 'function',
          hasDeathWriter: Object.prototype.hasOwnProperty.call(context, 'deathQueue'),
          hasGenericWriter: Object.prototype.hasOwnProperty.call(context, 'effectQueue'),
          pieces: battle.pieces.map((piece: any) => ({
            id: piece.instanceId,
            rules: piece.rules.map((rule: any) => rule.id).sort(),
            statuses: piece.statusTags.map((status: any) => status.id).sort(),
          })).sort((left: any, right: any) => left.id.localeCompare(right.id)),
        })
      },
    ) as any)

    const { result } = executeTemplateBatch(state, [
      {
        recipe: 'template',
        templateId: 'summon-beta',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 2,
        y: 1,
        index: 1,
      },
      {
        recipe: 'template',
        templateId: 'summon-alpha',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 1,
        y: 1,
        index: 1,
      },
    ], {
      'summon-alpha': {
        id: 'summon-alpha',
        name: 'Alpha',
        rules: ['rule-naruto-clone-immobile'],
        initialStatusTags: [{ id: 'alpha-ready', type: 'ready' }],
      },
      'summon-beta': {
        id: 'summon-beta',
        name: 'Beta',
        rules: ['rule-naruto-clone-one-hit'],
        initialStatusTags: [{ id: 'beta-ready', type: 'ready' }],
      },
    })

    expect(result.success).toBe(true)
    expect(result.results.map(entry => entry.piece?.instanceId)).toEqual([
      'summon-beta-instance-1',
      'summon-alpha-instance-1',
    ])
    expect(result.results).toEqual(result.results.map((entry, inputIndex) => expect.objectContaining({
      success: true,
      inputIndex,
      batchId: result.batchId,
      chainId: result.chainId,
      parentBatchId: undefined,
      depth: 0,
    })))
    expect(afterSnapshots.map(snapshot => snapshot.subject)).toEqual([
      'summon-alpha-instance-1',
      'summon-beta-instance-1',
    ])
    expect(afterSnapshots).toHaveLength(2)
    for (const snapshot of afterSnapshots) {
      expect(snapshot).toMatchObject({
        batchId: result.batchId,
        chainId: result.chainId,
        parentBatchId: undefined,
        depth: 0,
        hasDamageWriter: true,
        hasHealWriter: true,
        hasDeathWriter: false,
        hasGenericWriter: false,
        pieces: [
          {
            id: 'summon-alpha-instance-1',
            rules: ['rule-naruto-clone-immobile'],
            statuses: ['alpha-ready'],
          },
          {
            id: 'summon-beta-instance-1',
            rules: ['rule-naruto-clone-one-hit'],
            statuses: ['beta-ready'],
          },
        ],
      })
    }
  })

  it.each([
    {
      name: 'same-cell reservation',
      pieces: [],
      summons: [
        { recipe: 'template', templateId: 'summon-alpha', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 },
        { recipe: 'template', templateId: 'summon-beta', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 },
      ],
      message: /reserved/i,
    },
    {
      name: 'active occupancy',
      pieces: [makePiece({ instanceId: 'occupant', x: 1, y: 1 })],
      summons: [
        { recipe: 'template', templateId: 'summon-alpha', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 1 },
      ],
      message: /occupied/i,
    },
  ] as const)('rejects $name before factory or before events and leaves state unchanged', ({
    pieces,
    summons,
    message,
  }) => {
    const state = makeState({ pieces: [...pieces] as any }) as any
    const beforeHash = hashBattleState(state)
    const beforeEvents: string[] = []
    const factory = vi.fn(createPiece)
    globalTriggerSystem.addRule(eventRule(
      'red139-template-before-invalid-observer',
      'beforePieceSummoned',
      () => {
        beforeEvents.push('before')
      },
    ) as any)
    const chain = createEffectChain({
      actionId: 'red139-template-invalid',
      chainId: 'red139-template-invalid-chain',
      turn: 1,
      rootSeed: 139,
    })
    const request: SummonRequest = {
      kind: 'summon',
      contentId: 'internal:template',
      summons: summons as readonly TemplateSummonSpec[],
    }
    chain.enqueue(request)

    expect(() => withEffectChain(state, chain, () => chain.drain({
      damage: () => undefined,
      heal: () => undefined,
      summon: createTemplateSummonBatchHandler(state, {
        getPieceById: id => ({ id, name: id, rules: [] }),
        createPieceInstance: factory,
      }),
      death: () => undefined,
    }))).toThrow(message)
    expect(factory).not.toHaveBeenCalled()
    expect(beforeEvents).toEqual([])
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it('revalidates every rewritten position together and rolls back all before effects on conflict', () => {
    const state = makeState({ pieces: [] }) as any
    const beforeHash = hashBattleState(state)
    const events: string[] = []
    globalTriggerSystem.addRule(eventRule(
      'red139-template-reposition-conflict',
      'beforePieceSummoned',
      (battle, context) => {
        events.push(context.pieceTemplateId)
        battle.actions.push({
          type: 'triggerEffect',
          playerId: 'player-red',
          turn: 1,
          payload: { message: 'prepare-side-effect' },
        })
        if (context.pieceTemplateId === 'summon-beta') {
          context.targetPosition = { x: 1, y: 1 }
        }
      },
    ) as any)

    expect(() => executeTemplateBatch(state, [
      {
        recipe: 'template',
        templateId: 'summon-alpha',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 1,
        y: 1,
      },
      {
        recipe: 'template',
        templateId: 'summon-beta',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 2,
        y: 1,
      },
    ], {
      'summon-alpha': { id: 'summon-alpha', name: 'Alpha', rules: [] },
      'summon-beta': { id: 'summon-beta', name: 'Beta', rules: [] },
    })).toThrow(/reserved/i)

    expect(events).toEqual(['summon-alpha', 'summon-beta'])
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(state.pieces).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('returns a blocked result from an authoritative idle summon facade instead of failing the root action', () => {
    const state = makeState({ pieces: [] }) as any
    const chain = createEffectChain({
      actionId: 'red139-template-attached-blocked',
      chainId: 'red139-template-attached-blocked-chain',
      turn: state.turn.turnNumber,
      rootSeed: 139,
    })
    globalTriggerSystem.addRule(eventRule(
      'red139-template-authoritative-block',
      'beforePieceSummoned',
      () => ({ blocked: true, message: 'authoritative template block' }),
    ) as any)

    let result: any
    expect(() => {
      result = withEffectChain(state, chain, () => runTemplateFacade(
        state,
        {
          templateId: 'summon-alpha',
          ownerPlayerId: 'player-red',
          faction: 'red',
          x: 1,
          y: 1,
        },
        { 'summon-alpha': { id: 'summon-alpha', name: 'Alpha', rules: [] } },
      ))
    }).not.toThrow()

    expect(result).toMatchObject({
      success: false,
      blocked: true,
      message: 'authoritative template block',
    })
    expect(state.pieces).toEqual([])
    expect(chain.state).toBe('idle')
    expect(chain.pendingCount).toBe(0)
  })

  it.each(['invalid', 'blocked'] as const)(
    'keeps an explicitly installed detached chain compatible for %s summons',
    mode => {
      const state = makeState({ pieces: [] }) as any
      const chain = createEffectChain({
        actionId: 'red139-template-active-detached-' + mode,
        chainId: 'red139-template-active-detached-' + mode + '-chain',
        turn: state.turn.turnNumber,
        rootSeed: 139,
        detached: true,
      })
      if (mode === 'blocked') {
        globalTriggerSystem.addRule(eventRule(
          'red139-template-detached-block',
          'beforePieceSummoned',
          () => ({ blocked: true, message: 'detached template block' }),
        ) as any)
      }

      let result: any
      expect(() => {
        result = withEffectChain(state, chain, () => runTemplateFacade(
          state,
          {
            templateId: 'summon-alpha',
            ownerPlayerId: 'player-red',
            faction: 'red',
            x: mode === 'invalid' ? 99 : 1,
            y: 1,
          },
          { 'summon-alpha': { id: 'summon-alpha', name: 'Alpha', rules: [] } },
        ))
      }).not.toThrow()

      expect(result).toMatchObject({ success: false })
      if (mode === 'blocked') expect(result).toMatchObject({ blocked: true })
      expect(state.pieces).toEqual([])
      expect(chain.state).toBe('idle')
    },
  )

  it('rolls back blocked Prepare effects without replacing existing battle object identities', () => {
    const existingPiece = makePiece({
      instanceId: 'identity-piece',
      ownerPlayerId: 'player-red',
      faction: 'red',
      x: 0,
      y: 0,
    }) as any
    const state = makeState({ pieces: [existingPiece] }) as any
    const existingPlayer = state.players.find((player: any) => player.playerId === 'player-red')
    const pieces = state.pieces
    const players = state.players
    const actions = state.actions
    const map = state.map
    const tiles = state.map.tiles
    const skills = existingPiece.skills
    const statuses = existingPiece.statusTags
    const pieceRules = existingPiece.rules
    const hand = existingPlayer.hand
    const playerRules = existingPlayer.rules
    const beforeHash = hashBattleState(state)
    globalTriggerSystem.addRule(eventRule(
      'red139-template-blocked-identity',
      'beforePieceSummoned',
      battle => {
        battle.pieces[0].currentHp -= 1
        battle.pieces[0].statusTags.push({ id: 'prepare-only-status', type: 'test' })
        battle.players[0].hand.push({ cardId: 'prepare-only-card', instanceId: 'prepare-only-card-1' })
        battle.actions.push({
          type: 'triggerEffect',
          playerId: 'player-red',
          turn: battle.turn.turnNumber,
          payload: { message: 'prepare-only-action' },
        })
        return { blocked: true, message: 'identity-preserving block' }
      },
    ) as any)

    const result = runTemplateFacade(
      state,
      {
        templateId: 'summon-alpha',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 1,
        y: 1,
      },
      { 'summon-alpha': { id: 'summon-alpha', name: 'Alpha', rules: [] } },
    )

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(state.pieces).toBe(pieces)
    expect(state.players).toBe(players)
    expect(state.actions).toBe(actions)
    expect(state.map).toBe(map)
    expect(state.map.tiles).toBe(tiles)
    expect(state.pieces[0]).toBe(existingPiece)
    expect(state.players[0]).toBe(existingPlayer)
    expect(existingPiece.skills).toBe(skills)
    expect(existingPiece.statusTags).toBe(statuses)
    expect(existingPiece.rules).toBe(pieceRules)
    expect(existingPlayer.hand).toBe(hand)
    expect(existingPlayer.rules).toBe(playerRules)
    expect(existingPiece.currentHp).toBe(existingPiece.maxHp)
    expect(existingPiece.statusTags).toEqual([])
    expect(existingPlayer.hand).toEqual([])
    expect(state.actions).toEqual([])
  })

  it('restores RuleRuntime RNG and clock checkpoints when an authoritative idle summon is blocked', () => {
    const state = makeState({ pieces: [] }) as any
    const chain = createEffectChain({
      actionId: 'red139-template-runtime-blocked',
      chainId: 'red139-template-runtime-blocked-chain',
      turn: state.turn.turnNumber,
      rootSeed: 139,
    })
    const runtime = new RuleRuntime({ rootSeed: 139, tick: 7 })
    globalTriggerSystem.addRule(eventRule(
      'red139-template-runtime-consumer',
      'beforePieceSummoned',
      () => {
        getRuleMath().random()
        getRuleDate().now()
        return { blocked: true, message: 'runtime checkpoint block' }
      },
    ) as any)
    const runtimeFactory: TemplateSummonBatchDependencies<TemplateFixture>['createPieceInstance'] = (...args) => {
      getRuleMath().random()
      getRuleDate().now()
      return createPiece(...args)
    }

    let result: any
    withRuleRuntime(runtime, () => {
      result = withEffectChain(state, chain, () => runTemplateFacade(
        state,
        {
          templateId: 'summon-alpha',
          ownerPlayerId: 'player-red',
          faction: 'red',
          x: 1,
          y: 1,
        },
        { 'summon-alpha': { id: 'summon-alpha', name: 'Alpha', rules: [] } },
        runtimeFactory,
      ))
    })

    expect(result).toMatchObject({ success: false, blocked: true })
    expect(runtime.getCursor(RANDOM_STREAM_NAMES.skillEffect)).toBe(0)
    expect(runtime.clock.snapshot()).toBe(0)
    expect(runtime.snapshot().lastRandomAccess).toBeUndefined()
  })

})
