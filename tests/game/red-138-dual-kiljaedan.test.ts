/* eslint-disable @typescript-eslint/no-explicit-any -- the regression inspects JSON-authored extension state and trigger contexts. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction } from '@/lib/game/battle-runner'
import type { PieceTemplate } from '@/lib/game/piece'
import { getPieceById } from '@/lib/game/piece-repository'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { safeCloneBattleState, type BattleState } from '@/lib/game/turn'

const PLAYER_ALPHA = 'player-ALPHA'
const PLAYER_BETA = 'player-BETA'
const PLAYER_IDS = [PLAYER_ALPHA, PLAYER_BETA] as const
const NORMALIZED_ALPHA = PLAYER_ALPHA.toLowerCase()
const NORMALIZED_BETA = PLAYER_BETA.toLowerCase()
const ROOT_SEED = 0x138d00d
const STARTED_AT = 1_750_000_000_000

function mirroredFillers(): PieceTemplate[] {
  return Array.from({ length: 7 }, (_, index) => ({
    id: `dark-mirror-${index + 1}`,
    name: `Dark mirror ${index + 1}`,
    faction: 'evil',
    rarity: 'common',
    stats: {
      maxHp: 20 + index,
      attack: 4 + index,
      defense: index % 3,
      moveRange: 3,
    },
    skills: [],
  }))
}

async function createMirroredDarkBattle(): Promise<BattleState> {
  const kiljaedan = getPieceById('kiljaedan')
  if (!kiljaedan) throw new Error('Missing real Kiljaedan template')
  const roster = [kiljaedan, ...mirroredFillers()]
  const battle = await createInitialBattleForPlayers(
    [PLAYER_BETA, PLAYER_ALPHA],
    [...roster, ...roster],
    [
      {
        playerId: PLAYER_BETA,
        pieces: roster,
        faction: 'blue',
        alignment: 'dark',
      },
      {
        playerId: PLAYER_ALPHA,
        pieces: roster,
        faction: 'red',
        alignment: 'dark',
      },
    ],
    'large-hole-arena',
    {
      firstPlayerId: PLAYER_ALPHA,
      rootSeed: ROOT_SEED,
      deploymentEnabled: true,
      deploymentStartedAt: STARTED_AT,
    },
  )
  if (!battle) throw new Error('Expected mirrored progressive battle')
  return battle
}

function armFinalRitual(
  source: BattleState,
  playerId: string,
  cardInstanceId: string,
): BattleState {
  const state = safeCloneBattleState(source)
  const player = state.players.find(candidate => candidate.playerId === playerId)
  if (!player) throw new Error(`Missing ritual player ${playerId}`)

  state.turn.currentPlayerId = playerId
  state.turn.phase = 'action'
  state.turn.actions = {
    hasMoved: false,
    hasUsedBasicSkill: false,
    hasUsedChargeSkill: false,
  }
  if (state.deployment) {
    state.deployment.status = 'turn-ready'
    state.deployment.activePlayerId = playerId
  }
  player.actionPoints = 3
  player.maxActionPoints = Math.max(player.maxActionPoints, 3)
  player.hand.push({
    cardId: 'demon-summon-5',
    instanceId: cardInstanceId,
    ownerPlayerId: playerId,
    actionPointCost: 3,
  })
  return state
}

function resolveFinalRitual(
  source: BattleState,
  playerId: string,
  cardInstanceId: string,
): { state: BattleState; targetPosition: { x: number; y: number } } {
  const state = armFinalRitual(source, playerId, cardInstanceId)
  const anchor = state.pieces.find(piece =>
    piece.ownerPlayerId === playerId
    && piece.currentHp > 6
    && piece.templateId !== 'kiljaedan')
  const targetPosition = state.map.tiles.find(tile =>
    tile.props.walkable
    && !state.pieces.some(piece =>
      piece.currentHp > 0 && piece.x === tile.x && piece.y === tile.y))
  if (!anchor || anchor.x === null || anchor.y === null || !targetPosition) {
    throw new Error(`Missing real demon-summon-5 targets for ${playerId}`)
  }

  const draft = {
    type: 'playCard' as const,
    playerId,
    cardInstanceId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected demon-summon-5 target preparation, got ${prepared.kind}`)
  }
  const result = runBattleAction(state, {
    ...draft,
    targetPieceId: anchor.instanceId,
    targetX: anchor.x,
    targetY: anchor.y,
    extraTargets: [{ x: targetPosition.x, y: targetPosition.y }],
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }, { rootSeed: ROOT_SEED })
  return {
    state: result.state,
    targetPosition: { x: targetPosition.x, y: targetPosition.y },
  }
}

beforeAll(async () => {
  await loadMaps()
})

afterEach(() => {
  vi.restoreAllMocks()
  globalTriggerSystem.clearRules()
})

describe('RED-138 mirrored dual-Kiljaedan ritual isolation', () => {
  it('keeps both hidden instances player-scoped and summons each real instance for its original owner', async () => {
    const initial = await createMirroredDarkBattle()
    const hiddenByPlayer = (initial.extensions as any)?.kiljaedanPiecesByPlayerId
    const alphaInstanceId = hiddenByPlayer?.[NORMALIZED_ALPHA]?.instanceId
    const betaInstanceId = hiddenByPlayer?.[NORMALIZED_BETA]?.instanceId

    expect(initial.deployment?.playerIds).toEqual([...PLAYER_IDS])
    expect(Object.keys(hiddenByPlayer).sort()).toEqual([
      NORMALIZED_ALPHA,
      NORMALIZED_BETA,
    ])
    expect(alphaInstanceId).toBeTypeOf('string')
    expect(betaInstanceId).toBeTypeOf('string')
    expect(alphaInstanceId).not.toBe(betaInstanceId)
    expect(hiddenByPlayer[NORMALIZED_ALPHA]).toMatchObject({
      instanceId: alphaInstanceId,
      templateId: 'kiljaedan',
      ownerPlayerId: PLAYER_ALPHA,
      isCore: true,
      x: null,
      y: null,
    })
    expect(hiddenByPlayer[NORMALIZED_BETA]).toMatchObject({
      instanceId: betaInstanceId,
      templateId: 'kiljaedan',
      ownerPlayerId: PLAYER_BETA,
      isCore: true,
      x: null,
      y: null,
    })
    expect((initial.extensions as any).kiljaedanPiece).toMatchObject({
      instanceId: alphaInstanceId,
      ownerPlayerId: PLAYER_ALPHA,
    })
    for (const playerId of PLAYER_IDS) {
      expect(initial.deployment?.reserves?.[playerId]?.some(piece =>
        piece.templateId === 'kiljaedan')).toBe(false)
      expect(initial.deployment?.reserveCounts?.[playerId]).toBe(6)
      expect(initial.players.find(player => player.playerId === playerId)?.hand
        .filter(card => card.cardId === 'demon-summon-1')).toHaveLength(1)
    }
    expect(initial.pieces.some(piece => piece.templateId === 'kiljaedan')).toBe(false)

    const triggerSpy = vi.spyOn(globalTriggerSystem, 'checkTriggers')
    triggerSpy.mockClear()

    // Beta resolves first while the legacy singleton points at Alpha. The
    // player-scoped map must win, otherwise Beta would steal Alpha's instance.
    const betaResolution = resolveFinalRitual(initial, PLAYER_BETA, 'beta-final-ritual')
    const afterBeta = betaResolution.state
    expect(afterBeta.pieces).toContainEqual(expect.objectContaining({
      instanceId: betaInstanceId,
      templateId: 'kiljaedan',
      ownerPlayerId: PLAYER_BETA,
      isCore: true,
      x: betaResolution.targetPosition.x,
      y: betaResolution.targetPosition.y,
    }))
    expect(afterBeta.pieces.some(piece => piece.instanceId === alphaInstanceId)).toBe(false)
    expect((afterBeta.extensions as any).kiljaedanPiecesByPlayerId).toEqual({
      [NORMALIZED_ALPHA]: expect.objectContaining({
        instanceId: alphaInstanceId,
        ownerPlayerId: PLAYER_ALPHA,
      }),
    })
    expect((afterBeta.extensions as any).kiljaedanPiece).toMatchObject({
      instanceId: alphaInstanceId,
      ownerPlayerId: PLAYER_ALPHA,
    })
    expect(afterBeta.pieces.find(piece => piece.instanceId === betaInstanceId)?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))

    const alphaResolution = resolveFinalRitual(afterBeta, PLAYER_ALPHA, 'alpha-final-ritual')
    const completed = alphaResolution.state
    expect((completed.extensions as any).kiljaedanPiecesByPlayerId).toBeUndefined()
    expect((completed.extensions as any).kiljaedanPiece).toBeUndefined()
    expect(completed.pieces
      .filter(piece => piece.templateId === 'kiljaedan')
      .map(piece => ({
        instanceId: piece.instanceId,
        ownerPlayerId: piece.ownerPlayerId,
        isCore: piece.isCore,
      }))
      .sort((left, right) => left.ownerPlayerId.localeCompare(right.ownerPlayerId)))
      .toEqual([
        {
          instanceId: alphaInstanceId,
          ownerPlayerId: PLAYER_ALPHA,
          isCore: true,
        },
        {
          instanceId: betaInstanceId,
          ownerPlayerId: PLAYER_BETA,
          isCore: true,
        },
      ])
    expect(completed.pieces
      .filter(piece => piece.templateId === 'kiljaedan')
      .every(piece => piece.statusTags.every(tag =>
        tag.type !== 'deployment-first-move-free'))).toBe(true)

    const summonContexts = triggerSpy.mock.calls
      .map(([, context]) => context as any)
      .filter(context =>
        context.type === 'beforePieceSummoned'
        || context.type === 'afterPieceSummoned')
      .map(context => ({
        type: context.type,
        playerId: context.playerId,
        pieceTemplateId: context.pieceTemplateId,
        sourcePieceId: context.sourcePiece?.instanceId,
        targetPosition: context.targetPosition,
      }))
    expect(summonContexts).toEqual([
      {
        type: 'beforePieceSummoned',
        playerId: PLAYER_BETA,
        pieceTemplateId: 'kiljaedan',
        sourcePieceId: betaInstanceId,
        targetPosition: betaResolution.targetPosition,
      },
      {
        type: 'afterPieceSummoned',
        playerId: PLAYER_BETA,
        pieceTemplateId: 'kiljaedan',
        sourcePieceId: betaInstanceId,
        targetPosition: undefined,
      },
      {
        type: 'beforePieceSummoned',
        playerId: PLAYER_ALPHA,
        pieceTemplateId: 'kiljaedan',
        sourcePieceId: alphaInstanceId,
        targetPosition: alphaResolution.targetPosition,
      },
      {
        type: 'afterPieceSummoned',
        playerId: PLAYER_ALPHA,
        pieceTemplateId: 'kiljaedan',
        sourcePieceId: alphaInstanceId,
        targetPosition: undefined,
      },
    ])
  })
})
