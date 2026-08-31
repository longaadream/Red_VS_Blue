import { describe, expect, it } from 'vitest'

import { getRuntimeProfileReferenceV1 } from '@/lib/content-pipeline/runtime/profile-runtime'
import { createServerBattleStateV1 } from '@/lib/game/battle-storage'
import { getDefaultDemoRosterSelection } from '@/lib/game/roster-contract'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleState } from '@/lib/game/turn'
import {
  applyPveBattleActionV1,
  createPveBattleV1,
  PVE_ENEMY_ID_V1,
  PVE_PLAYER_ID_V1,
  settlePveBattleV1,
} from '@/lib/pve/battle-adapter'

function roster(alignment: 'light' | 'dark'): string[] {
  return getDefaultDemoRosterSelection(alignment).map(piece => piece.templateId)
}

async function createBattle(rootSeed = 0x1170cafe) {
  const profileReference = getRuntimeProfileReferenceV1()
  return createPveBattleV1({
    runId: 'prototype-run',
    sourceNodeId: 'prototype-battle-node',
    encounterId: 'prototype-encounter',
    mapId: 'large-hole-arena',
    rootSeed,
    authorityContentHash: profileReference.authorityContentHash,
    profileReference,
    playerPieceIds: roster('light'),
    enemyPieceIds: roster('dark'),
  })
}

describe('RED-117 authoritative PVE battle adapter', () => {
  it('creates a deterministic formal 8x8 battle pinned to active authority content', async () => {
    const first = await createBattle()
    const repeated = await createBattle()
    const firstState = first.storage.state as BattleState

    expect(first.reference.authorityContentHash).toBe(
      getRuntimeProfileReferenceV1().authorityContentHash,
    )
    expect(first.reference.stateHash).toBe(repeated.reference.stateHash)
    expect(first.storage.rootSeed).toBe(repeated.storage.rootSeed)
    expect(Object.keys(firstState.deployment?.initialPositions ?? {})).toHaveLength(16)
    expect(firstState.deployment?.status).toBe('complete')
    expect(firstState.extensions?.debugBattle?.actionLog.length).toBeGreaterThanOrEqual(4)
  })

  it.each([
    [PVE_ENEMY_ID_V1, 'victory'],
    [PVE_PLAYER_ID_V1, 'defeat'],
  ] as const)('derives %s surrender only from formal terminalResult', async (loser, outcome) => {
    const battle = await createBattle()
    const applied = applyPveBattleActionV1(battle.storage, {
      type: 'surrender',
      playerId: loser,
      reason: 'voluntary',
      clientActionId: `surrender-${loser}`,
    })

    expect(settlePveBattleV1(applied.storage)).toMatchObject({ outcome })
    expect((applied.storage.state as BattleState).terminalResult).toMatchObject({
      status: 'finished',
      loserPlayerId: loser,
    })
  })

  it('rejects client-authored terminal fields and non-terminal settlement', async () => {
    const battle = await createBattle()

    expect(() => applyPveBattleActionV1(battle.storage, {
      type: 'gameOver',
      winner: PVE_PLAYER_ID_V1,
    })).toThrow('Client-authored battle terminal results are forbidden')
    expect(() => settlePveBattleV1(battle.storage)).toThrow(
      'formal Battle Runner commits terminalResult',
    )
  })

  it('derives draw from the formal round-limit terminal with no client result', async () => {
    const battle = await createBattle(0x1170d00d)
    const nearLimit = JSON.parse(JSON.stringify(battle.storage.state)) as BattleState
    nearLimit.turn = {
      ...nearLimit.turn,
      turnNumber: 80,
      phase: 'action',
    }
    nearLimit.pieces.forEach(piece => { piece.rules = [] })
    nearLimit.players.forEach(player => { player.rules = [] })
    nearLimit.pendingOptionSelection = undefined
    nearLimit.pendingTargetSelection = undefined
    const nearLimitStorage = createServerBattleStateV1(
      battle.storage.profileIdentity,
      battle.storage.rootSeed,
      nearLimit,
    )
    const registry = globalTriggerSystem.getRules()
    const registeredRules = [...registry]
    globalTriggerSystem.clearRules()
    let applied
    try {
      applied = applyPveBattleActionV1(nearLimitStorage, {
        type: 'endTurn',
        playerId: nearLimit.turn.currentPlayerId,
        clientActionId: 'draw-round-limit',
      })
    } finally {
      registry.splice(0, registry.length, ...registeredRules)
      ;(globalTriggerSystem as unknown as { rules: typeof registry }).rules = registry
    }

    expect((applied.storage.state as BattleState).terminalResult)
      .toMatchObject({ status: 'finished', reason: 'round-limit' })
    expect(settlePveBattleV1(applied.storage).outcome).toBe('draw')
  })

  it('fails closed when a registered roster is not exactly eight active templates', async () => {
    const profileReference = getRuntimeProfileReferenceV1()
    await expect(createPveBattleV1({
      runId: 'invalid-roster-run',
      sourceNodeId: 'prototype-battle-node',
      encounterId: 'prototype-encounter',
      mapId: 'large-hole-arena',
      rootSeed: 1,
      authorityContentHash: profileReference.authorityContentHash,
      profileReference,
      playerPieceIds: roster('light').slice(0, 7),
      enemyPieceIds: roster('dark'),
    })).rejects.toThrow('exactly eight unique pieces')
  })
})
