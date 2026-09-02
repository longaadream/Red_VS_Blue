/* eslint-disable @typescript-eslint/no-explicit-any -- RED-139 exercises data-driven rule and content surfaces */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { hashBattleState } from '@/lib/game/battle-trace'
import {
  createEffectChain,
  createDeclaredSummonQueueWriter,
  createInternalDeathQueueWriter,
  createSummonQueueWriter,
  EffectChainFatalError,
  getActiveEffectChain,
  withEffectChain,
} from '@/lib/game/effect-batch'
import {
  clearCardCache,
  clearRuleCache,
  clearSkillDefinitionCache,
  dealDamage,
  drainBattleEffectChain,
  loadRuleById,
} from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { summonPiece } from '@/lib/game/turn'
import { makePiece, makeState, makeTile } from '../helpers/minimal-state'

type SummonOptions = {
  templateId: string
  faction: 'red' | 'blue'
  ownerPlayerId: string
  x: number
  y: number
  index?: number
}

type TemplateFixture = {
  id: string
  name: string
  rules: string[]
  statusTags?: any[]
}

function eventRule(
  id: string,
  type: string,
  effect: (battle: any, context: any) => { success?: boolean; message?: string; blocked?: boolean } | void,
) {
  return {
    id,
    name: id,
    description: '',
    trigger: { type },
    effect: (battle: any, context: any) => ({ success: true, ...(effect(battle, context) ?? {}) }),
  }
}

