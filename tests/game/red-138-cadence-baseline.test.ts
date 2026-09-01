/* eslint-disable @typescript-eslint/no-explicit-any -- cadence evidence inspects authority metadata. */
import { beforeAll, describe, expect, it } from 'vitest'

import { loadMaps } from '@/config/maps'
import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { hashBattleState, runBattleAction } from '@/lib/game/battle-runner'
import { withServerSkills } from '@/lib/game/battle-storage'
import { SELECTABLE_MAP_IDS, type SelectableMapId } from '@/lib/game/map-selection'
import type { PieceTemplate } from '@/lib/game/piece'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction, BattleState } from '@/lib/game/turn'

const PLAYERS = ['player-red', 'player-blue'] as const
const CADENCE_SEED = 0x138ca11
const STARTED_AT = 1_750_000_000_000
const CADENCE_SKILL_ID = 'illidan-demon-strike'

type CadenceMoment = {
  globalTurn: number
  roundNumber: number
  ownTurn: number
}

type CadenceBaseline = {
  mapId: SelectableMapId
  seed: number
  reserveExhausted: Record<(typeof PLAYERS)[number], CadenceMoment>
  allReservesEmptyCompletedRound: number
  firstKill: CadenceMoment & { victimId: string }
  terminal: CadenceMoment & {
    winnerPlayerId?: string
    loserPlayerId?: string
    reason?: string
  }
  safeDeployments: number
  fallbackDeployments: number
  submittedActionCount: number
  finalStateHash: string
}

/**
 * An instrumented roster isolates RED-138's turn/deployment cadence from live
 * character balance. It uses a production, authority-validated skill rather
 * than mutating HP or moving pieces directly in the test.
 */
function cadenceTemplates(prefix: 'red' | 'blue'): PieceTemplate[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-cadence-${index + 1}`,
    name: `${prefix} cadence ${index + 1}`,
    faction: prefix === 'red' ? 'good' : 'evil',
    rarity: 'common',
    stats: {
      maxHp: 5,
      attack: 100,
      defense: 0,
      moveRange: 1,
    },
    skills: [{ skillId: CADENCE_SKILL_ID, level: 1 }],
  }))
}

function cadenceMoment(state: BattleState, playerId: string): CadenceMoment {
  const seatIndex = PLAYERS.indexOf(playerId as (typeof PLAYERS)[number])
  if (seatIndex < 0) throw new Error(`Unknown cadence player ${playerId}`)
  return {
    globalTurn: state.turn.turnNumber,
    roundNumber: Math.ceil(state.turn.turnNumber / PLAYERS.length),
    ownTurn: Math.floor((state.turn.turnNumber + (seatIndex === 0 ? 1 : 0)) / PLAYERS.length),
  }
}

function selectedPieceAction(
  state: BattleState,
  base: Omit<Extract<BattleAction, { type: 'useBasicSkill' }>, 'targetPieceId'>,
  targetPieceId: string,
): BattleAction {
  const hydratedState = withServerSkills(state) as BattleState
  const prepared = prepareAction(hydratedState, base as BattleAction)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected authoritative target selection, received ${prepared.kind}`)
  }
  const action = {
    ...base,
    targetPieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  } as BattleAction
  if (prepareAction(hydratedState, action).kind !== 'ready') {
    throw new Error(`Cadence target ${targetPieceId} was not authority-valid`)
  }
  return action
}

async function createCadenceBattle(mapId: SelectableMapId): Promise<BattleState> {
  const red = cadenceTemplates('red')
  const blue = cadenceTemplates('blue')
  const battle = await createInitialBattleForPlayers(
    [...PLAYERS],
    [...red, ...blue],
    [
      { playerId: PLAYERS[0], pieces: red, faction: 'red', alignment: 'light' },
      { playerId: PLAYERS[1], pieces: blue, faction: 'blue', alignment: 'dark' },
    ],
    mapId,
    {
      firstPlayerId: PLAYERS[0],
      rootSeed: CADENCE_SEED,
      deploymentEnabled: true,
      deploymentStartedAt: STARTED_AT,
    },
  )
  if (!battle) throw new Error(`Expected progressive cadence battle on ${mapId}`)
  if (!battle.skillsById[CADENCE_SKILL_ID]) {
    throw new Error(`Missing production cadence skill ${CADENCE_SKILL_ID}`)
  }
  return battle
}

