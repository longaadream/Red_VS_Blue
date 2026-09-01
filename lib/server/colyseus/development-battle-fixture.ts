import { createServerBattleStateV1 } from '@/lib/game/battle-storage'
import { pinBattleProfileIdentityV1, recordBattleInitialization } from '@/lib/game/battle-trace'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import type { Room } from '@/lib/game/room-model'
import type { BattleState, PlayerId } from '@/lib/game/turn'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'

const ROOT_SEED = 160

export function createDevelopmentBattleRoom(roomId = 'red160-dev-battle'): Room {
  const normalizedRoomId = normalizeRoomId(roomId)
  const profileIdentity = getServerGameProfileIdentityV1()
  const state = createDevelopmentBattleState()
  pinBattleProfileIdentityV1(state, profileIdentity, ROOT_SEED)
  recordBattleInitialization(
    state,
    new RuleRuntime({ rootSeed: ROOT_SEED }),
    state.players.map(player => player.playerId),
  )
  return {
    id: normalizedRoomId,
    name: 'RED-160 Colyseus development battle',
    status: 'in-progress',
    players: [
      { id: 'player-red', name: 'Red', seat: 'red', alignment: 'light' },
      { id: 'player-blue', name: 'Blue', seat: 'blue', alignment: 'dark' },
    ],
    spectators: [],
    currentTurnIndex: 0,
    actions: [],
    version: 0,
    battleAuthorityVersion: 0,
    battleAuthorityDurableVersion: 0,
    battleAuthorityPersistenceStatus: 'durable',
    battleState: createServerBattleStateV1(profileIdentity, ROOT_SEED, state) as unknown as Room['battleState'],
  }
}

function createDevelopmentBattleState(): BattleState {
  return {
    map: {
      id: 'red160-fixture-map',
      name: 'RED-160 Fixture Map',
      width: 6,
      height: 5,
      tiles: Array.from({ length: 30 }, (_, index) => ({
        id: `tile-${index % 6}-${Math.floor(index / 6)}`,
        x: index % 6,
        y: Math.floor(index / 6),
        props: { type: 'floor', walkable: true, isSpawn: false, isHole: false, isCover: false },
      })),
    },
    pieces: [
      createPiece('red-core', 'player-red', 'red', 0, 0),
      createPiece('blue-core', 'player-blue', 'blue', 5, 4),
    ] as unknown as BattleState['pieces'],
    graveyard: [],
    pieceStatsByTemplateId: {},
    skillsById: {},
    players: [
      createPlayer('player-red', 'red'),
      createPlayer('player-blue', 'blue'),
    ] as BattleState['players'],
    turn: {
      turnNumber: 1,
      phase: 'action',
      currentPlayerId: 'player-red',
      actions: [],
    },
    actions: [],
    extensions: {},
    gameStartFired: true,
    _v: 1,
  } as unknown as BattleState
}

function createPlayer(playerId: PlayerId, faction: 'red' | 'blue') {
  return {
    playerId,
    faction,
    chargePoints: 0,
    maxChargePoints: 10,
    actionPoints: 2,
    maxActionPoints: 2,
    hand: [],
    discardPile: [],
    deck: [],
    rules: [],
    skills: [],
    statusEffects: [],
    perTurnFlags: {
      hasMoved: false,
      hasUsedBasicSkill: false,
      hasUsedChargeSkill: false,
      hasUsedCard: false,
    },
  }
}

function createPiece(
  instanceId: string,
  ownerPlayerId: PlayerId,
  faction: 'red' | 'blue',
  x: number,
  y: number,
) {
  return {
    instanceId,
    templateId: `${faction}-core-template`,
    ownerPlayerId,
    faction,
    x,
    y,
    currentHp: 100,
    maxHp: 100,
    attack: 10,
    defense: 0,
    moveRange: 3,
    actionPoints: 2,
    maxActionPoints: 2,
    skills: [],
    rules: [],
    statusTags: [],
    chargePoints: 0,
    maxChargePoints: 0,
    usedSkills: [],
    hasMoved: false,
    isCore: true,
    name: `${faction} core`,
    buffs: [],
    debuffs: [],
    ruleTags: [],
  }
}

function normalizeRoomId(roomId: string): string {
  const normalized = String(roomId ?? '').trim().toLowerCase()
  if (!normalized) throw new Error('roomId is required')
  return normalized
}
