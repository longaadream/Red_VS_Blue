import { loadMaps } from '@/lib/game/map-repository'
import { loadAllSkillsById, loadCardById } from '@/lib/game/skills'
import { createMapFromAscii } from '@/lib/game/map'
import type { BattleState } from '@/lib/game/turn'
import type { GoalPredicate, GoalProgress } from '@/lib/game/ai-goal-search'

const DEMON_CARD_IDS = [
  'demon-summon-1',
  'demon-summon-2',
  'demon-summon-3',
  'demon-summon-4',
  'demon-summon-5',
] as const

export const OFFLINE_DEMON_GOAL_TEMPLATE_ID = 'kiljaedan'
export const OFFLINE_DEMON_PLAYER_ID = 'player-red'
export const OFFLINE_DEMON_ROOT_SEED = 0x8b0139

export interface OfflineGoalFixture {
  state: BattleState
  playerId: string
  rootSeed: number
  goal: GoalPredicate
  progress: GoalProgress
  expectedActionPointCost: 9
  expectedCardIds: readonly string[]
  goalTemplateId: string
}

function fixturePiece(input: {
  instanceId: string
  templateId: string
  name: string
  ownerPlayerId: string
  faction: 'red' | 'blue'
  x: number
  y: number
  currentHp: number
  maxHp: number
  attack: number
  defense: number
  moveRange: number
  isCore?: boolean
  skills?: unknown[]
}) {
  return {
    instanceId: input.instanceId,
    templateId: input.templateId,
    name: input.name,
    ownerPlayerId: input.ownerPlayerId,
    faction: input.faction,
    x: input.x,
    y: input.y,
    currentHp: input.currentHp,
    maxHp: input.maxHp,
    attack: input.attack,
    defense: input.defense,
    moveRange: input.moveRange,
    isCore: input.isCore ?? false,
    skills: input.skills ?? [],
    displaySkills: input.skills ?? [],
    rules: [],
    statusTags: [],
    buffs: [],
    debuffs: [],
    ruleTags: [],
    usedSkills: [],
    hasMoved: false,
  }
}

function fixturePlayer(playerId: string, faction: 'red' | 'blue', actionPoints: number) {
  return {
    playerId,
    faction,
    chargePoints: 0,
    maxChargePoints: 10,
    actionPoints,
    maxActionPoints: actionPoints,
    hand: [] as Array<{ cardId: string; instanceId: string; actionPointCost: number }>,
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

function demonGoal(templateId: string): GoalPredicate {
  return state => state.pieces.some(piece => (
    piece.templateId === templateId
    && piece.ownerPlayerId === OFFLINE_DEMON_PLAYER_ID
    && piece.currentHp > 0
  ))
}

function demonProgress(templateId: string): GoalProgress {
  return state => state.pieces.filter(piece => (
    piece.templateId === templateId
    && piece.ownerPlayerId === OFFLINE_DEMON_PLAYER_ID
    && piece.currentHp > 0
  )).length
}

/**
 * Build a small, real content fixture.  The cards and the stored Kiljaedan
 * payload are loaded through the same repositories used by the battle engine;
 * the goal search itself remains unaware of every content ID in this fixture.
 */
export async function createOfflineDemonGoalFixture(
  options: { rootSeed?: number; goalTemplateId?: string } = {},
): Promise<OfflineGoalFixture> {
  await loadMaps()
  const skillsById = loadAllSkillsById()
  for (const cardId of DEMON_CARD_IDS) {
    if (!loadCardById(cardId, true, true)) throw new Error(`Missing official card content: ${cardId}`)
  }

  const map = createMapFromAscii({
    id: 'offline-demon-goal-map',
    name: 'Offline demon goal map',
    layout: ['...'],
    legend: [{
      char: '.', type: 'floor', walkable: true, bulletPassable: true,
    }],
  })
  const anchor = fixturePiece({
    instanceId: 'offline-demon-anchor',
    templateId: 'offline-demon-anchor',
    name: 'Offline ritual anchor',
    ownerPlayerId: OFFLINE_DEMON_PLAYER_ID,
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 30,
    maxHp: 30,
    attack: 3,
    defense: 0,
    moveRange: 0,
  })
  const enemy = fixturePiece({
    instanceId: 'offline-demon-enemy',
    templateId: 'offline-demon-enemy',
    name: 'Offline enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 0,
    currentHp: 40,
    maxHp: 40,
    attack: 1,
    defense: 0,
    moveRange: 0,
  })
  const storedKiljaedan = fixturePiece({
    instanceId: 'offline-kiljaedan-hidden',
    templateId: OFFLINE_DEMON_GOAL_TEMPLATE_ID,
    name: '基尔加丹',
    ownerPlayerId: OFFLINE_DEMON_PLAYER_ID,
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 1,
    maxHp: 17,
    attack: 4,
    defense: 3,
    moveRange: 4,
    isCore: true,
    skills: [
      { skillId: 'kiljaedan-demonic-pact', level: 1, currentCooldown: 0 },
      { skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 },
      { skillId: 'kiljaedan-soul-drain', level: 1, currentCooldown: 0 },
    ],
  })
  const red = fixturePlayer(OFFLINE_DEMON_PLAYER_ID, 'red', 9)
  red.hand = [{ cardId: 'demon-summon-1', instanceId: 'offline-demon-card-1', actionPointCost: 1 }]
  const blue = fixturePlayer('player-blue', 'blue', 0)
  const state = {
    map,
    pieces: [anchor, enemy],
    graveyard: [],
    pieceStatsByTemplateId: {},
    skillsById,
    players: [red, blue],
    turn: { turnNumber: 1, phase: 'action' as const, currentPlayerId: OFFLINE_DEMON_PLAYER_ID, actions: [] },
    actions: [],
    extensions: {
      kiljaedanPiece: storedKiljaedan,
    },
    deployment: {
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
      activePlayerId: OFFLINE_DEMON_PLAYER_ID,
    },
    gameStartFired: true,
    _v: 1,
  } as unknown as BattleState
  const goalTemplateId = options.goalTemplateId ?? OFFLINE_DEMON_GOAL_TEMPLATE_ID
  return {
    state,
    playerId: OFFLINE_DEMON_PLAYER_ID,
    rootSeed: options.rootSeed ?? OFFLINE_DEMON_ROOT_SEED,
    goal: demonGoal(goalTemplateId),
    progress: demonProgress(goalTemplateId),
    expectedActionPointCost: 9,
    expectedCardIds: DEMON_CARD_IDS,
    goalTemplateId,
  }
}

export const createDemonSummonGoalFixture = createOfflineDemonGoalFixture