function withTemporaryRuleProfile<T>(ruleId: string, execute: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red139-summon-rule-'))
  cpSync(resolve(process.cwd(), 'data'), join(root, 'data'), { recursive: true })
  writeFileSync(
    join(root, 'data', 'rules', `${ruleId}.json`),
    JSON.stringify({
      id: ruleId,
      name: ruleId,
      description: '',
      trigger: { type: 'beforePieceSummoned' },
      skillCode: "context.targetPosition = { x: 3, y: 2 }; return { success: true };",
    }),
    'utf8',
  )
  const previousProfileRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  clearCardCache()
  clearSkillDefinitionCache()
  try {
    return execute()
  } finally {
    clearRuleCache()
    clearCardCache()
    clearSkillDefinitionCache()
    if (previousProfileRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousProfileRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function template(id: string, rules: string[] = [], statusTags: any[] = []): TemplateFixture {
  return { id, name: id, rules, statusTags }
}

function createFixturePiece(
  definition: TemplateFixture,
  ownerPlayerId: string,
  faction: 'red' | 'blue',
  x: number,
  y: number,
  index: number,
) {
  return {
    ...makePiece({
      instanceId: definition.id + '-instance-' + index,
      templateId: definition.id,
      ownerPlayerId: ownerPlayerId as any,
      faction,
      x,
      y,
      rules: [],
      statusTags: structuredClone(definition.statusTags ?? []),
    }),
    name: definition.name,
    skills: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
  } as any
}

function runTemplateSummon(
  state: any,
  options: SummonOptions[],
  templates: Record<string, TemplateFixture>,
  createPieceInstance: typeof createFixturePiece = createFixturePiece,
) {
  return (summonPiece as any)(
    state,
    options,
    (id: string) => templates[id] ?? null,
    createPieceInstance,
  ) as any
}

function deathSubjectId(context: any): string {
  return context.type === 'afterPieceKilled'
    ? context.targetPiece.instanceId
    : context.sourcePiece.instanceId
}

function makeDemonSummonState() {
  const anchor = makePiece({
    instanceId: 'demon-anchor',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 20,
    maxHp: 20,
    attack: 3,
  }) as any
  const state = makeState({ pieces: [anchor], currentPlayerId: 'player-red', phase: 'action' }) as any
  const red = state.players.find((player: any) => player.playerId === 'player-red')
  red.hand = [{ cardId: 'demon-summon-5', instanceId: 'red139-card-5', actionPointCost: 3 }]
  red.discardPile = []
  red.actionPoints = 3
  state.extensions.kiljaedanPiece = {
    ...makePiece({
      instanceId: 'red139-kiljaedan-hidden',
      templateId: 'kiljaedan',
      ownerPlayerId: 'player-red',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      x: 0,
      y: 0,
    }),
    name: 'Kiljaedan',
    defense: 3,
    moveRange: 4,
    skills: [
      { skillId: 'kiljaedan-demonic-pact', level: 1, currentCooldown: 0 },
      { skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 },
      { skillId: 'kiljaedan-soul-drain', level: 1, currentCooldown: 0 },
    ],
    displaySkills: [],
    rules: [],
    statusTags: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
  }
  return { state, anchor, red }
}

function prepareDemonSummonAction(state: any, clientActionId: string) {
  const draft = {
    type: 'playCard' as const,
    playerId: 'player-red',
    cardInstanceId: 'red139-card-5',
    clientActionId,
  }
  const prepared = prepareAction(state, draft as any)
  if (prepared.kind !== 'needTarget') {
    throw new Error('Expected demon summon target preparation, received ' + prepared.kind)
  }
  return {
    ...draft,
    targetPieceId: 'demon-anchor',
    targetX: 0,
    targetY: 0,
    extraTargets: [{ x: 2, y: 2 }],
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

describe('RED-139 SummonBatch', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it.each([
    {
      name: 'same-cell reservation',
      options: [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
      ],
      message: /reserved|same cell|occupied|保留|同一|占用/i,
    },
    {
      name: 'active-piece occupancy',
      options: [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 0, y: 0 },
      ],
      message: /occupied|占用/i,
    },
    {
      name: 'unwalkable terrain',
      options: [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 2, y: 2 },
      ],
      message: /walkable|terrain|不可行走/i,
    },
    {
      name: 'out-of-bounds position',
      options: [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 99, y: 99 },
      ],
      message: /bounds|outside|map|越界|地图|不存在/i,
    },
    {
      name: 'duplicate request',
      options: [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
      ],
      message: /duplicate|重复/i,
    },
  ] as const)('rejects $name before prepare and leaves the whole batch untouched', ({ options, message }) => {
    const occupant = makePiece({ instanceId: 'occupied-piece', x: 0, y: 0 }) as any
    const state = makeState({ pieces: [occupant], width: 3, height: 3 }) as any
    state.map.tiles = state.map.tiles.map((tile: any) => (
      tile.x === 2 && tile.y === 2 ? makeTile(2, 2, false) : tile
    ))
    const beforeHash = hashBattleState(state)
    const beforeEvents: string[] = []
    const createPieceInstance = vi.fn(createFixturePiece)
    globalTriggerSystem.addRule(eventRule('red139-observe-invalid-before', 'beforePieceSummoned', () => {
      beforeEvents.push('before')
    }) as any)

    const result = runTemplateSummon(state, [...options], {
      'summon-alpha': template('summon-alpha'),
      'summon-beta': template('summon-beta'),
    }, createPieceInstance)

    expect(result).toMatchObject({ success: false })
    expect(result.message).toMatch(message)
    expect(result.results).toHaveLength(options.length)
    expect(createPieceInstance).not.toHaveBeenCalled()
    expect(beforeEvents).toEqual([])
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it('commits every complete instance before any stable afterPieceSummoned event', () => {
    const state = makeState({ pieces: [] }) as any
    const afterSnapshots: any[] = []
    globalTriggerSystem.addRule(eventRule('red139-observe-summon-commit', 'afterPieceSummoned', (battle, context) => {
      afterSnapshots.push({
        subject: context.sourcePiece.instanceId,
        pieces: battle.pieces.map((piece: any) => ({
          id: piece.instanceId,
          rules: (piece.rules ?? []).map((rule: any) => rule.id).sort(),
          statuses: (piece.statusTags ?? []).map((status: any) => status.id).sort(),
        })).sort((left: any, right: any) => left.id.localeCompare(right.id)),
      })
    }) as any)

    const result = runTemplateSummon(state, [
      { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 2, y: 1, index: 1 },
      { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1, index: 1 },
    ], {
      'summon-alpha': template(
        'summon-alpha',
        ['rule-naruto-clone-immobile'],
        [{ id: 'alpha-ready', type: 'ready', intensity: 1 }],
      ),
      'summon-beta': template(
        'summon-beta',
        ['rule-naruto-clone-one-hit'],
        [{ id: 'beta-ready', type: 'ready', intensity: 1 }],
      ),
    })

    expect(result.success).toBe(true)
    expect(result.results.map((entry: any) => entry.piece.instanceId)).toEqual([
      'summon-beta-instance-1',
      'summon-alpha-instance-1',
    ])
    expect(afterSnapshots.map(snapshot => snapshot.subject)).toEqual([
      'summon-alpha-instance-1',
      'summon-beta-instance-1',
    ])
    expect(afterSnapshots).toHaveLength(2)
    for (const snapshot of afterSnapshots) {
      expect(snapshot.pieces).toEqual([
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
      ])
    }
  })

  it('maps results to input order while canonical state and batch IDs ignore input permutation', () => {
    const run = (reverse: boolean) => {
      const state = makeState({ pieces: [] }) as any
      const options = [
        { templateId: 'summon-alpha', faction: 'red' as const, ownerPlayerId: 'player-red', x: 1, y: 1, index: 1 },
        { templateId: 'summon-beta', faction: 'red' as const, ownerPlayerId: 'player-red', x: 2, y: 1, index: 1 },
      ]
      const ordered = reverse ? [...options].reverse() : options
      const result = runTemplateSummon(state, ordered, {
        'summon-alpha': template('summon-alpha'),
        'summon-beta': template('summon-beta'),
      })
      return { state, result, hash: hashBattleState(state) }
    }

    const forward = run(false)
    const reverse = run(true)

    expect(forward.result.results.map((entry: any) => entry.piece.instanceId)).toEqual([
      'summon-alpha-instance-1',
      'summon-beta-instance-1',
    ])
    expect(reverse.result.results.map((entry: any) => entry.piece.instanceId)).toEqual([
      'summon-beta-instance-1',
      'summon-alpha-instance-1',
    ])
    expect(reverse.result.batchId).toBe(forward.result.batchId)
    expect(reverse.result.chainId).toBe(forward.result.chainId)
    expect(reverse.hash).toBe(forward.hash)
    expect(reverse.state).toEqual(forward.state)
  })

  it('throws a structured fatal error for an invalid batch attached to an authoritative chain', () => {
    const state = makeState({ pieces: [], width: 3, height: 3 }) as any
    const beforeHash = hashBattleState(state)
    const chain = createEffectChain({
      actionId: 'red139-attached-invalid',
      chainId: 'red139-attached-chain',
      turn: 1,
      rootSeed: 139,
    })
    let thrown: any

    try {
      withEffectChain(state, chain, () => runTemplateSummon(state, [
        { templateId: 'summon-alpha', faction: 'red', ownerPlayerId: 'player-red', x: 1, y: 1 },
        { templateId: 'summon-beta', faction: 'red', ownerPlayerId: 'player-red', x: 99, y: 99 },
      ], {
        'summon-alpha': template('summon-alpha'),
        'summon-beta': template('summon-beta'),
      }))
    } catch (error) {
      thrown = error
    }

    expect(thrown?.name).toBe('EffectChainFatalError')
    expect(thrown?.code).toMatch(/^RVB_EFFECT_CHAIN_/)
    expect(thrown?.context).toMatchObject({
      actionId: 'red139-attached-invalid',
      chainId: 'red139-attached-chain',
      kind: 'summon',
      depth: 0,
      turn: 1,
      rootSeed: 139,
    })
    expect(thrown.context.batchId).toEqual(expect.any(String))
    expect(thrown.context).toHaveProperty('parentBatchId')
    expect(hashBattleState(state)).toBe(beforeHash)
  })

  it.each(['blocked', 'invalid-position'] as const)(
    'fails queued %s summons closed and rolls back the real demon card root action',
    mode => {
      const { state, anchor, red } = makeDemonSummonState()
      const action = prepareDemonSummonAction(state, 'red139-queued-' + mode)
      const beforeHash = hashBattleState(state)
      const events: string[] = []
      globalTriggerSystem.addRule(eventRule('red139-' + mode, 'beforePieceSummoned', (_battle, context) => {
        events.push(context.type)
        if (mode === 'blocked') return { blocked: true, message: 'RED-139 blocked summon' }
        context.targetPosition = { x: 99, y: 99 }
        context.targetX = 99
        context.targetY = 99
      }) as any)
      let thrown: any

      try {
        runBattleAction(state, action as any, { rootSeed: 13905 })
      } catch (error) {
        thrown = error
      }

      expect(thrown?.name).toBe('EffectChainFatalError')
      expect(thrown?.code).toMatch(/^RVB_EFFECT_CHAIN_/)
      expect(thrown?.context).toMatchObject({
        actionId: 'red139-queued-' + mode,
        kind: 'summon',
        depth: 0,
        turn: 1,
        rootSeed: 13905,
      })
      expect(thrown.context.chainId).toEqual(expect.any(String))
      expect(thrown.context.batchId).toEqual(expect.any(String))
      expect(thrown.context.enqueueSequence).toEqual(expect.any(Number))
      expect(events).toEqual(['beforePieceSummoned'])
      expect(hashBattleState(state)).toBe(beforeHash)
      expect(anchor).toMatchObject({ currentHp: 20, attack: 3 })
      expect(red).toMatchObject({ actionPoints: 3, discardPile: [] })
      expect(red.hand.map((card: any) => card.cardId)).toEqual(['demon-summon-5'])
      expect(state.extensions.kiljaedanPiece.instanceId).toBe('red139-kiljaedan-hidden')
      expect(state.actions).toEqual([])
    },
  )

  it.each(['owner-global', 'piece', 'player', 'reactive'] as const)(
    'preserves a valid declared-summon redirect from a cloned %s rule context',
    consumer => {
      const ruleId = 'red139-valid-redirect-' + consumer
      const run = () => {
        const { state, anchor, red } = makeDemonSummonState()
        if (consumer === 'reactive') {
          red.hand.push({
            cardId: 'red139-redirect-reactive',
            instanceId: 'red139-redirect-reactive-1',
            ownerPlayerId: 'player-red',
          })
          state.customCards = {
            'red139-redirect-reactive': {
              id: 'red139-redirect-reactive',
              name: 'RED-139 redirect reactive',
              description: '',
              type: 'reactive',
              actionPointCost: 0,
              trigger: { type: 'beforePieceSummoned' },
              code: "function executeCard(context) { context.targetPosition = { x: 3, y: 2 }; return { success: true, keepInHand: true }; }",
            },
          }
        } else {
          const rule = loadRuleById(ruleId, true)
          expect(rule).toBeDefined()
          if (consumer === 'owner-global') {
            anchor.rules = [rule]
            globalTriggerSystem.addRule(rule! as any)
          } else if (consumer === 'piece') {
            anchor.rules = [rule]
          } else {
            red.rules = [rule]
          }
        }

        const result = runBattleAction(
          state,
          prepareDemonSummonAction(state, ruleId) as any,
          { rootSeed: 13906 },
        )
        const summoned = result.state.pieces.find(piece => piece.templateId === 'kiljaedan')

        expect(summoned).toMatchObject({ x: 3, y: 2 })
        expect(result.state.graveyard).toEqual([])
      }
      if (consumer === 'reactive') run()
      else withTemporaryRuleProfile(ruleId, run)
    },
  )

  it.each([
    ['direct', (state: any) => state],
    ['structuredClone', (state: any) => structuredClone(state)],
    ['JSON round-trip', (state: any) => JSON.parse(JSON.stringify(state))],
  ])('preserves stored-piece rule runtime counters across %s state transport', (_name, transport) => {
    const fixture = makeDemonSummonState()
    fixture.state.extensions.kiljaedanPiece.rules = [{
      id: 'rule-kiljaedan-gamestart',
      name: 'persisted stale definition',
      description: 'must be replaced by the pinned profile definition',
      trigger: { type: 'wrong-trigger' },
      limits: {
        maxUses: 999,
        uses: 1,
        cooldownTurns: 999,
        currentCooldown: 0,
        duration: 999,
        remainingDuration: -1,
      },
    }]
    const state = transport(fixture.state)
    const persistedLimits = structuredClone(state.extensions.kiljaedanPiece.rules[0].limits)
    const beforeHash = hashBattleState(state)

    const result = runBattleAction(
      state,
      prepareDemonSummonAction(state, 'red139-stored-rule-runtime') as any,
      { rootSeed: 13910 },
    )
    const summoned = result.state.pieces.find(piece => piece.templateId === 'kiljaedan') as any
    const rule = summoned.rules.find((candidate: any) => candidate.id === 'rule-kiljaedan-gamestart')

    expect(rule).toMatchObject({
      id: 'rule-kiljaedan-gamestart',
      trigger: { type: 'gameStart' },
      limits: {
        maxUses: 1,
        uses: 1,
        currentCooldown: 0,
        remainingDuration: -1,
      },
    })
    expect(rule.limits).not.toHaveProperty('cooldownTurns')
    expect(rule.limits).not.toHaveProperty('duration')
    expect(rule.effect).toBeUndefined()
    expect(result.state.extensions?.kiljaedanPiece).toBeUndefined()
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(state.extensions.kiljaedanPiece.rules[0].limits).toEqual(persistedLimits)
  })

  it('rejects invalid stored-piece rule runtime before root commit', () => {
    const fixture = makeDemonSummonState()
    fixture.state.extensions.kiljaedanPiece.rules = [{
      id: 'rule-kiljaedan-gamestart',
      limits: { maxUses: 1, uses: -1 },
    }]
    const state = JSON.parse(JSON.stringify(fixture.state))
    const beforeHash = hashBattleState(state)
    let caught: unknown

    try {
      runBattleAction(
        state,
        prepareDemonSummonAction(state, 'red139-invalid-stored-rule-runtime') as any,
        { rootSeed: 13911 },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EffectChainFatalError)
    expect((caught as EffectChainFatalError).context).toMatchObject({
      actionId: 'red139-invalid-stored-rule-runtime',
      kind: 'summon',
      sourceId: 'red139-kiljaedan-hidden',
      skillId: 'rule-kiljaedan-gamestart',
    })
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(state.pieces.some((piece: any) => piece.templateId === 'kiljaedan')).toBe(false)
    expect(state.extensions.kiljaedanPiece.rules[0].limits.uses).toBe(-1)
  })

  it('applies position aliases chronologically across successive consumers', () => {
    const { state } = makeDemonSummonState()
    const earlyPosition = eventRule(
      'red139-alias-position-first',
      'beforePieceSummoned',
      (_battle, context) => {
        context.targetPosition = { x: 3, y: 2 }
      },
    ) as any
    earlyPosition.priority = 2
    const lateCoordinates = eventRule(
      'red139-alias-coordinates-last',
      'beforePieceSummoned',
      (_battle, context) => {
        context.targetX = 4
        context.targetY = 2
      },
    ) as any
    lateCoordinates.priority = 1
    globalTriggerSystem.addRules([earlyPosition, lateCoordinates])

    const result = runBattleAction(
      state,
      prepareDemonSummonAction(state, 'red139-alias-order') as any,
      { rootSeed: 13908 },
    )
    const summoned = result.state.pieces.find(piece => piece.templateId === 'kiljaedan')

    expect(summoned).toMatchObject({ x: 4, y: 2 })
  })

  it('replays a real pending beforePieceSummoned redirect deterministically from the root action', () => {
    const rootSeed = 13909
    const observedBatchIds: string[] = []
    const redirectRule = {
      id: 'red139-pending-summon-redirect',
      name: 'red139-pending-summon-redirect',
      description: '',
      trigger: { type: 'beforePieceSummoned' },
      limits: { maxUses: 4, uses: 0 },
      effect: (_battle: any, context: any) => {
        observedBatchIds.push(context.effectBatchId)
        const selected = context.selectedTargets?.find((target: any) => target.type === 'cell')
        if (!selected) {
          return {
            success: false,
            needsTargetSelection: true,
            playerId: 'player-red',
            title: 'Choose the redirected summon cell',
            targetType: 'cell',
            range: 99,
            filter: 'all',
            targetCandidates: [{ type: 'cell', x: 4, y: 2 }],
          }
        }
        context.targetPosition = { x: selected.x, y: selected.y }
        return { success: true }
      },
    } as any
    globalTriggerSystem.addRule(redirectRule)
    const contractStart = globalTriggerSystem.snapshotTransactionState()

    const runContract = () => {
      const { state } = makeDemonSummonState()
      const action = prepareDemonSummonAction(state, 'red139-pending-summon-root')
      const pendingResult = runBattleAction(state, action as any, { rootSeed })
      const pending = pendingResult.state.pendingTargetSelection
      expect(pendingResult.state.pieces.some(piece => piece.templateId === 'kiljaedan')).toBe(false)
      expect(pendingResult.state.pieces.find(piece => piece.instanceId === 'demon-anchor'))
        .toMatchObject({ currentHp: 20, attack: 3 })
      expect(pendingResult.state.players.find(player => player.playerId === 'player-red'))
        .toMatchObject({
          actionPoints: 3,
          hand: [{ cardId: 'demon-summon-5', instanceId: 'red139-card-5' }],
          discardPile: [],
        })
      expect(pending).toMatchObject({
        playerId: 'player-red',
        source: { type: 'rule', id: redirectRule.id },
        candidates: [{ type: 'cell', x: 4, y: 2 }],
        transaction: { rootAction: { clientActionId: 'red139-pending-summon-root' } },
      })

      const completed = runBattleAction(pendingResult.state, {
        type: 'pendingTargetSelect',
        playerId: 'player-red',
        targetX: 4,
        targetY: 2,
        selectionId: pending!.selectionId,
        stateRevision: pending!.stateRevision,
        clientActionId: 'red139-pending-summon-answer',
      } as any, { rootSeed })
      const summoned = completed.state.pieces.find(piece => piece.templateId === 'kiljaedan')

      expect(completed.state.pieces.find(piece => piece.instanceId === 'demon-anchor'))
        .toMatchObject({ currentHp: 14, attack: 4 })
      expect(completed.state.players.find(player => player.playerId === 'player-red'))
        .toMatchObject({ actionPoints: 0, hand: [], discardPile: ['demon-summon-5'] })
      expect(completed.state.extensions?.kiljaedanPiece).toBeUndefined()

      expect(completed.state.pendingTargetSelection).toBeUndefined()
      expect(summoned).toMatchObject({ x: 4, y: 2 })
      expect(redirectRule.limits).toEqual({ maxUses: 4, uses: 1 })
      expect(getActiveEffectChain(completed.state)).toBeUndefined()
      return {
        stateHash: completed.stateHash,
        randomStreams: completed.trace?.randomStreams,
        selectionId: pending!.selectionId,
      }
    }

    const first = runContract()
    const firstBatchIds = observedBatchIds.splice(0)
    globalTriggerSystem.restoreTransactionState(contractStart)
    const control = runContract()
    const controlBatchIds = observedBatchIds.splice(0)

    expect(firstBatchIds).toHaveLength(2)
    expect(new Set(firstBatchIds).size).toBe(1)
    expect(controlBatchIds).toEqual(firstBatchIds)
    expect(control).toEqual(first)
  })

  it.each([
    {
      name: 'malformed targetPosition',
      mutate: (context: any) => { context.targetPosition = { x: '3', y: 2 } },
    },
    {
      name: 'partial targetPosition',
      mutate: (context: any) => { context.targetPosition = { x: 3 } },
    },
    {
      name: 'string targetX',
      mutate: (context: any) => { context.targetX = '3' },
    },
    {
      name: 'NaN targetY',
      mutate: (context: any) => { context.targetY = Number.NaN },
    },
  ])('rejects $name and rolls back state plus TriggerSystem cursors', ({ name, mutate }) => {
    const { state } = makeDemonSummonState()
    const action = prepareDemonSummonAction(state, 'red139-malformed-redirect-' + name)
    const beforeHash = hashBattleState(state)
    const beforeJson = JSON.stringify(state)
    const rule = eventRule(
      'red139-malformed-redirect-' + name,
      'beforePieceSummoned',
      (_battle, context) => mutate(context),
    ) as any
    rule.limits = { maxUses: 4, uses: 0, cooldownTurns: 2, currentCooldown: 0 }
    globalTriggerSystem.addRule(rule)
    const triggerBefore = globalTriggerSystem.snapshotTransactionState()
    let thrown: any

    try {
      runBattleAction(state, action as any, { rootSeed: 13907 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: {
        actionId: 'red139-malformed-redirect-' + name,
        kind: 'summon',
        rootSeed: 13907,
      },
    })
    expect(thrown.message).toContain('Summon redirect')
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(JSON.stringify(state)).toBe(beforeJson)
    expect(globalTriggerSystem.snapshotTransactionState()).toEqual(triggerBefore)
    expect(rule.limits).toEqual({ maxUses: 4, uses: 0, cooldownTurns: 2, currentCooldown: 0 })
  })

  it('rejects a trusted declared capability replayed under a different contentId', () => {
    const originChain = createEffectChain({
      actionId: 'red139-capability-origin-action',
      chainId: 'red139-capability-origin-chain',
      turn: 1,
      rootSeed: 139,
    })
    const writer = createDeclaredSummonQueueWriter(
      originChain,
      'red139-bound-content',
      {
        version: 1,
        recipe: 'source-mirror',
        maxSummons: 1,
        allowedVariants: ['summon'],
        instanceIdPrefix: 'bound-mirror-',
        maxHp: 1,
        attack: 0,
        defense: 0,
        moveRange: 0,
        noKillCharge: true,
        resetBoundSkillCooldown: false,
        rules: ['rule-naruto-clone-immobile'],
        status: {
          idPrefix: 'bound-status-',
          name: 'Bound',
          type: 'bound',
          visible: false,
          remainingDuration: -1,
          remainingUses: -1,
          intensity: 1,
          stacks: 1,
          relatedRules: ['rule-naruto-clone-immobile'],
        },
      },
    )
    writer.push({
      sourceId: 'red139-capability-source',
      summons: [{ x: 1, y: 1, variant: 'summon' }],
    })
    let trustedRequest: any
    originChain.drain({
      damage: () => undefined,
      heal: () => undefined,
      summon: request => {
        trustedRequest = request
      },
      death: () => undefined,
    })
    expect(trustedRequest).toBeDefined()

    const state = makeState({ pieces: [] }) as any
    const beforeHash = hashBattleState(state)
    const forgedChain = createEffectChain({
      actionId: 'red139-capability-forged-action',
      chainId: 'red139-capability-forged-chain',
      turn: state.turn.turnNumber,
      rootSeed: 139,
    })
    forgedChain.enqueue({
      ...trustedRequest,
      contentId: 'red139-forged-content',
      skillId: 'red139-forged-content',
    })
    let caught: any

    try {
      withEffectChain(state, forgedChain, () => drainBattleEffectChain(state, forgedChain))
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: expect.objectContaining({
        actionId: 'red139-capability-forged-action',
        chainId: 'red139-capability-forged-chain',
        kind: 'summon',
        sourceId: 'red139-capability-source',
        skillId: 'red139-forged-content',
      }),
    })
    expect(caught.message).toContain('not bound to its declaring content')
    expect(hashBattleState(state)).toBe(beforeHash)
  })
})

describe('RED-139 DeathBatch', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('freezes simultaneous candidates so A can revive B without suppressing B lifecycle', () => {
    const attacker = makePiece({ instanceId: 'death-attacker', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({
      instanceId: 'death-alpha',
      ownerPlayerId: 'player-blue',
      currentHp: 5,
      maxHp: 10,
    }) as any
    const beta = makePiece({
      instanceId: 'death-beta',
      ownerPlayerId: 'player-blue',
      currentHp: 5,
      maxHp: 10,
    }) as any
    const state = makeState({ pieces: [attacker, alpha, beta] }) as any
    const lifecycle: any[] = []

    for (const type of ['beforePieceKilled', 'afterPieceKilled', 'onPieceDied']) {
      globalTriggerSystem.addRule(eventRule('red139-freeze-' + type, type, (battle, context) => {
        const subject = deathSubjectId(context)
        lifecycle.push({
          event: type,
          subject,
          activeCandidates: battle.pieces
            .filter((piece: any) => piece.instanceId.startsWith('death-') && piece.instanceId !== 'death-attacker')
            .map((piece: any) => piece.instanceId)
            .sort(),
          metadata: {
            chainId: context.effectChainId,
            batchId: context.effectBatchId,
            parentBatchId: context.parentEffectBatchId,
            kind: context.effectBatchKind,
            depth: context.effectDepth,
            originStage: context.originStage,
          },
        })
        if (type === 'onPieceDied' && subject === alpha.instanceId) beta.currentHp = 6
      }) as any)
    }

    const result = dealDamage(attacker, [beta, alpha], 5, 'true', state, 'red139-freeze') as any

    expect(lifecycle.map(entry => entry.event + ':' + entry.subject)).toEqual([
      'beforePieceKilled:death-alpha',
      'afterPieceKilled:death-alpha',
      'onPieceDied:death-alpha',
      'beforePieceKilled:death-beta',
      'afterPieceKilled:death-beta',
      'onPieceDied:death-beta',
    ])
    for (const entry of lifecycle) {
      expect(entry.activeCandidates).toEqual(['death-alpha', 'death-beta'])
      expect(entry.metadata).toMatchObject({
        chainId: result.chainId,
        parentBatchId: result.batchId,
        kind: 'death',
        depth: 1,
        originStage: 'damage:death',
      })
      expect(entry.metadata.batchId).toEqual(expect.any(String))
      expect(entry.metadata.batchId).not.toBe(result.batchId)
    }
    expect(new Set(lifecycle.map(entry => entry.metadata.batchId)).size).toBe(1)
    expect(result.results.map((entry: any) => ({
      targetId: entry.targetId,
      killed: entry.isKilled,
      hp: entry.targetHp,
    }))).toEqual([
      { targetId: 'death-beta', killed: false, hp: 6 },
      { targetId: 'death-alpha', killed: true, hp: 0 },
    ])
    expect(state.pieces.map((piece: any) => piece.instanceId)).toEqual(['death-attacker', 'death-beta'])
    expect(state.graveyard.map((piece: any) => piece.instanceId)).toEqual(['death-alpha'])
    expect(state.players.find((player: any) => player.playerId === 'player-red').chargePoints).toBe(1)
  })

  it('commits the whole graveyard and all charge before stable afterChargeGained events', () => {
    const attacker = makePiece({ instanceId: 'finalize-attacker', ownerPlayerId: 'player-red' }) as any
    const alpha = makePiece({
      instanceId: 'finalize-alpha',
      ownerPlayerId: 'player-blue',
      currentHp: 4,
      maxHp: 4,
    }) as any
    const beta = makePiece({
      instanceId: 'finalize-beta',
      ownerPlayerId: 'player-blue',
      currentHp: 4,
      maxHp: 4,
    }) as any
    const state = makeState({ pieces: [attacker, alpha, beta] }) as any
    const lifecycleSnapshots: any[] = []
    const chargeSnapshots: any[] = []

    for (const type of ['beforePieceKilled', 'afterPieceKilled', 'onPieceDied']) {
      globalTriggerSystem.addRule(eventRule('red139-finalize-' + type, type, battle => {
        lifecycleSnapshots.push({
          type,
          active: battle.pieces.map((piece: any) => piece.instanceId).sort(),
          graveyard: battle.graveyard.map((piece: any) => piece.instanceId),
        })
      }) as any)
    }
    globalTriggerSystem.addRule(eventRule('red139-observe-finalized-charge', 'afterChargeGained', battle => {
      chargeSnapshots.push({
        active: battle.pieces.map((piece: any) => piece.instanceId).sort(),
        graveyard: battle.graveyard.map((piece: any) => piece.instanceId),
        charge: battle.players.find((player: any) => player.playerId === 'player-red').chargePoints,
      })
    }) as any)

    const result = dealDamage(attacker, [beta, alpha], 4, 'true', state, 'red139-finalize') as any

    expect(result.results.map((entry: any) => entry.targetId)).toEqual(['finalize-beta', 'finalize-alpha'])
    expect(lifecycleSnapshots).toHaveLength(6)
    for (const snapshot of lifecycleSnapshots) {
      expect(snapshot.active).toEqual(['finalize-alpha', 'finalize-attacker', 'finalize-beta'])
      expect(snapshot.graveyard).toEqual([])
    }
    expect(chargeSnapshots).toEqual([
      {
        active: ['finalize-attacker'],
        graveyard: ['finalize-alpha', 'finalize-beta'],
        charge: 2,
      },
      {
        active: ['finalize-attacker'],
        graveyard: ['finalize-alpha', 'finalize-beta'],
        charge: 2,
      },
    ])
  })

  it.each([
    { kind: 'empty', message: 'at least one candidate' },
    { kind: 'duplicate', message: 'duplicate candidate' },
    { kind: 'missing', message: 'must appear exactly once in battle.pieces' },
    { kind: 'alive', message: 'HP must equal zero' },
    { kind: 'NaN maxHp', message: 'maxHp must be finite and positive', maxHp: Number.NaN },
    { kind: 'infinite maxHp', message: 'maxHp must be finite and positive', maxHp: Number.POSITIVE_INFINITY },
    { kind: 'zero maxHp', message: 'maxHp must be finite and positive', maxHp: 0 },
    { kind: 'negative maxHp', message: 'maxHp must be finite and positive', maxHp: -1 },
  ])('rejects an invalid $kind DeathRequest before lifecycle or state writes', ({ kind, message, maxHp }) => {
    const source = makePiece({ instanceId: 'invalid-death-source', ownerPlayerId: 'player-red' }) as any
    const dead = makePiece({
      instanceId: 'invalid-death-dead', ownerPlayerId: 'player-blue', currentHp: 0, maxHp: 10,
    }) as any
    const alive = makePiece({
      instanceId: 'invalid-death-alive', ownerPlayerId: 'player-blue', currentHp: 10, maxHp: 10,
    }) as any
    const missing = makePiece({
      instanceId: 'invalid-death-missing', ownerPlayerId: 'player-blue', currentHp: 0, maxHp: 10,
    }) as any
    const invalidMaxHp = makePiece({
      instanceId: 'invalid-death-max-hp', ownerPlayerId: 'player-blue', currentHp: 0, maxHp,
    }) as any
    const state = makeState({ pieces: [source, dead, alive, invalidMaxHp], turnNumber: 12 }) as any
    const beforeHash = hashBattleState(state)
    const candidate = (piece: any) => ({ piece, attacker: source, skillId: `invalid-death-${kind}` })
    const candidates = maxHp !== undefined
      ? [candidate(invalidMaxHp)]
      : kind === 'empty'
      ? []
      : kind === 'duplicate'
        ? [candidate(dead), candidate(dead)]
        : kind === 'missing'
          ? [candidate(missing)]
          : [candidate(alive)]
    const chain = createEffectChain({
      actionId: `invalid-death-${kind}-action`,
      chainId: `invalid-death-${kind}-chain`,
      turn: 12,
      rootSeed: 0x139,
    })

    let thrown: any
    try {
      withEffectChain(state, chain, () => {
        createInternalDeathQueueWriter(chain).push({ candidates })
        drainBattleEffectChain(state, chain)
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_REJECTED',
      context: {
        actionId: `invalid-death-${kind}-action`,
        chainId: `invalid-death-${kind}-chain`,
        kind: 'death',
        depth: 0,
        turn: 12,
        rootSeed: 0x139,
        detached: false,
      },
    })
    expect(thrown.message).toContain(message)
    expect(hashBattleState(state)).toBe(beforeHash)
    expect(chain.state).toBe('idle')
  })

  it('counts endogenous death against the shared batch budget with parent/depth diagnostics', () => {
    const attacker = makePiece({ instanceId: 'budget-attacker', ownerPlayerId: 'player-red' }) as any
    const target = makePiece({
      instanceId: 'budget-target',
      ownerPlayerId: 'player-blue',
      currentHp: 1,
      maxHp: 1,
    }) as any
    const state = makeState({ pieces: [attacker, target], turnNumber: 9 }) as any
    const chain = createEffectChain({
      actionId: 'red139-death-budget',
      chainId: 'red139-death-budget-chain',
      turn: 9,
      rootSeed: 0x139,
      limits: { maxBatches: 1 },
    })
    let thrown: any

    try {
      withEffectChain(state, chain, () => {
        dealDamage(attacker, target, 1, 'true', state, 'red139-budget-lethal')
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_LIMIT',
      context: {
        actionId: 'red139-death-budget',
        chainId: 'red139-death-budget-chain',
        kind: 'death',
        depth: 1,
        originStage: 'damage:death',
        processed: 2,
        limit: 1,
        turn: 9,
        rootSeed: 0x139,
        sourceId: 'budget-attacker',
        targetId: 'budget-target',
      },
    })
    expect(thrown.context.batchId).toEqual(expect.any(String))
    expect(thrown.context.parentBatchId).toEqual(expect.any(String))
    expect(thrown.context.batchId).not.toBe(thrown.context.parentBatchId)
  })

  it('stops an internal sealed summon/death loop with complete deterministic diagnostics', () => {
    const source = makePiece({ instanceId: 'loop-source', ownerPlayerId: 'player-red' }) as any
    const dead = makePiece({
      instanceId: 'loop-dead',
      ownerPlayerId: 'player-blue',
      currentHp: 0,
      maxHp: 1,
    }) as any
    const chain = createEffectChain({
      actionId: 'red139-summon-death-loop',
      chainId: 'red139-summon-death-chain',
      turn: 7,
      rootSeed: 0x5139,
      limits: { maxBatches: 3 },
    })
    const summonSpec = {
      recipe: 'template' as const,
      templateId: 'loop-template',
      ownerPlayerId: 'player-red',
      faction: 'red' as const,
      x: 1,
      y: 1,
    }
    createSummonQueueWriter(chain, 'internal:template').push({
      summons: [summonSpec],
      sourceId: source.instanceId,
      skillId: 'red139-loop',
    })
    let thrown: any

    try {
      chain.drain({
        damage: () => undefined,
        heal: () => undefined,
        summon: (_request, _context, activeChain) => {
          createInternalDeathQueueWriter(activeChain).push({
            candidates: [{ piece: dead, attacker: source, skillId: 'red139-loop' }],
          })
        },
        death: (_request, _context, activeChain) => {
          createSummonQueueWriter(activeChain, 'internal:template').push({
            summons: [summonSpec],
            sourceId: source.instanceId,
            skillId: 'red139-loop',
          })
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      name: 'EffectChainFatalError',
      code: 'RVB_EFFECT_CHAIN_BATCH_LIMIT',
      context: {
        actionId: 'red139-summon-death-loop',
        chainId: 'red139-summon-death-chain',
        kind: 'death',
        depth: 3,
        enqueueSequence: 3,
        processed: 4,
        limit: 3,
        turn: 7,
        rootSeed: 0x5139,
        sourceId: 'loop-source',
        skillId: 'red139-loop',
        targetId: 'loop-dead',
      },
    })
    expect(thrown.context.batchId).toEqual(expect.any(String))
    expect(thrown.context.parentBatchId).toEqual(expect.any(String))
    expect(thrown.context.batchId).not.toBe(thrown.context.parentBatchId)
  })
})