async function runScriptedCadence(mapId: SelectableMapId): Promise<CadenceBaseline> {
  let state = await createCadenceBattle(mapId)
  const reserveExhausted = {} as CadenceBaseline['reserveExhausted']
  let safeDeployments = 0
  let fallbackDeployments = 0
  let submittedActionCount = 0

  const submit = (action: BattleAction): void => {
    state = runBattleAction(state, action, { rootSeed: CADENCE_SEED }).state
    submittedActionCount += 1
  }

  // Static script, not an AI policy: first offer, first published safe cell,
  // leave the current-turn first-move tag unused, then end the action phase.
  while (PLAYERS.some(playerId => (state.deployment?.reserves?.[playerId]?.length ?? 0) > 0)) {
    const playerId = state.turn.currentPlayerId as (typeof PLAYERS)[number]
    const deployment = state.deployment
    if (!deployment || deployment.status !== 'awaiting-reserve-deploy') {
      throw new Error(`Expected reserve deployment on turn ${state.turn.turnNumber}`)
    }
    const pieceId = deployment.offerPieceIds?.[0]
    if (!pieceId) throw new Error(`Missing cadence offer for ${playerId}`)
    const safePosition = deployment.legalPositions?.[0]
    if (safePosition) safeDeployments += 1
    else fallbackDeployments += 1

    submit({
      type: 'deployReservePiece',
      playerId,
      expectedDeploymentRevision: deployment.revision,
      pieceId,
      ...(safePosition ? { toX: safePosition.x, toY: safePosition.y } : {}),
    })

    if ((state.deployment?.reserves?.[playerId]?.length ?? 0) === 0 && !reserveExhausted[playerId]) {
      reserveExhausted[playerId] = cadenceMoment(state, playerId)
    }
    if (state.turn.phase !== 'action') {
      throw new Error(`Deployment did not enter ${playerId}'s action phase`)
    }
    submit({ type: 'endTurn', playerId })
    submit({ type: 'beginPhase' })
  }

  // The blue seventh turn has now settled, so seven complete rounds elapsed.
  const allReservesEmptyCompletedRound = Math.floor((state.turn.turnNumber - 1) / PLAYERS.length)
  if (state.turn.currentPlayerId !== PLAYERS[0] || state.turn.phase !== 'action') {
    throw new Error('Cadence combat boundary must begin on red action turn')
  }

  const attackers = state.pieces
    .filter(piece => piece.ownerPlayerId === PLAYERS[0] && piece.currentHp > 0)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  const victims = state.pieces
    .filter(piece => piece.ownerPlayerId === PLAYERS[1] && piece.currentHp > 0)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  if (attackers.length !== 8 || victims.length !== 8) {
    throw new Error('Cadence combat requires all sixteen deployed cores')
  }

  let firstKill: CadenceBaseline['firstKill'] | undefined
  for (const [index, victim] of victims.entries()) {
    const attacker = attackers[index]
    const graveyardBefore = state.graveyard.length
    const attack = selectedPieceAction(state, {
      type: 'useBasicSkill',
      playerId: PLAYERS[0],
      pieceId: attacker.instanceId,
      skillId: CADENCE_SKILL_ID,
    }, victim.instanceId)
    submit(attack)
    expect(state.graveyard.length).toBe(graveyardBefore + 1)
    if (!firstKill) {
      firstKill = {
        ...cadenceMoment(state, PLAYERS[0]),
        victimId: victim.instanceId,
      }
    }
    if (index < victims.length - 1) expect(state.terminalResult).toBeUndefined()
  }

  if (!firstKill || !state.terminalResult) {
    throw new Error('Cadence script did not reach its kill and terminal evidence points')
  }

  return {
    mapId,
    seed: CADENCE_SEED,
    reserveExhausted,
    allReservesEmptyCompletedRound,
    firstKill,
    terminal: {
      ...cadenceMoment(state, PLAYERS[0]),
      winnerPlayerId: state.terminalResult.winnerPlayerId ?? undefined,
      loserPlayerId: state.terminalResult.loserPlayerId ?? undefined,
      reason: state.terminalResult.reason,
    },
    safeDeployments,
    fallbackDeployments,
    submittedActionCount,
    finalStateHash: hashBattleState(state),
  }
}

beforeAll(async () => {
  await loadMaps()
})

describe('RED-138 fixed-seed non-AI cadence baseline', () => {
  it.each(SELECTABLE_MAP_IDS)(
    'records reserve exhaustion, first kill, and terminal round through authority actions on %s',
    async mapId => {
      const first = await runScriptedCadence(mapId)
      const repeated = await runScriptedCadence(mapId)

      expect(repeated).toEqual(first)
      expect(first.reserveExhausted).toEqual({
        [PLAYERS[0]]: { globalTurn: 13, roundNumber: 7, ownTurn: 7 },
        [PLAYERS[1]]: { globalTurn: 14, roundNumber: 7, ownTurn: 7 },
      })
      expect(first.allReservesEmptyCompletedRound).toBe(7)
      expect(first.firstKill).toMatchObject({
        globalTurn: 15,
        roundNumber: 8,
        ownTurn: 8,
      })
      expect(first.terminal).toEqual({
        globalTurn: 15,
        roundNumber: 8,
        ownTurn: 8,
        winnerPlayerId: PLAYERS[0],
        loserPlayerId: PLAYERS[1],
        reason: 'core-eliminated',
      })
      expect(first.safeDeployments + first.fallbackDeployments).toBe(14)
    },
    30_000,
  )
})
