/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest'

import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import {
  hashBattleState,
  recordBattleInitialization,
  replayBattle,
  runBattleAction,
} from '@/lib/game/battle-runner'
import {
  DEPLOYMENT_SAFE_DISTANCE,
  getEmptyWalkableDeploymentPositions,
  toPublicBattleState,
} from '@/lib/game/deployment'
import { getPieceById } from '@/lib/game/piece-repository'
import type { PieceInstance, PieceTemplate } from '@/lib/game/piece'
import { getActiveRuleRuntime, RANDOM_STREAM_NAMES, RuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage } from '@/lib/game/skills'
import { finalizeBattleTerminal } from '@/lib/game/terminal'
import { safeCloneBattleState, type BattleAction, type BattleState } from '@/lib/game/turn'
import { createRunningTurnTimer } from '@/lib/game/turn-timer'
import { getLegalNormalMoveTargets, manhattanDistance } from '@/lib/game/spatial'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'
import { pinTestBattleState } from './profile-test-identity'

const PLAYERS = ['player-red', 'player-blue'] as const
const ROOT_SEED = 0x1382026

function templates(prefix: string): PieceTemplate[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${index + 1}`,
    faction: prefix === 'red' ? 'good' : 'evil',
    rarity: 'common',
    stats: { maxHp: 12, attack: 4, defense: 0, moveRange: 3 },
    skills: [],
  }))
}

async function createProgressiveBattle(
  seed = ROOT_SEED,
  red = templates('red'),
  blue = templates('blue'),
  reverseInput = false,
): Promise<BattleState> {
  const playerIds = reverseInput ? [...PLAYERS].reverse() : [...PLAYERS]
  const playerSelections = [
    { playerId: PLAYERS[0], pieces: red, faction: 'red' as const, alignment: 'light' as const },
    { playerId: PLAYERS[1], pieces: blue, faction: 'blue' as const, alignment: 'dark' as const },
  ]
  if (reverseInput) playerSelections.reverse()
  const battle = await createInitialBattleForPlayers(
    playerIds,
    [...red, ...blue],
    playerSelections,
    'large-hole-arena',
    {
      firstPlayerId: PLAYERS[0],
      rootSeed: seed,
      deploymentEnabled: true,
      deploymentStartedAt: 1_750_000_000_000,
    },
  )
  if (!battle) throw new Error('Expected progressive battle')
  return battle
}

function reserveCore(instanceId: string, ownerPlayerId: string): PieceInstance {
  return {
    ...(makePiece({ instanceId, ownerPlayerId, currentHp: 10, maxHp: 10, moveRange: 2 }) as any),
    isCore: true,
    name: instanceId,
    x: null,
    y: null,
    buffs: [],
    debuffs: [],
    ruleTags: [],
  } as PieceInstance
}

function initializeTrackedState(state: BattleState, seed: number): BattleState {
  pinTestBattleState(state as unknown as Record<string, unknown>, seed)
  recordBattleInitialization(state, new RuleRuntime({ rootSeed: seed }), [...PLAYERS])
  return state
}

function committedRuntimeCursors(state: BattleState): Record<string, number> {
  const cursors = (state.extensions as any).debugBattle?.authority?.runtimeCursors
  return { ...(cursors ?? {}) }
}

function expectStaleRevisionRejectedWithoutMutation(
  state: BattleState,
  action: BattleAction,
  seed: number,
): void {
  const beforeHash = hashBattleState(state)
  const beforeCursors = committedRuntimeCursors(state)
  let rejection: unknown
  try {
    runBattleAction(state, action, { rootSeed: seed })
  } catch (error) {
    rejection = error
  }
  expect(rejection).toMatchObject({ code: 'PROGRESSIVE_DEPLOYMENT_STALE_REVISION' })
  expect(hashBattleState(state)).toBe(beforeHash)
  expect(committedRuntimeCursors(state)).toEqual(beforeCursors)
}

describe('RED-138 progressive reserve deployment', () => {
  it('starts with one deterministic random vanguard per side before the first private offer', async () => {
    const first = await createProgressiveBattle()
    const repeated = await createProgressiveBattle()
    const reversedInput = await createProgressiveBattle(ROOT_SEED, templates('red'), templates('blue'), true)
    const reorderedRosters = await createProgressiveBattle(
      ROOT_SEED,
      templates('red').reverse(),
      templates('blue').reverse(),
    )
    const deployment = first.deployment!
    const vanguards = first.pieces.map(piece => ({
      instanceId: piece.instanceId,
      ownerPlayerId: piece.ownerPlayerId,
      isCore: piece.isCore,
      x: piece.x,
      y: piece.y,
    }))

    expect(vanguards).toEqual([
      { instanceId: 'player-blue-6', ownerPlayerId: PLAYERS[1], isCore: true, x: 1, y: 11 },
      { instanceId: 'player-red-1', ownerPlayerId: PLAYERS[0], isCore: true, x: 11, y: 13 },
    ])
    expect(repeated.pieces.map(piece => ({
      instanceId: piece.instanceId,
      ownerPlayerId: piece.ownerPlayerId,
      isCore: piece.isCore,
      x: piece.x,
      y: piece.y,
    }))).toEqual(vanguards)
    expect(reversedInput.pieces.map(piece => ({
      instanceId: piece.instanceId,
      ownerPlayerId: piece.ownerPlayerId,
      isCore: piece.isCore,
      x: piece.x,
      y: piece.y,
    }))).toEqual(vanguards)
    expect(hashBattleState(repeated)).toBe(hashBattleState(first))
    expect(hashBattleState(reversedInput)).toBe(hashBattleState(first))
    expect(reorderedRosters.pieces.map(piece => ({
      instanceId: piece.instanceId,
      templateId: piece.templateId,
      ownerPlayerId: piece.ownerPlayerId,
      x: piece.x,
      y: piece.y,
    }))).toEqual(first.pieces.map(piece => ({
      instanceId: piece.instanceId,
      templateId: piece.templateId,
      ownerPlayerId: piece.ownerPlayerId,
      x: piece.x,
      y: piece.y,
    })))
    expect(hashBattleState(reorderedRosters)).toBe(hashBattleState(first))
    for (const playerId of PLAYERS) {
      expect(first.pieces.filter(piece => piece.ownerPlayerId === playerId && piece.isCore)).toHaveLength(1)
    }
    for (const piece of first.pieces) {
      expect(first.map.tiles).toContainEqual(expect.objectContaining({
        x: piece.x,
        y: piece.y,
        props: expect.objectContaining({ walkable: true }),
      }))
      expect(deployment.reserves?.[piece.ownerPlayerId]?.some(candidate =>
        candidate.instanceId === piece.instanceId)).toBe(false)
    }
    expect(new Set(first.pieces.map(piece => `${piece.x},${piece.y}`)).size).toBe(2)
    expect(deployment.initialPositions).toEqual({
      'player-blue-6': { x: 1, y: 11 },
      'player-red-1': { x: 11, y: 13 },
    })
    expect(deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
      activePlayerId: PLAYERS[0],
      offerTurnNumber: 1,
      reserveCounts: { [PLAYERS[0]]: 7, [PLAYERS[1]]: 7 },
    })
    expect(first.pieces.every(piece =>
      piece.statusTags.every(tag => tag.type !== 'deployment-first-move-free'))).toBe(true)
    expect(deployment.offerPieceIds).toHaveLength(3)
    expect(new Set(deployment.offerPieceIds).size).toBe(3)
    expect(deployment.offerPieceIds).toEqual(repeated.deployment?.offerPieceIds)
    expect(deployment.offerPieceIds).not.toContain('player-red-1')
    expect(deployment.legalPositions?.length).toBeGreaterThan(0)

    const initializationTrace = first.extensions?.debugBattle?.actionLog?.[0]
    for (const playerId of PLAYERS) {
      expect(initializationTrace?.randomStreams).toContainEqual(expect.objectContaining({
        name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningPiece}/${playerId}`,
        startCursor: 0,
        endCursor: 1,
      }))
      expect(initializationTrace?.randomStreams).toContainEqual(expect.objectContaining({
        name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningCell}/${playerId}`,
        startCursor: 0,
        endCursor: 1,
      }))
    }
    expect(initializationTrace?.randomStreams).toContainEqual(expect.objectContaining({
      name: `${RANDOM_STREAM_NAMES.progressiveDeploymentOffer}/player-red`,
      startCursor: 0,
      endCursor: 3,
    }))
    expect(initializationTrace?.randomStreams).not.toContainEqual(expect.objectContaining({
      name: RANDOM_STREAM_NAMES.deployment,
      endCursor: 16,
    }))

    const owner = toPublicBattleState(first, PLAYERS[0]).deployment!
    const opponent = toPublicBattleState(first, PLAYERS[1]).deployment!
    const spectator = toPublicBattleState(first).deployment!
    expect(owner.offerPieceIds).toEqual(deployment.offerPieceIds)
    expect(owner.offerPieces).toHaveLength(3)
    expect(owner.legalPositions).toEqual(deployment.legalPositions)
    expect(owner.reserves).toEqual({})
    expect(opponent.offerPieceIds).toEqual([])
    expect(opponent.offerPieces).toEqual([])
    expect(opponent.legalPositions).toEqual([])
    expect(opponent.reserves).toEqual({})
    expect(spectator.offerPieceIds).toEqual([])
    expect(JSON.stringify(opponent)).not.toContain(deployment.offerPieceIds![0])
  })

  it('normalizes mixed-case player IDs before stable opening order and stream naming', async () => {
    const seed = ROOT_SEED + 29
    const redPlayerId = 'a-RED'
    const bluePlayerId = 'B-blue'
    const red = templates('red')
    const blue = templates('blue')

    const createCaseVariant = async (reverseInput: boolean) => {
      const playerIds = reverseInput
        ? [bluePlayerId, redPlayerId]
        : [redPlayerId, bluePlayerId]
      const playerSelections = [
        { playerId: redPlayerId, pieces: red, faction: 'red' as const, alignment: 'light' as const },
        { playerId: bluePlayerId, pieces: blue, faction: 'blue' as const, alignment: 'dark' as const },
      ]
      if (reverseInput) playerSelections.reverse()
      const summonOrder: string[] = []
      const checkTriggers = globalTriggerSystem.checkTriggers.bind(globalTriggerSystem)
      const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers').mockImplementation((state, context) => {
        if (context.type === 'afterPieceSummoned' && context.sourcePiece) {
          summonOrder.push(context.sourcePiece.ownerPlayerId)
        }
        return checkTriggers(state, context)
      })

      try {
        const battle = await createInitialBattleForPlayers(
          playerIds,
          [...red, ...blue],
          playerSelections,
          'large-hole-arena',
          {
            firstPlayerId: redPlayerId,
            rootSeed: seed,
            deploymentEnabled: true,
            deploymentStartedAt: 1_750_000_000_000,
          },
        )
        if (!battle) throw new Error('Expected mixed-case progressive battle')
        return { battle, summonOrder }
      } finally {
        triggerSpy.mockRestore()
      }
    }

    const first = await createCaseVariant(false)
    const reversed = await createCaseVariant(true)
    const summarizeVanguards = (state: BattleState) => state.pieces
      .map(piece => ({
        ownerPlayerId: piece.ownerPlayerId,
        templateId: piece.templateId,
        x: piece.x,
        y: piece.y,
      }))
      .sort((left, right) =>
        left.ownerPlayerId.toLowerCase().localeCompare(right.ownerPlayerId.toLowerCase()))

    expect(first.battle.deployment?.playerIds).toEqual([redPlayerId, bluePlayerId])
    expect(reversed.battle.deployment?.playerIds).toEqual([redPlayerId, bluePlayerId])
    expect(first.summonOrder).toEqual([redPlayerId, bluePlayerId])
    expect(reversed.summonOrder).toEqual(first.summonOrder)
    expect(summarizeVanguards(reversed.battle)).toEqual(summarizeVanguards(first.battle))
    expect(hashBattleState(reversed.battle)).toBe(hashBattleState(first.battle))

    const cursors = committedRuntimeCursors(first.battle)
    for (const playerId of [redPlayerId.toLowerCase(), bluePlayerId.toLowerCase()]) {
      expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOpeningPiece + '/' + playerId]).toBe(1)
      expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOpeningCell + '/' + playerId]).toBe(1)
    }
    expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + redPlayerId.toLowerCase()]).toBe(3)
    expect(Object.keys(cursors).some(name => name.includes(redPlayerId) || name.includes(bluePlayerId))).toBe(false)
  })

  it('settles only after both opening summon queues and before gameStart or the first offer', async () => {
    const seed = ROOT_SEED + 30
    let openingSummonQueueCount = 0
    let gameStartCount = 0
    let beginTurnCount = 0
    const checkTriggers = globalTriggerSystem.checkTriggers.bind(globalTriggerSystem)
    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers').mockImplementation((state, context) => {
      const result = checkTriggers(state, context)
      if (context.type === 'afterPieceSummoned' && context.sourcePiece) {
        openingSummonQueueCount += 1
        dealDamage(
          context.sourcePiece,
          context.sourcePiece,
          context.sourcePiece.currentHp,
          'true',
          state,
          'red-138-opening-self-elimination',
        )
      } else if (context.type === 'gameStart') {
        gameStartCount += 1
      } else if (context.type === 'beginTurn') {
        beginTurnCount += 1
      }
      return result
    })

    try {
      const battle = await createProgressiveBattle(seed)
      const cursors = committedRuntimeCursors(battle)

      expect(openingSummonQueueCount).toBe(2)
      expect(battle.deployment?.openingVanguardsInitialized).toBe(true)
      expect(battle.terminalResult).toMatchObject({
        winnerPlayerId: null,
        loserPlayerId: null,
        reason: 'mutual-core-elimination',
      })
      expect(battle.gameStartFired).not.toBe(true)
      expect(gameStartCount).toBe(0)
      expect(beginTurnCount).toBe(0)
      expect(battle.deployment?.offerPieceIds).toBeUndefined()
      expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[0]]).toBeUndefined()
      expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]]).toBeUndefined()
      expect(battle.actions?.filter(action => action.type === 'terminalResult')).toHaveLength(1)
    } finally {
      triggerSpy.mockRestore()
    }
  })

  it('settles a gameStart core elimination before generating the first offer', async () => {
    const seed = ROOT_SEED + 31
    let beginTurnCount = 0
    const checkTriggers = globalTriggerSystem.checkTriggers.bind(globalTriggerSystem)
    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers').mockImplementation((state, context) => {
      const result = checkTriggers(state, context)
      if (context.type === 'gameStart') {
        const source = state.pieces.find(piece => piece.ownerPlayerId === PLAYERS[0] && piece.currentHp > 0)
        const victim = state.pieces.find(piece => piece.ownerPlayerId === PLAYERS[1] && piece.currentHp > 0)
        if (!source || !victim) throw new Error('Missing opening cores for gameStart terminal probe')
        dealDamage(
          source,
          victim,
          victim.currentHp,
          'true',
          state,
          'red-138-gamestart-core-elimination',
        )
      } else if (context.type === 'beginTurn') {
        beginTurnCount += 1
      }
      return result
    })

    try {
      const battle = await createProgressiveBattle(seed)
      const cursors = committedRuntimeCursors(battle)

      expect(battle.gameStartFired).toBe(true)
      expect(battle.terminalResult).toMatchObject({
        winnerPlayerId: PLAYERS[0],
        loserPlayerId: PLAYERS[1],
        reason: 'core-eliminated',
      })
      expect(beginTurnCount).toBe(0)
      expect(battle.deployment?.offerPieceIds).toBeUndefined()
      expect(battle.deployment?.status).toBe('turn-ready')
      expect(cursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[0]]).toBeUndefined()
    } finally {
      triggerSpy.mockRestore()
    }
  })

  it('attributes timeout auto-deployment after a mandatory gameStart interaction to the timeout trace', async () => {
    const seed = ROOT_SEED + 38
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'red-138-interactive-gamestart-timeout',
      name: 'RED-138 interactive gameStart timeout probe',
      description: '',
      priority: 20,
      trigger: { type: 'gameStart' },
      effect: (_battle: BattleState, context: any) => {
        if (context.selectedOption !== 'continue') {
          return {
            needsOptionSelection: true,
            playerId: context.playerId,
            title: 'Resolve gameStart trigger',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        return { success: true }
      },
    }] as any)

    try {
      const redBoard = { ...reserveCore('gamestart-red-board', PLAYERS[0]), x: 0, y: 0 }
      const blueBoard = { ...reserveCore('gamestart-blue-board', PLAYERS[1]), x: 19, y: 0 }
      const base = makeState({
        pieces: [redBoard as any, blueBoard as any],
        currentPlayerId: PLAYERS[0],
        phase: 'start',
        width: 20,
        height: 1,
      })
      base.gameStartFired = false
      base.deployment = {
        mode: 'progressive-reserve-v1',
        status: 'turn-ready',
        playerIds: [...PLAYERS],
        choices: {},
        locks: {},
        startedAt: 0,
        deadlineAt: 0,
        revision: 0,
        initialPositions: {
          [redBoard.instanceId]: { x: 0, y: 0 },
          [blueBoard.instanceId]: { x: 19, y: 0 },
        },
        openingVanguardsInitialized: true,
        reserves: {
          [PLAYERS[0]]: [reserveCore('gamestart-red-reserve', PLAYERS[0])],
          [PLAYERS[1]]: [reserveCore('gamestart-blue-reserve', PLAYERS[1])],
        },
      }
      initializeTrackedState(base, seed)
      const pending = runBattleAction(base, { type: 'beginPhase' }, { rootSeed: seed }).state
      expect(pending.pendingOptionSelection).toBeDefined()
      expect(pending.deployment).toMatchObject({ status: 'turn-ready' })
      expect(pending.deployment?.lastDeployedPieceId).toBeUndefined()
      pending.turnTimer = createRunningTurnTimer(pending, 10_000)

      const timeoutResult = runBattleAction(pending, {
        type: 'turnTimeout',
        now: pending.turnTimer.deadlineAt,
        expectedTurnNumber: pending.turnTimer.turnNumber,
        expectedDeadlineAt: pending.turnTimer.deadlineAt,
      }, { rootSeed: seed })
      const settled = timeoutResult.state
      const deployedPieceId = settled.actions?.find(entry => entry.type === 'deployReservePiece')
        ?.payload?.pieceId as string | undefined
      const deployLog = settled.actions?.find(entry =>
        entry.type === 'deployReservePiece' && entry.payload?.pieceId === deployedPieceId)

      expect(settled.pendingOptionSelection).toBeUndefined()
      expect(settled.pendingTargetSelection).toBeUndefined()
      expect(deployedPieceId).toBeTruthy()
      expect(timeoutResult.trace?.deployment).toMatchObject({
        command: 'timeout',
        lastDeployedPieceId: deployedPieceId,
        deployedPosition: {
          x: deployLog?.payload?.toX,
          y: deployLog?.payload?.toY,
        },
      })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('routes each opening vanguard through one formal before/after summon boundary without free movement', async () => {
    const events: Array<{ type: string; playerId?: string; pieceTemplateId?: string; sourcePieceId?: string }> = []
    const checkTriggers = globalTriggerSystem.checkTriggers.bind(globalTriggerSystem)
    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers').mockImplementation((state, context) => {
      if (context.type === 'beforePieceSummoned' || context.type === 'afterPieceSummoned') {
        events.push({
          type: context.type,
          playerId: context.playerId,
          pieceTemplateId: context.pieceTemplateId,
          sourcePieceId: context.sourcePiece?.instanceId,
        })
      }
      return checkTriggers(state, context)
    })

    try {
      const battle = await createProgressiveBattle()
      expect(events).toEqual([
        { type: 'beforePieceSummoned', playerId: PLAYERS[1], pieceTemplateId: 'blue-6', sourcePieceId: undefined },
        { type: 'afterPieceSummoned', playerId: PLAYERS[1], pieceTemplateId: 'blue-6', sourcePieceId: 'player-blue-6' },
        { type: 'beforePieceSummoned', playerId: PLAYERS[0], pieceTemplateId: 'red-1', sourcePieceId: undefined },
        { type: 'afterPieceSummoned', playerId: PLAYERS[0], pieceTemplateId: 'red-1', sourcePieceId: 'player-red-1' },
      ])
      expect(battle.pieces.every(piece =>
        piece.statusTags.every(tag => tag.type !== 'deployment-first-move-free'))).toBe(true)
      expect(battle.deployment?.lastDeployedPieceId).toBeUndefined()
    } finally {
      triggerSpy.mockRestore()
    }
  })

  it('keeps the stable reserve instances so opening Tyrande and Tirion resolve their summon rules', async () => {
    const tyrande = getPieceById('tyrande')
    const tirion = getPieceById('blue-tirion-fordring')
    if (!tyrande || !tirion) throw new Error('Missing RED-138 summon-rule templates')
    const red = [tyrande, ...templates('red').slice(0, 7)]
    const blue = templates('blue')
    blue[5] = tirion

    const battle = await createProgressiveBattle(9, red, blue)
    const redVanguard = battle.pieces.find(piece => piece.ownerPlayerId === PLAYERS[0])
    const blueVanguard = battle.pieces.find(piece => piece.ownerPlayerId === PLAYERS[1])
    const redPlayer = battle.players.find(player => player.playerId === PLAYERS[0]) as any

    expect(redVanguard).toMatchObject({
      instanceId: 'player-red-8',
      templateId: 'tyrande',
    })
    expect(redPlayer.statusTags).toContainEqual(expect.objectContaining({ type: 'elune-protection' }))
    expect(blueVanguard).toMatchObject({
      instanceId: 'player-blue-8',
      templateId: 'blue-tirion-fordring',
    })
    expect(blueVanguard?.statusTags).toContainEqual(expect.objectContaining({ type: 'divine-shield' }))
    expect(battle.pieces.every(piece =>
      piece.statusTags.every(tag => tag.type !== 'deployment-first-move-free'))).toBe(true)
  })

  it('deploys directly into action and consumes the visible current-turn tag on its first committed move', async () => {
    const initial = await createProgressiveBattle()
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const beforeAp = initial.players.find(player => player.playerId === PLAYERS[0])!.actionPoints

    const deployAction: BattleAction = {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId: offeredPieceId,
      toX: position.x,
      toY: position.y,
      clientActionId: 'deploy-1',
    }
    const deployed = runBattleAction(initial, deployAction, { rootSeed: ROOT_SEED }).state

    const piece = deployed.pieces.find(candidate => candidate.instanceId === offeredPieceId)!
    expect(piece).toMatchObject({ isCore: true, x: position.x, y: position.y })
    expect(deployed.deployment?.reserveCounts?.[PLAYERS[0]]).toBe(6)
    expect(deployed.turn.phase).toBe('action')
    expect(deployed.deployment?.status).toBe('turn-ready')
    expect(piece.statusTags).toContainEqual({
      id: 'deployment-first-move-free',
      type: 'deployment-first-move-free',
      name: '本回合首次移动免费',
      visible: true,
      grantedTurnNumber: deployed.turn.turnNumber,
      currentDuration: 1,
      currentUses: 1,
    })
    expect(deployed.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)

    const beforeDuplicateHash = hashBattleState(deployed)
    const beforeDuplicateCursors = committedRuntimeCursors(deployed)
    const duplicate = runBattleAction(deployed, deployAction, { rootSeed: ROOT_SEED })
    expect(duplicate.duplicate).toBe(true)
    expect(hashBattleState(duplicate.state)).toBe(beforeDuplicateHash)
    expect(committedRuntimeCursors(duplicate.state)).toEqual(beforeDuplicateCursors)

    const freeTarget = getLegalNormalMoveTargets(deployed, piece)[0]
    const afterFreeMove = runBattleAction(deployed, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: offeredPieceId,
      toX: freeTarget.x,
      toY: freeTarget.y,
    }, { rootSeed: ROOT_SEED }).state

    expect(afterFreeMove.turn.phase).toBe('action')
    expect(afterFreeMove.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
    expect(afterFreeMove.pieces.find(candidate => candidate.instanceId === offeredPieceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    expect(afterFreeMove.actions).toContainEqual(expect.objectContaining({
      type: 'move',
      payload: expect.objectContaining({ deploymentFirstMoveFree: true }),
    }))

    const currentPiece = afterFreeMove.pieces.find(candidate => candidate.instanceId === offeredPieceId)!
    const paidTarget = afterFreeMove.map.tiles.find(tile =>
      tile.props.walkable
      && ((tile.x === currentPiece.x && Math.abs(tile.y - currentPiece.y!) === 1)
        || (tile.y === currentPiece.y && Math.abs(tile.x - currentPiece.x!) === 1))
      && !afterFreeMove.pieces.some(candidate =>
        candidate.currentHp > 0 && candidate.x === tile.x && candidate.y === tile.y))
    if (!paidTarget) throw new Error('Expected adjacent paid move target')
    const afterPaidMove = runBattleAction(afterFreeMove, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: offeredPieceId,
      toX: paidTarget.x,
      toY: paidTarget.y,
    }, { rootSeed: ROOT_SEED }).state
    expect(afterPaidMove.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
      .toBe(beforeAp - 1)
  })

  it('allows the tagged first move at zero AP but rejects a second move', async () => {
    const seed = ROOT_SEED + 39
    const initial = await createProgressiveBattle(seed)
    const pieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    deployed.players.find(player => player.playerId === PLAYERS[0])!.actionPoints = 0
    const piece = deployed.pieces.find(candidate => candidate.instanceId === pieceId)!
    const freeTarget = getLegalNormalMoveTargets(deployed, piece)[0]

    const moved = runBattleAction(deployed, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId,
      toX: freeTarget.x,
      toY: freeTarget.y,
    }, { rootSeed: seed }).state
    expect(moved.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(0)

    const movedPiece = moved.pieces.find(candidate => candidate.instanceId === pieceId)!
    const paidTarget = getLegalNormalMoveTargets(moved, movedPiece)[0]
    expect(() => runBattleAction(moved, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId,
      toX: paidTarget.x,
      toY: paidTarget.y,
    }, { rootSeed: seed })).toThrow('Not enough action points to move')
  })

  it('continues deterministically after a real JSON save/reload with one free move followed by a paid move', async () => {
    const seed = ROOT_SEED + 40
    const initial = await createProgressiveBattle(seed)
    const pieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    const serializedSave = JSON.stringify(deployed)
    const restored = JSON.parse(serializedSave) as BattleState
    const restoredPiece = restored.pieces.find(piece => piece.instanceId === pieceId)!
    const firstTarget = getLegalNormalMoveTargets(restored, restoredPiece)[0]
    const firstMove: BattleAction = {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId,
      toX: firstTarget.x,
      toY: firstTarget.y,
    }
    const beforeAp = restored.players.find(player => player.playerId === PLAYERS[0])!.actionPoints

    expect(hashBattleState(restored)).toBe(hashBattleState(deployed))
    expect(restoredPiece.statusTags).toContainEqual(expect.objectContaining({
      type: 'deployment-first-move-free',
      grantedTurnNumber: restored.turn.turnNumber,
      currentUses: 1,
    }))
    const uninterruptedFirst = runBattleAction(deployed, firstMove, { rootSeed: seed }).state
    const resumedFirst = runBattleAction(restored, firstMove, { rootSeed: seed }).state

    expect(hashBattleState(resumedFirst)).toBe(hashBattleState(uninterruptedFirst))
    expect(resumedFirst.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
    expect(resumedFirst.pieces.find(piece => piece.instanceId === pieceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))

    const movedPiece = resumedFirst.pieces.find(piece => piece.instanceId === pieceId)!
    const secondTarget = getLegalNormalMoveTargets(resumedFirst, movedPiece)[0]
    const secondMove: BattleAction = {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId,
      toX: secondTarget.x,
      toY: secondTarget.y,
    }
    const uninterruptedSecond = runBattleAction(uninterruptedFirst, secondMove, { rootSeed: seed }).state
    const resumedSecond = runBattleAction(resumedFirst, secondMove, { rootSeed: seed }).state

    expect(hashBattleState(resumedSecond)).toBe(hashBattleState(uninterruptedSecond))
    expect(resumedSecond.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
      .toBe(beforeAp - 1)
    expect(resumedSecond.pieces.find(piece => piece.instanceId === pieceId)).toMatchObject({
      x: secondTarget.x,
      y: secondTarget.y,
    })
  })

  it('settles an afterMove core elimination before finishing deployment or advancing an offer', async () => {
    const seed = ROOT_SEED + 34
    const initial = await createProgressiveBattle(seed)
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId: offeredPieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    const deployedPiece = deployed.pieces.find(piece => piece.instanceId === offeredPieceId)!
    const freeTarget = getLegalNormalMoveTargets(deployed, deployedPiece)[0]
    const beforeCursors = committedRuntimeCursors(deployed)
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-free-move-eliminates-last-core',
        name: 'RED-138 free move eliminates last core',
        description: '',
        priority: 30,
        trigger: { type: 'afterMove' },
        effect: (battle: BattleState, context: any) => {
          const source = context.sourcePiece as PieceInstance | undefined
          if (source?.instanceId !== offeredPieceId) return { success: false }
          const target = battle.pieces.find(piece =>
            piece.ownerPlayerId === PLAYERS[1] && piece.isCore === true && piece.currentHp > 0)
          if (!target) throw new Error('Expected the opposing board core')
          dealDamage(source, target, target.currentHp, 'true', battle, 'red-138-free-move-elimination')
          return { success: true }
        },
      },
      {
        id: 'red-138-free-move-begin-turn-probe',
        name: 'RED-138 free move beginTurn probe',
        description: '',
        priority: 30,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).freeMoveBeginTurnCount =
            ((battle.extensions as any).freeMoveBeginTurnCount || 0) + 1
          return { success: true }
        },
      },
    ] as any)

    try {
      const settled = runBattleAction(deployed, {
        type: 'move',
        playerId: PLAYERS[0],
        pieceId: offeredPieceId,
        toX: freeTarget.x,
        toY: freeTarget.y,
      }, { rootSeed: seed }).state
      const afterCursors = committedRuntimeCursors(settled)

      expect(settled.terminalResult).toMatchObject({
        winnerPlayerId: PLAYERS[0],
        loserPlayerId: PLAYERS[1],
        reason: 'core-eliminated',
      })
      expect(settled.turn).toMatchObject({
        currentPlayerId: PLAYERS[0],
        turnNumber: 1,
        phase: 'action',
      })
      expect((settled.extensions as any).freeMoveBeginTurnCount).toBeUndefined()
      expect(settled.pieces.find(piece => piece.instanceId === offeredPieceId)?.statusTags)
        .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
      expect(afterCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
        .toBe(beforeCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
      expect(settled.actions?.filter(action =>
        action.type === 'move' && action.payload?.deploymentFirstMoveFree === true)).toHaveLength(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it.each(['return-to-origin', 'remove-mover'] as const)(
    'consumes a committed free move when afterMove effects %s',
    async mode => {
      const seed = mode === 'return-to-origin' ? ROOT_SEED + 35 : ROOT_SEED + 36
      const initial = await createProgressiveBattle(seed)
      const offeredPieceId = initial.deployment!.offerPieceIds![0]
      const position = initial.deployment!.legalPositions![0]
      const deployed = runBattleAction(initial, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: initial.deployment!.revision,
        pieceId: offeredPieceId,
        toX: position.x,
        toY: position.y,
      }, { rootSeed: seed }).state
      const moverBefore = deployed.pieces.find(piece => piece.instanceId === offeredPieceId)!
      const origin = { x: moverBefore.x, y: moverBefore.y }
      const freeTarget = getLegalNormalMoveTargets(deployed, moverBefore)[0]
      const beforeAp = deployed.players.find(player => player.playerId === PLAYERS[0])!.actionPoints
      const previousRules = [...globalTriggerSystem.getRules()]
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules([{
        id: 'red-138-free-move-' + mode,
        name: 'RED-138 free move ' + mode,
        description: '',
        priority: 30,
        trigger: { type: 'afterMove' },
        effect: (battle: BattleState, context: any) => {
          const source = context.sourcePiece as PieceInstance | undefined
          if (source?.instanceId !== offeredPieceId) return { success: false }
          if (mode === 'return-to-origin') {
            source.x = origin.x
            source.y = origin.y
          } else {
            const index = battle.pieces.findIndex(piece => piece.instanceId === offeredPieceId)
            const [removed] = index >= 0 ? battle.pieces.splice(index, 1) : []
            if (removed) {
              removed.currentHp = 0
              removed.x = null
              removed.y = null
              battle.graveyard.push(removed)
            }
          }
          return { success: true }
        },
      }] as any)

      let completed: BattleState
      try {
        completed = runBattleAction(deployed, {
          type: 'move',
          playerId: PLAYERS[0],
          pieceId: offeredPieceId,
          toX: freeTarget.x,
          toY: freeTarget.y,
        }, { rootSeed: seed }).state
      } finally {
        globalTriggerSystem.clearRules()
        globalTriggerSystem.addRules(previousRules)
      }

      expect(completed!.turn.phase).toBe('action')
      expect(completed!.deployment?.status).toBe('turn-ready')
      expect(completed!.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
      expect(completed!.actions?.filter(action =>
        action.type === 'move' && action.payload?.deploymentFirstMoveFree === true)).toHaveLength(1)
      if (mode === 'return-to-origin') {
        expect(completed!.pieces.find(piece => piece.instanceId === offeredPieceId))
          .toMatchObject(origin)
        const paid = runBattleAction(completed!, {
          type: 'move',
          playerId: PLAYERS[0],
          pieceId: offeredPieceId,
          toX: freeTarget.x,
          toY: freeTarget.y,
        }, { rootSeed: seed }).state
        expect(paid.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
          .toBe(beforeAp - 1)
      } else {
        expect(completed!.pieces.some(piece => piece.instanceId === offeredPieceId)).toBe(false)
        expect(completed!.graveyard).toContainEqual(expect.objectContaining({ instanceId: offeredPieceId }))
        expect(completed!.graveyard.find(piece => piece.instanceId === offeredPieceId)?.statusTags)
          .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
      }
    },
  )

  it('atomically rejects a tagged free move when beforeMove blocks after reading named RNG', async () => {
    const seed = ROOT_SEED + 37
    const initial = await createProgressiveBattle(seed)
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId: offeredPieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    const deployedPiece = deployed.pieces.find(piece => piece.instanceId === offeredPieceId)!
    const freeTarget = getLegalNormalMoveTargets(deployed, deployedPiece)[0]
    const beforeAp = deployed.players.find(player => player.playerId === PLAYERS[0])!.actionPoints
    const beforeState = safeCloneBattleState(deployed)
    const beforeHash = hashBattleState(deployed)
    const beforeCursors = committedRuntimeCursors(deployed)
    const beforeTargetingRevision = deployed.targetingRevision
    const beforeActionLog = (beforeState.extensions as any).debugBattle?.actionLog
    const beforePiece = beforeState.pieces.find(piece => piece.instanceId === offeredPieceId)!
    const blockedMoveStream = `${RANDOM_STREAM_NAMES.skillEffect}/red-138-blocked-free-move`
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'red-138-block-free-move',
      name: 'RED-138 block free move',
      description: '',
      priority: 30,
      trigger: { type: 'beforeMove' },
      effect: (battle: BattleState) => {
        const runtime = getActiveRuleRuntime()
        if (!runtime) throw new Error('Expected authoritative named RNG runtime')
        runtime.nextRandom(blockedMoveStream)
        battle.turn.actions.hasMoved = true
        return { success: true, blocked: true, message: 'blocked free move' }
      },
    }] as any)

    let rejection: unknown
    try {
      runBattleAction(deployed, {
        type: 'move',
        playerId: PLAYERS[0],
        pieceId: offeredPieceId,
        toX: freeTarget.x,
        toY: freeTarget.y,
      }, { rootSeed: seed }).state
    } catch (error) {
      rejection = error
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }

    expect(rejection).toMatchObject({
      name: 'BattleRuleError',
      code: 'DEPLOYMENT_FIRST_MOVE_BLOCKED',
    })
    expect((rejection as Error).message).toContain('blocked free move')
    expect(hashBattleState(deployed)).toBe(beforeHash)
    expect(committedRuntimeCursors(deployed)).toEqual(beforeCursors)
    expect(committedRuntimeCursors(deployed)[blockedMoveStream]).toBe(beforeCursors[blockedMoveStream])
    expect(deployed.targetingRevision).toBe(beforeTargetingRevision)
    expect((deployed.extensions as any).debugBattle?.actionLog).toEqual(beforeActionLog)
    expect(deployed.actions).toEqual(beforeState.actions)
    expect(deployed.turn.actions).toEqual(beforeState.turn.actions)
    expect(deployed.turn.phase).toBe('action')
    expect(deployed.deployment).toMatchObject({
      status: 'turn-ready',
      revision: deployed.deployment!.revision,
    })
    expect(deployed.pieces.find(piece => piece.instanceId === offeredPieceId)).toMatchObject({
      x: beforePiece.x,
      y: beforePiece.y,
    })
    expect(deployed.pieces.find(piece => piece.instanceId === offeredPieceId)?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    expect(deployed.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)

    const completed = runBattleAction(deployed, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId: offeredPieceId,
      toX: freeTarget.x,
      toY: freeTarget.y,
    }, { rootSeed: seed }).state
    expect(completed.turn.phase).toBe('action')
    expect(completed.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
    expect(completed.pieces.find(piece => piece.instanceId === offeredPieceId)).toMatchObject({
      x: freeTarget.x,
      y: freeTarget.y,
    })
    expect(completed.pieces.find(piece => piece.instanceId === offeredPieceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
  })

  it('does not consume the free-first-move tag when normal movement validation rejects the command', async () => {
    const seed = ROOT_SEED + 21
    const initial = await createProgressiveBattle(seed)
    const pieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deploymentRevision = initial.deployment!.revision
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: deploymentRevision,
      pieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    const piece = deployed.pieces.find(candidate => candidate.instanceId === pieceId)!
    const beforeHash = hashBattleState(deployed)
    const beforeCursors = committedRuntimeCursors(deployed)
    expect(() => runBattleAction(deployed, {
      type: 'move',
      playerId: PLAYERS[0],
      pieceId,
      toX: piece.x!,
      toY: piece.y!,
    }, { rootSeed: seed })).toThrow()
    expect(hashBattleState(deployed)).toBe(beforeHash)
    expect(committedRuntimeCursors(deployed)).toEqual(beforeCursors)
    expect(piece.statusTags).toContainEqual(expect.objectContaining({
      type: 'deployment-first-move-free',
      grantedTurnNumber: deployed.turn.turnNumber,
    }))
  })

  it('removes an unused free-first-move tag before handing authority to the next turn', async () => {
    const seed = ROOT_SEED + 38
    const initial = await createProgressiveBattle(seed)
    const pieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployed = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId,
      toX: position.x,
      toY: position.y,
    }, { rootSeed: seed }).state
    expect(deployed.pieces.find(piece => piece.instanceId === pieceId)?.statusTags)
      .toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))

    const ended = runBattleAction(deployed, {
      type: 'endTurn',
      playerId: PLAYERS[0],
    }, { rootSeed: seed }).state
    expect(ended.turn.phase).toBe('end')
    expect(ended.pieces.find(piece => piece.instanceId === pieceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
  })

  it('rejects an old deploy command when the same reserve piece is offered again on a later own turn', () => {
    const seed = ROOT_SEED + 22
    const redBoard = {
      ...reserveCore('red-board', PLAYERS[0]),
      x: 0,
      y: 0,
    }
    const blueBoard = {
      ...reserveCore('blue-board', PLAYERS[1]),
      x: 19,
      y: 0,
    }
    const base = makeState({
      pieces: [redBoard as any, blueBoard as any],
      currentPlayerId: PLAYERS[0],
      phase: 'start',
      width: 20,
      height: 1,
    })
    base.gameStartFired = true
    base.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      playerIds: [...PLAYERS],
      choices: {},
      locks: {},
      startedAt: 0,
      deadlineAt: 0,
      revision: 0,
      initialPositions: {},
      reserves: {
        [PLAYERS[0]]: [
          reserveCore('repeat-next-turn', PLAYERS[0]),
          reserveCore('deploy-this-turn', PLAYERS[0]),
        ],
        [PLAYERS[1]]: [],
      },
    }
    initializeTrackedState(base, seed)

    const firstOffer = runBattleAction(base, { type: 'beginPhase' }, { rootSeed: seed }).state
    expect(new Set(firstOffer.deployment?.offerPieceIds)).toEqual(new Set([
      'repeat-next-turn',
      'deploy-this-turn',
    ]))
    const oldPosition = firstOffer.deployment!.legalPositions![0]
    const deployedPosition = firstOffer.deployment!.legalPositions!.find(position =>
      manhattanDistance(position, oldPosition) > DEPLOYMENT_SAFE_DISTANCE)
    if (!deployedPosition) throw new Error('Expected two mutually safe deployment cells')
    const oldCommand: BattleAction = {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: firstOffer.deployment!.revision,
      pieceId: 'repeat-next-turn',
      toX: oldPosition.x,
      toY: oldPosition.y,
    }

    let progressed = runBattleAction(firstOffer, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: firstOffer.deployment!.revision,
      pieceId: 'deploy-this-turn',
      toX: deployedPosition.x,
      toY: deployedPosition.y,
    }, { rootSeed: seed }).state
    progressed = runBattleAction(progressed, {
      type: 'endTurn',
      playerId: PLAYERS[0],
    }, { rootSeed: seed }).state
    progressed = runBattleAction(progressed, { type: 'beginPhase' }, { rootSeed: seed }).state
    expect(progressed.turn.currentPlayerId).toBe(PLAYERS[1])
    expect(progressed.turn.phase).toBe('action')
    progressed = runBattleAction(progressed, {
      type: 'endTurn',
      playerId: PLAYERS[1],
    }, { rootSeed: seed }).state
    progressed = runBattleAction(progressed, { type: 'beginPhase' }, { rootSeed: seed }).state

    expect(progressed.deployment).toMatchObject({
      status: 'awaiting-reserve-deploy',
      activePlayerId: PLAYERS[0],
      offerPieceIds: ['repeat-next-turn'],
    })
    expect(progressed.deployment?.legalPositions).toContainEqual(oldPosition)
    expect(progressed.deployment!.revision).toBeGreaterThan(oldCommand.expectedDeploymentRevision)
    expectStaleRevisionRejectedWithoutMutation(progressed, oldCommand, seed)
  })

  it('follows N(t)=min(t+1,8) for both players until every ordinary reserve is empty', async () => {
    let state = await createProgressiveBattle(ROOT_SEED + 20)
    const ownDeployments: Record<string, number> = {
      [PLAYERS[0]]: 0,
      [PLAYERS[1]]: 0,
    }

    for (let index = 0; index < 14; index += 1) {
      const playerId = state.turn.currentPlayerId
      const deployment = state.deployment!
      const pieceId = deployment.offerPieceIds?.[0]
      if (!pieceId || deployment.status !== 'awaiting-reserve-deploy') {
        throw new Error(`Expected mandatory reserve offer for ${playerId}`)
      }
      const position = deployment.legalPositions?.[0]
      const action: BattleAction = {
        type: 'deployReservePiece',
        playerId,
        expectedDeploymentRevision: deployment.revision,
        pieceId,
        ...(position ? { toX: position.x, toY: position.y } : {}),
      }
      state = runBattleAction(state, action, { rootSeed: ROOT_SEED + 20 }).state

      ownDeployments[playerId] += 1
      expect(state.pieces.filter(piece =>
        piece.ownerPlayerId === playerId && piece.isCore === true)).toHaveLength(
        Math.min(ownDeployments[playerId] + 1, 8),
      )
      expect(state.deployment?.reserveCounts?.[playerId]).toBe(7 - ownDeployments[playerId])

      if (index < 13) {
        state = runBattleAction(state, {
          type: 'endTurn',
          playerId,
        }, { rootSeed: ROOT_SEED + 20 }).state
        state = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: ROOT_SEED + 20 }).state
      }
    }

    expect(ownDeployments).toEqual({ [PLAYERS[0]]: 7, [PLAYERS[1]]: 7 })
    expect(state.pieces.filter(piece => piece.isCore === true)).toHaveLength(16)
    expect(state.deployment).toMatchObject({
      status: 'complete',
      reserveCounts: { [PLAYERS[0]]: 0, [PLAYERS[1]]: 0 },
    })
  }, 10_000)

  it('offers safe cells strictly beyond five squares from every living piece', async () => {
    const initial = await createProgressiveBattle()
    const redPieceId = initial.deployment!.offerPieceIds![0]
    const redPosition = initial.deployment!.legalPositions![0]
    let state = runBattleAction(initial, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: initial.deployment!.revision,
      pieceId: redPieceId,
      toX: redPosition.x,
      toY: redPosition.y,
    }, { rootSeed: ROOT_SEED }).state
    state = runBattleAction(state, {
      type: 'endTurn',
      playerId: PLAYERS[0],
    }, { rootSeed: ROOT_SEED }).state
    state = runBattleAction(state, {
      type: 'beginPhase',
    }, { rootSeed: ROOT_SEED }).state

    expect(state.deployment?.activePlayerId).toBe(PLAYERS[1])
    expect(state.deployment?.legalPositions?.length).toBeGreaterThan(0)
    for (const candidate of state.deployment!.legalPositions!) {
      expect(manhattanDistance(candidate, state.pieces[0])).toBeGreaterThan(DEPLOYMENT_SAFE_DISTANCE)
    }
  })

  it('uses one deterministic random empty cell when no distance-safe cell exists', () => {
    const makeFallbackState = (seed: number) => {
      const blockers = [
        {
          ...(makePiece({ instanceId: 'red-blocker', ownerPlayerId: PLAYERS[0], x: 1, y: 1 }) as any),
          isCore: true,
          name: 'red blocker',
          buffs: [],
          debuffs: [],
          ruleTags: [],
        },
        {
          ...(makePiece({ instanceId: 'blue-blocker', ownerPlayerId: PLAYERS[1], x: 0, y: 0 }) as any),
          isCore: true,
          name: 'blue blocker',
          buffs: [],
          debuffs: [],
          ruleTags: [],
        },
      ]
      const state = makeState({
        pieces: blockers,
        currentPlayerId: PLAYERS[0],
        phase: 'start',
        width: 3,
        height: 3,
      })
      state.deployment = {
        mode: 'progressive-reserve-v1',
        status: 'turn-ready',
        playerIds: [...PLAYERS],
        choices: {},
        locks: {},
        startedAt: 0,
        deadlineAt: 0,
        revision: 0,
        initialPositions: {},
        reserves: {
          [PLAYERS[0]]: [reserveCore('red-reserve', PLAYERS[0])],
          [PLAYERS[1]]: [reserveCore('blue-reserve', PLAYERS[1])],
        },
      }
      return initializeTrackedState(state, seed)
    }
    const resolve = (seed: number) => {
      const offered = runBattleAction(makeFallbackState(seed), { type: 'beginPhase' }, { rootSeed: seed }).state
      expect(offered.deployment?.legalPositions).toEqual([])
      const deployed = runBattleAction(offered, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: offered.deployment!.revision,
        pieceId: 'red-reserve',
      }, { rootSeed: seed })
      return deployed
    }

    const first = resolve(99138)
    const repeated = resolve(99138)
    const deployedPiece = first.state.pieces.find(piece => piece.instanceId === 'red-reserve')!
    const deployLog = first.state.actions?.findLast(action =>
      action.type === 'deployReservePiece' && action.payload?.pieceId === 'red-reserve') as any
    const committedPosition = { x: deployLog.payload.toX, y: deployLog.payload.toY }
    expect(getEmptyWalkableDeploymentPositions(makeFallbackState(99138))).toContainEqual({
      x: deployedPiece.x,
      y: deployedPiece.y,
    })
    expect([deployedPiece.x, deployedPiece.y]).not.toEqual([1, 1])
    expect(first.trace?.randomStreams).toContainEqual(expect.objectContaining({
      name: `${RANDOM_STREAM_NAMES.progressiveDeploymentFallback}/player-red`,
      startCursor: 0,
      endCursor: 1,
    }))
    expect(first.trace?.deployment?.deployedPosition).toEqual(committedPosition)
    expect(committedPosition).toEqual({ x: deployedPiece.x, y: deployedPiece.y })
    expect([deployedPiece.x, deployedPiece.y]).toEqual([
      repeated.state.pieces.find(piece => piece.instanceId === 'red-reserve')?.x,
      repeated.state.pieces.find(piece => piece.instanceId === 'red-reserve')?.y,
    ])
    expect(hashBattleState(first.state)).toBe(hashBattleState(repeated.state))
  })

  it('fails closed without consuming the reserve when no empty walkable cell exists', () => {
    const blockers = Array.from({ length: 4 }, (_, index) => ({
      ...(makePiece({
        instanceId: `blocker-${index}`,
        ownerPlayerId: PLAYERS[index % 2],
        x: index % 2,
        y: Math.floor(index / 2),
      }) as any),
      isCore: true,
      name: `blocker-${index}`,
      buffs: [],
      debuffs: [],
      ruleTags: [],
    }))
    const state = makeState({
      pieces: blockers,
      currentPlayerId: PLAYERS[0],
      phase: 'start',
      width: 2,
      height: 2,
    })
    state.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      playerIds: [...PLAYERS],
      choices: {},
      locks: {},
      startedAt: 0,
      deadlineAt: 0,
      revision: 0,
      initialPositions: {},
      reserves: {
        [PLAYERS[0]]: [reserveCore('red-reserve', PLAYERS[0])],
        [PLAYERS[1]]: [reserveCore('blue-reserve', PLAYERS[1])],
      },
    }
    initializeTrackedState(state, ROOT_SEED + 2)
    const offered = runBattleAction(state, { type: 'beginPhase' }, {
      rootSeed: ROOT_SEED + 2,
    }).state
    const beforeHash = hashBattleState(offered)

    expect(getEmptyWalkableDeploymentPositions(offered)).toEqual([])
    expect(() => runBattleAction(offered, {
      type: 'deployReservePiece',
      playerId: PLAYERS[0],
      expectedDeploymentRevision: offered.deployment!.revision,
      pieceId: 'red-reserve',
    }, { rootSeed: ROOT_SEED + 2 })).toThrow('No empty walkable deployment position exists')
    expect(hashBattleState(offered)).toBe(beforeHash)
    expect(offered.deployment?.reserves?.[PLAYERS[0]]?.map(piece => piece.instanceId))
      .toEqual(['red-reserve'])
    expect(offered.pieces.some(piece => piece.instanceId === 'red-reserve')).toBe(false)
  })

  it('fails the complete timeout command closed when mandatory deployment has no empty cell', () => {
    const seed = ROOT_SEED + 8
    const blockers = Array.from({ length: 4 }, (_, index) => ({
      ...(makePiece({
        instanceId: `timeout-blocker-${index}`,
        ownerPlayerId: PLAYERS[index % 2],
        x: index % 2,
        y: Math.floor(index / 2),
      }) as any),
      isCore: true,
      name: `timeout-blocker-${index}`,
      buffs: [],
      debuffs: [],
      ruleTags: [],
    }))
    const state = makeState({
      pieces: blockers,
      currentPlayerId: PLAYERS[0],
      phase: 'start',
      width: 2,
      height: 2,
    })
    state.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      playerIds: [...PLAYERS],
      choices: {},
      locks: {},
      startedAt: 0,
      deadlineAt: 0,
      revision: 0,
      initialPositions: {},
      reserves: {
        [PLAYERS[0]]: [reserveCore('timeout-red-reserve', PLAYERS[0])],
        [PLAYERS[1]]: [reserveCore('timeout-blue-reserve', PLAYERS[1])],
      },
    }
    initializeTrackedState(state, seed)
    const offered = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: seed }).state
    offered.turnTimer = createRunningTurnTimer(offered, 10_000)
    const beforeHash = hashBattleState(offered)

    expect(() => runBattleAction(offered, {
      type: 'turnTimeout',
      now: offered.turnTimer!.deadlineAt,
      expectedTurnNumber: offered.turnTimer!.turnNumber,
      expectedDeadlineAt: offered.turnTimer!.deadlineAt,
    }, { rootSeed: seed })).toThrow('No empty walkable deployment position exists')
    expect(hashBattleState(offered)).toBe(beforeHash)
    expect(offered.deployment?.status).toBe('awaiting-reserve-deploy')
    expect(offered.deployment?.reserves?.[PLAYERS[0]]?.map(piece => piece.instanceId))
      .toEqual(['timeout-red-reserve'])
    expect(offered.pieces.some(piece => piece.instanceId === 'timeout-red-reserve')).toBe(false)
  })

  it('auto-deploys the first offer, skips its free move, and advances on turn timeout', async () => {
    const initial = await createProgressiveBattle(ROOT_SEED + 3)
    const expectedPieceId = initial.deployment!.offerPieceIds![0]
    initial.turnTimer = createRunningTurnTimer(initial, 10_000)

    const timeoutResult = runBattleAction(initial, {
      type: 'turnTimeout',
      now: initial.turnTimer.deadlineAt,
      expectedTurnNumber: initial.turnTimer.turnNumber,
      expectedDeadlineAt: initial.turnTimer.deadlineAt,
    }, { rootSeed: ROOT_SEED + 3 })
    const timedOut = timeoutResult.state

    expect(timedOut.pieces).toContainEqual(expect.objectContaining({
      instanceId: expectedPieceId,
      ownerPlayerId: PLAYERS[0],
      isCore: true,
    }))
    expect(timedOut.turn.currentPlayerId).toBe(PLAYERS[1])
    expect(timedOut.deployment).toMatchObject({
      status: 'awaiting-reserve-deploy',
      activePlayerId: PLAYERS[1],
    })
    expect(timedOut.pieces.find(piece => piece.instanceId === expectedPieceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    const deployLog = timedOut.actions?.find(entry =>
      entry.type === 'deployReservePiece' && entry.payload?.pieceId === expectedPieceId)
    expect(timeoutResult.trace?.deployment).toMatchObject({
      command: 'timeout',
      lastDeployedPieceId: expectedPieceId,
      deployedPosition: {
        x: deployLog?.payload?.toX,
        y: deployLog?.payload?.toY,
      },
    })
  })

  it('settles an after-summon core elimination before free movement or beginTurn', async () => {
    const seed = ROOT_SEED + 32
    const initial = await createProgressiveBattle(seed)
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const offeredPiece = initial.deployment!.reserves?.[PLAYERS[0]]
      ?.find(piece => piece.instanceId === offeredPieceId)
    if (!offeredPiece) throw new Error('Expected the offered reserve piece')
    offeredPiece.moveRange = 0
    const position = initial.deployment!.legalPositions![0]
    const beforeCursors = committedRuntimeCursors(initial)
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-deploy-eliminates-last-core',
        name: 'RED-138 deploy eliminates last core',
        description: '',
        priority: 30,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState, context: any) => {
          const source = context.sourcePiece as PieceInstance | undefined
          if (source?.instanceId !== offeredPieceId) return { success: false }
          const target = battle.pieces.find(piece =>
            piece.ownerPlayerId === PLAYERS[1] && piece.isCore === true && piece.currentHp > 0)
          if (!target) throw new Error('Expected the opposing board core')
          dealDamage(source, target, target.currentHp, 'true', battle, 'red-138-deploy-elimination')
          return { success: true }
        },
      },
      {
        id: 'red-138-deploy-begin-turn-probe',
        name: 'RED-138 deploy beginTurn probe',
        description: '',
        priority: 30,
        trigger: { type: 'beginTurn' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).deployBeginTurnCount =
            ((battle.extensions as any).deployBeginTurnCount || 0) + 1
          return { success: true }
        },
      },
    ] as any)

    try {
      const settled = runBattleAction(initial, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: initial.deployment!.revision,
        pieceId: offeredPieceId,
        toX: position.x,
        toY: position.y,
      }, { rootSeed: seed }).state
      const afterCursors = committedRuntimeCursors(settled)

      expect(settled.terminalResult).toMatchObject({
        winnerPlayerId: PLAYERS[0],
        loserPlayerId: PLAYERS[1],
        reason: 'core-eliminated',
      })
      expect(settled.turn).toMatchObject({
        currentPlayerId: PLAYERS[0],
        turnNumber: 1,
        phase: 'start',
      })
      expect((settled.extensions as any).deployBeginTurnCount).toBeUndefined()
      expect(settled.deployment).toMatchObject({ status: 'turn-ready' })
      expect(settled.pieces.every(piece =>
        piece.statusTags.every(tag => tag.type !== 'deployment-first-move-free'))).toBe(true)
      expect(afterCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
        .toBe(beforeCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
      expect(settled.actions?.filter(action => action.type === 'terminalResult')).toHaveLength(1)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('stops timeout immediately when auto-deploy summon triggers eliminate the last enemy core', async () => {
    const seed = ROOT_SEED + 33
    const initial = await createProgressiveBattle(seed)
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const offeredPiece = initial.deployment!.reserves?.[PLAYERS[0]]
      ?.find(piece => piece.instanceId === offeredPieceId)
    if (!offeredPiece) throw new Error('Expected the timeout offer in reserve')
    offeredPiece.moveRange = 0
    initial.turnTimer = createRunningTurnTimer(initial, 10_000)
    const beforeCursors = committedRuntimeCursors(initial)
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-timeout-deploy-eliminates-last-core',
        name: 'RED-138 timeout deploy eliminates last core',
        description: '',
        priority: 30,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState, context: any) => {
          const source = context.sourcePiece as PieceInstance | undefined
          if (source?.instanceId !== offeredPieceId) return { success: false }
          const target = battle.pieces.find(piece =>
            piece.ownerPlayerId === PLAYERS[1] && piece.isCore === true && piece.currentHp > 0)
          if (!target) throw new Error('Expected the opposing board core')
          dealDamage(source, target, target.currentHp, 'true', battle, 'red-138-timeout-deploy-elimination')
          return { success: true }
        },
      },
      ...(['beginTurn', 'endTurn'] as const).map(type => ({
        id: 'red-138-timeout-' + type + '-probe',
        name: 'RED-138 timeout ' + type + ' probe',
        description: '',
        priority: 30,
        trigger: { type },
        effect: (battle: BattleState) => {
          const counts = ((battle.extensions as any).timeoutPhaseCounts ??= {})
          counts[type] = (counts[type] || 0) + 1
          return { success: true }
        },
      })),
    ] as any)

    try {
      const settled = runBattleAction(initial, {
        type: 'turnTimeout',
        now: initial.turnTimer.deadlineAt,
        expectedTurnNumber: initial.turnTimer.turnNumber,
        expectedDeadlineAt: initial.turnTimer.deadlineAt,
      }, { rootSeed: seed }).state
      const afterCursors = committedRuntimeCursors(settled)

      expect(settled.terminalResult).toMatchObject({
        winnerPlayerId: PLAYERS[0],
        loserPlayerId: PLAYERS[1],
        reason: 'core-eliminated',
      })
      expect(settled.turn).toMatchObject({
        currentPlayerId: PLAYERS[0],
        turnNumber: 1,
        phase: 'start',
      })
      expect((settled.extensions as any).timeoutPhaseCounts).toBeUndefined()
      expect(settled.actions?.some(action => action.type === 'endTurn')).toBe(false)
      expect(settled.deployment).toMatchObject({ status: 'turn-ready' })
      expect(settled.pieces.every(piece =>
        piece.statusTags.every(tag => tag.type !== 'deployment-first-move-free'))).toBe(true)
      expect(afterCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
        .toBe(beforeCursors[RANDOM_STREAM_NAMES.progressiveDeploymentOffer + '/' + PLAYERS[1]])
      expect(settled.turnTimer).toMatchObject({ status: 'stopped', remainingMs: 0 })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('traces the trigger-adjusted safe position actually committed by reserve deployment', async () => {
    const seed = ROOT_SEED + 38
    const initial = await createProgressiveBattle(seed)
    const deployment = initial.deployment!
    const offeredPieceId = deployment.offerPieceIds![0]
    const requested = deployment.legalPositions![0]
    const redirected = deployment.legalPositions!.find(position =>
      position.x !== requested.x || position.y !== requested.y)
    if (!redirected) throw new Error('Expected a second authoritative safe deployment cell')
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'red-138-safe-before-summon-redirect',
      name: 'RED-138 safe before-summon redirect',
      description: '',
      priority: 20,
      trigger: { type: 'beforePieceSummoned' },
      effect: (_battle: BattleState, context: any) => {
        context.targetPosition = { ...redirected }
        return { success: true }
      },
    }] as any)

    try {
      const result = runBattleAction(initial, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: deployment.revision,
        pieceId: offeredPieceId,
        toX: requested.x,
        toY: requested.y,
      }, { rootSeed: seed })
      const deployedPiece = result.state.pieces.find(piece => piece.instanceId === offeredPieceId)
      const deployLog = result.state.actions?.findLast(action =>
        action.type === 'deployReservePiece' && action.payload?.pieceId === offeredPieceId) as any
      const committedPosition = { x: deployLog.payload.toX, y: deployLog.payload.toY }

      expect(committedPosition).not.toEqual(requested)
      expect(committedPosition).toEqual(redirected)
      expect(deployedPiece).toMatchObject(committedPosition)
      expect(result.trace?.deployment?.deployedPosition).toEqual(committedPosition)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('rejects a before-summon trigger that redirects a safe deployment into the exclusion radius', async () => {
    const seed = ROOT_SEED + 31
    const initial = await createProgressiveBattle(seed)
    const deployment = initial.deployment!
    const offeredPieceId = deployment.offerPieceIds![0]
    const requested = deployment.legalPositions![0]
    const unsafe = getEmptyWalkableDeploymentPositions(initial).find(position =>
      initial.pieces.some(piece =>
        piece.currentHp > 0
        && piece.x !== null
        && piece.y !== null
        && manhattanDistance(position, piece) <= DEPLOYMENT_SAFE_DISTANCE))
    if (!unsafe) throw new Error('Expected an empty cell inside the deployment exclusion radius')

    const beforeHash = hashBattleState(initial)
    const beforeCursors = committedRuntimeCursors(initial)
    const beforeReserveIds = deployment.reserves?.[PLAYERS[0]]?.map(piece => piece.instanceId)
    const beforeTraceCount = initial.extensions?.debugBattle?.actionLog?.length
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'red-138-unsafe-before-summon-redirect',
      name: 'RED-138 unsafe before-summon redirect',
      description: '',
      priority: 20,
      trigger: { type: 'beforePieceSummoned' },
      effect: (_battle: BattleState, context: any) => {
        context.targetPosition = { ...unsafe }
        return { success: true }
      },
    }] as any)

    try {
      let rejection: unknown
      try {
        runBattleAction(initial, {
          type: 'deployReservePiece',
          playerId: PLAYERS[0],
          expectedDeploymentRevision: deployment.revision,
          pieceId: offeredPieceId,
          toX: requested.x,
          toY: requested.y,
        }, { rootSeed: seed })
      } catch (error) {
        rejection = error
      }

      expect(rejection).toMatchObject({
        code: 'PROGRESSIVE_DEPLOYMENT_TRIGGER_POSITION_INVALID',
      })
      expect(hashBattleState(initial)).toBe(beforeHash)
      expect(committedRuntimeCursors(initial)).toEqual(beforeCursors)
      expect(initial.deployment?.reserves?.[PLAYERS[0]]?.map(piece => piece.instanceId))
        .toEqual(beforeReserveIds)
      expect(initial.pieces.some(piece => piece.instanceId === offeredPieceId)).toBe(false)
      expect(initial.extensions?.debugBattle?.actionLog).toHaveLength(beforeTraceCount ?? 0)
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('replays deploy and tagged first-move commands to an identical final state hash', async () => {
    const initial = await createProgressiveBattle(ROOT_SEED + 4)
    const pieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const deployAction: BattleAction = {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: initial.deployment!.revision,
        pieceId,
        toX: position.x,
        toY: position.y,
    }
    const preview = runBattleAction(safeCloneBattleState(initial), deployAction, {
      rootSeed: ROOT_SEED + 4,
    }).state
    const previewPiece = preview.pieces.find(candidate => candidate.instanceId === pieceId)!
    const movePosition = getLegalNormalMoveTargets(preview, previewPiece)[0]
    const actions: BattleAction[] = [
      deployAction,
      {
        type: 'move',
        playerId: PLAYERS[0],
        pieceId,
        toX: movePosition.x,
        toY: movePosition.y,
      },
    ]

    const first = replayBattle({
      initialState: safeCloneBattleState(initial),
      actions,
      seed: ROOT_SEED + 4,
    })
    const repeated = replayBattle({
      initialState: safeCloneBattleState(initial),
      actions,
      seed: ROOT_SEED + 4,
    })

    expect(first.actionsApplied).toBe(2)
    expect(first.actionHashes).toEqual(repeated.actionHashes)
    expect(first.stateHashes).toEqual(repeated.stateHashes)
    expect(first.finalStateHash).toBe(repeated.finalStateHash)
  })

  it('does not reuse a prior turn deployment position while a later summon queue is pending', async () => {
    const seed = ROOT_SEED + 37
    let state = await createProgressiveBattle(seed)

    for (const playerId of PLAYERS) {
      const pieceId = state.deployment!.offerPieceIds![0]
      const position = state.deployment!.legalPositions![0]
      state = runBattleAction(state, {
        type: 'deployReservePiece',
        playerId,
        expectedDeploymentRevision: state.deployment!.revision,
        pieceId,
        toX: position.x,
        toY: position.y,
      }, { rootSeed: seed }).state
      state = runBattleAction(state, {
        type: 'endTurn',
        playerId,
      }, { rootSeed: seed }).state
      state = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: seed }).state
    }

    expect(state.turn.currentPlayerId).toBe(PLAYERS[0])
    expect(state.deployment?.status).toBe('awaiting-reserve-deploy')
    const priorPieceId = state.deployment!.lastDeployedPieceId
    const offeredPieceId = state.deployment!.offerPieceIds![0]
    const position = state.deployment!.legalPositions![0]
    expect(priorPieceId).toBeTruthy()
    expect(priorPieceId).not.toBe(offeredPieceId)

    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([{
      id: 'red-138-later-turn-interactive-after-summon',
      name: 'RED-138 later turn interactive summon probe',
      description: '',
      priority: 20,
      trigger: { type: 'afterPieceSummoned' },
      effect: (_battle: BattleState, context: any) => {
        if (context.selectedOption === undefined) {
          return {
            needsOptionSelection: true,
            playerId: context.playerId,
            title: 'Resolve later summon trigger',
            options: [{ label: 'Continue', value: 'continue' }],
            canCancel: false,
          }
        }
        return { success: true }
      },
    }] as any)

    try {
      const pendingResult = runBattleAction(state, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: state.deployment!.revision,
        pieceId: offeredPieceId,
        toX: position.x,
        toY: position.y,
      }, { rootSeed: seed })

      expect(pendingResult.state.pendingOptionSelection).toBeDefined()
      expect(pendingResult.state.deployment?.lastDeployedPieceId).toBe(priorPieceId)
      expect(pendingResult.trace?.deployment).toMatchObject({
        command: 'deploy',
        lastDeployedPieceId: priorPieceId,
      })
      expect(pendingResult.trace?.deployment?.deployedPosition).toBeUndefined()
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('keeps reserve deployment atomic until the complete interactive summon queue settles', async () => {
    const seed = ROOT_SEED + 5
    const initial = await createProgressiveBattle(seed)
    const offeredPieceId = initial.deployment!.offerPieceIds![0]
    const position = initial.deployment!.legalPositions![0]
    const beforeAp = initial.players.find(player => player.playerId === PLAYERS[0])!.actionPoints
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-interactive-after-summon',
        name: 'RED-138 interactive summon probe',
        description: '',
        priority: 20,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState, context: any) => {
          if (context.selectedOption === undefined) {
            return {
              needsOptionSelection: true,
              playerId: context.playerId,
              title: 'Resolve summon trigger',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          ;(battle.extensions as any).summonChoiceCount =
            ((battle.extensions as any).summonChoiceCount || 0) + 1
          return { success: true, message: 'summon choice resolved' }
        },
      },
      {
        id: 'red-138-after-summon-queue-tail',
        name: 'RED-138 summon queue tail probe',
        description: '',
        priority: 10,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).summonQueueTailCount =
            ((battle.extensions as any).summonQueueTailCount || 0) + 1
          return { success: true, message: 'summon queue tail resolved' }
        },
      },
    ] as any)

    try {
      const pendingResult = runBattleAction(initial, {
        type: 'deployReservePiece',
        playerId: PLAYERS[0],
        expectedDeploymentRevision: initial.deployment!.revision,
        pieceId: offeredPieceId,
        toX: position.x,
        toY: position.y,
      }, { rootSeed: seed })
      const pending = pendingResult.state

      expect(pending.pendingOptionSelection?.source).toMatchObject({
        type: 'rule',
        id: 'red-138-interactive-after-summon',
      })
      expect(pending.pieces.some(piece => piece.instanceId === offeredPieceId)).toBe(false)
      expect(pending.deployment).toMatchObject({
        status: 'awaiting-reserve-deploy',
        reserveCounts: { [PLAYERS[0]]: 7, [PLAYERS[1]]: 7 },
      })
      expect(pending.pieces.some(piece => piece.statusTags.some(tag =>
        tag.type === 'deployment-first-move-free'))).toBe(false)
      expect((pending.extensions as any).summonChoiceCount).toBeUndefined()
      expect((pending.extensions as any).summonQueueTailCount).toBeUndefined()
      expect(pending.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
      expect(pendingResult.trace?.deployment?.deployedPosition).toBeUndefined()

      const session = pending.pendingOptionSelection!
      const resolvedResult = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: PLAYERS[0],
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      }, { rootSeed: seed })
      const resolved = resolvedResult.state

      expect(resolved.pendingOptionSelection).toBeUndefined()
      expect(resolved.pieces).toContainEqual(expect.objectContaining({
        instanceId: offeredPieceId,
        x: position.x,
        y: position.y,
      }))
      expect((resolved.extensions as any).summonChoiceCount).toBe(1)
      expect((resolved.extensions as any).summonQueueTailCount).toBe(1)
      expect(resolved.deployment).toMatchObject({
        status: 'turn-ready',
        reserveCounts: { [PLAYERS[0]]: 6, [PLAYERS[1]]: 7 },
      })
      expect(resolved.turn.phase).toBe('action')
      expect(resolved.pieces.find(piece => piece.instanceId === offeredPieceId)?.statusTags)
        .toContainEqual(expect.objectContaining({
          type: 'deployment-first-move-free',
          grantedTurnNumber: resolved.turn.turnNumber,
        }))
      expect(resolved.players.find(player => player.playerId === PLAYERS[0])?.actionPoints).toBe(beforeAp)
      expect(resolved.actions?.filter(entry => entry.type === 'deployReservePiece') ?? []).toHaveLength(1)
      expect(resolvedResult.trace?.deployment).toMatchObject({
        command: 'deploy',
        lastDeployedPieceId: offeredPieceId,
        deployedPosition: position,
      })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('keeps the Kiljaedan ritual atomic through interactive summon triggers without granting a free move', () => {
    const seed = ROOT_SEED + 6
    const anchor = makePiece({
      instanceId: 'ritual-anchor',
      ownerPlayerId: PLAYERS[0],
      faction: 'red',
      x: 0,
      y: 0,
      currentHp: 20,
      maxHp: 20,
      attack: 3,
    })
    const initial = makeState({
      pieces: [anchor],
      currentPlayerId: PLAYERS[0],
      phase: 'action',
      width: 6,
      height: 5,
    }) as any
    initial.players[0].actionPoints = 3
    initial.players[0].hand = [{
      cardId: 'demon-summon-5',
      instanceId: 'ritual-card',
      actionPointCost: 3,
    }]
    initial.players[0].discardPile = []
    initial.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      activePlayerId: PLAYERS[0],
    }
    initial.extensions.kiljaedanPiece = {
      ...reserveCore('kiljaedan-hidden', PLAYERS[0]),
      templateId: 'kiljaedan',
      name: 'Kiljaedan',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
      rules: [],
      statusTags: [],
    }
    initializeTrackedState(initial, seed)

    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-kiljaedan-before-summon-position',
        name: 'RED-138 Kiljaedan position probe',
        description: '',
        trigger: { type: 'beforePieceSummoned' },
        effect: (_battle: BattleState, context: any) => {
          context.targetPosition = { x: 3, y: 2 }
          return { success: true }
        },
      },
      {
        id: 'red-138-kiljaedan-after-summon-choice',
        name: 'RED-138 Kiljaedan summon probe',
        description: '',
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState, context: any) => {
          if (context.selectedOption !== 'continue') {
            return {
              needsOptionSelection: true,
              playerId: context.playerId,
              title: 'Resolve Kiljaedan summon',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          ;(battle.extensions as any).kiljaedanSummonChoiceCount =
            ((battle.extensions as any).kiljaedanSummonChoiceCount || 0) + 1
          return { success: true }
        },
      },
    ] as any)

    try {
      const draft = {
        type: 'playCard' as const,
        playerId: PLAYERS[0],
        cardInstanceId: 'ritual-card',
      }
      const prepared = prepareAction(initial, draft)
      if (prepared.kind !== 'needTarget') throw new Error('Expected ritual target preparation')
      const pending = runBattleAction(initial, {
        ...draft,
        targetPieceId: anchor.instanceId,
        targetX: anchor.x,
        targetY: anchor.y,
        extraTargets: [{ x: 2, y: 2 }],
        selectionId: prepared.selectionId,
        stateRevision: prepared.stateRevision,
      }, { rootSeed: seed }).state as any

      expect(pending.pendingOptionSelection?.source).toMatchObject({
        type: 'rule',
        id: 'red-138-kiljaedan-after-summon-choice',
      })
      expect(pending.pieces.find((piece: any) => piece.instanceId === anchor.instanceId)).toMatchObject({
        currentHp: 20,
        attack: 3,
      })
      expect(pending.pieces.some((piece: any) => piece.instanceId === 'kiljaedan-hidden')).toBe(false)
      expect(pending.extensions.kiljaedanPiece).toBeDefined()
      expect(pending.players[0].actionPoints).toBe(3)
      expect(pending.players[0].hand).toHaveLength(1)
      expect(pending.pieces.some((piece: any) => piece.statusTags?.some((tag: any) =>
        tag.type === 'deployment-first-move-free'))).toBe(false)

      const session = pending.pendingOptionSelection!
      const resolved = runBattleAction(pending, {
        type: 'pendingOptionSelect',
        playerId: PLAYERS[0],
        selectedOption: 'continue',
        selectionId: session.selectionId,
        stateRevision: session.stateRevision,
      }, { rootSeed: seed }).state as any

      expect(resolved.pendingOptionSelection).toBeUndefined()
      expect(resolved.extensions.kiljaedanPiece).toBeUndefined()
      expect(resolved.pieces.find((piece: any) => piece.instanceId === anchor.instanceId)).toMatchObject({
        currentHp: 14,
        attack: 4,
      })
      expect(resolved.pieces).toContainEqual(expect.objectContaining({
        instanceId: 'kiljaedan-hidden',
        x: 3,
        y: 2,
        currentHp: 17,
      }))
      expect(resolved.extensions.kiljaedanSummonChoiceCount).toBe(1)
      expect(resolved.players[0].actionPoints).toBe(0)
      expect(resolved.players[0].hand).toHaveLength(0)
      expect(resolved.players[0].discardPile).toEqual(['demon-summon-5'])
      expect(resolved.pieces.find((piece: any) => piece.instanceId === 'kiljaedan-hidden')?.statusTags)
        .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('deterministically resolves summon interactions during timeout without leaving expired pending input', async () => {
    const seed = ROOT_SEED + 7
    const initial = await createProgressiveBattle(seed)
    const expectedPieceId = initial.deployment!.offerPieceIds![0]
    initial.turnTimer = createRunningTurnTimer(initial, 10_000)
    const previousRules = [...globalTriggerSystem.getRules()]
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules([
      {
        id: 'red-138-timeout-summon-choice',
        name: 'RED-138 timeout summon choice',
        description: '',
        priority: 20,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState, context: any) => {
          if (context.selectedOption !== 'continue') {
            return {
              needsOptionSelection: true,
              playerId: context.playerId,
              title: 'Resolve timed-out summon',
              options: [{ label: 'Continue', value: 'continue' }],
              canCancel: false,
            }
          }
          ;(battle.extensions as any).timeoutSummonChoiceCount =
            ((battle.extensions as any).timeoutSummonChoiceCount || 0) + 1
          return { success: true }
        },
      },
      {
        id: 'red-138-timeout-summon-tail',
        name: 'RED-138 timeout summon tail',
        description: '',
        priority: 10,
        trigger: { type: 'afterPieceSummoned' },
        effect: (battle: BattleState) => {
          ;(battle.extensions as any).timeoutSummonTailCount =
            ((battle.extensions as any).timeoutSummonTailCount || 0) + 1
          return { success: true }
        },
      },
    ] as any)

    try {
      const timedOut = runBattleAction(initial, {
        type: 'turnTimeout',
        now: initial.turnTimer.deadlineAt,
        expectedTurnNumber: initial.turnTimer.turnNumber,
        expectedDeadlineAt: initial.turnTimer.deadlineAt,
      }, { rootSeed: seed }).state

      expect(timedOut.pendingOptionSelection).toBeUndefined()
      expect(timedOut.pendingTargetSelection).toBeUndefined()
      expect(timedOut.pieces).toContainEqual(expect.objectContaining({
        instanceId: expectedPieceId,
        ownerPlayerId: PLAYERS[0],
      }))
      expect((timedOut.extensions as any).timeoutSummonChoiceCount).toBe(1)
      expect((timedOut.extensions as any).timeoutSummonTailCount).toBe(1)
      expect(timedOut.pieces.find(piece => piece.instanceId === expectedPieceId)?.statusTags)
        .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
      expect(timedOut.turn.currentPlayerId).toBe(PLAYERS[1])
      expect(timedOut.deployment).toMatchObject({
        status: 'awaiting-reserve-deploy',
        activePlayerId: PLAYERS[1],
      })
    } finally {
      globalTriggerSystem.clearRules()
      globalTriggerSystem.addRules(previousRules)
    }
  })

  it('ends immediately when a side has no board core even if reserve and hidden Kiljaedan remain', () => {
    const redDead = { ...reserveCore('red-dead', PLAYERS[0]), currentHp: 0 }
    const blueBoard = {
      ...reserveCore('blue-board', PLAYERS[1]),
      x: 0,
      y: 0,
    }
    const redReserve = reserveCore('red-reserve', PLAYERS[0])
    const state = makeState({ pieces: [blueBoard as any] })
    state.graveyard.push(redDead)
    state.deployment = {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      playerIds: [...PLAYERS],
      choices: {},
      locks: {},
      startedAt: 0,
      deadlineAt: 0,
      revision: 0,
      initialPositions: {},
      openingVanguardsInitialized: true,
      reserves: { [PLAYERS[0]]: [redReserve], [PLAYERS[1]]: [] },
    }
    state.extensions = {
      ...state.extensions,
      kiljaedanPiece: reserveCore('hidden-kj', PLAYERS[0]),
    }
    const action: BattleAction = { type: 'grantChargePoints', playerId: PLAYERS[0], amount: 0 }

    expect(finalizeBattleTerminal(state, action)).toMatchObject({
      winnerPlayerId: PLAYERS[1],
      loserPlayerId: PLAYERS[0],
      reason: 'core-eliminated',
    })
  })

  it('removes Kiljaedan from the ordinary reserve before the first offer and starts its ritual once', async () => {
    const kiljaedan = getPieceById('kiljaedan')
    if (!kiljaedan) throw new Error('Missing Kiljaedan template')
    const red = [kiljaedan, ...templates('red').slice(0, 7)]
    const battle = await createProgressiveBattle(ROOT_SEED + 1, red, templates('blue'))
    const redReserve = battle.deployment?.reserves?.[PLAYERS[0]] ?? []
    const hidden = battle.extensions?.kiljaedanPiece

    expect(redReserve.some(piece => piece.templateId === 'kiljaedan')).toBe(false)
    expect(battle.deployment?.offerPieceIds?.includes(hidden?.instanceId)).toBe(false)
    expect(battle.pieces.some(piece => piece.templateId === 'kiljaedan')).toBe(false)
    expect(hidden).toMatchObject({
      instanceId: 'player-red-1',
      templateId: 'kiljaedan',
      ownerPlayerId: PLAYERS[0],
      isCore: true,
      x: null,
      y: null,
    })
    expect(battle.players.find(player => player.playerId === PLAYERS[0])?.hand
      .filter(card => card.cardId === 'demon-summon-1')).toHaveLength(1)
    expect(battle.deployment?.reserveCounts?.[PLAYERS[0]]).toBe(6)
  })
})
