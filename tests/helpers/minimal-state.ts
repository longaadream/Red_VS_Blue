/**
 * 构造一个最小可用的 BattleState，用于单元测试
 * 不依赖文件系统或 battle-setup
 */
import type { BattleState, PlayerId } from '@/lib/game/turn'

const FLOOR_TILE = (x: number, y: number) => ({
  x, y,
  props: { type: 'floor', walkable: true, isSpawn: false, isHole: false, isCover: false },
})

export function makeTile(x: number, y: number, walkable = true) {
  return { x, y, props: { type: walkable ? 'floor' : 'wall', walkable, isSpawn: false, isHole: false, isCover: false } }
}

export function makeMap(width = 6, height = 5) {
  const tiles = []
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      tiles.push(FLOOR_TILE(x, y))
  return { id: 'test-map', name: 'Test Map', width, height, tiles }
}

export function makePiece(overrides: Partial<{
  instanceId: string
  templateId: string
  ownerPlayerId: PlayerId
  faction: 'red' | 'blue'
  x: number
  y: number
  currentHp: number
  maxHp: number
  attack: number
  moveRange: number
  actionPoints: number
  maxActionPoints: number
  skills: string[]
  rules: any[]
  statusTags: any[]
}> = {}) {
  return {
    instanceId:      overrides.instanceId      ?? 'piece-1',
    templateId:      overrides.templateId      ?? 'test-piece',
    ownerPlayerId:   overrides.ownerPlayerId   ?? 'player-red',
    faction:         overrides.faction         ?? 'red',
    x:               overrides.x               ?? 0,
    y:               overrides.y               ?? 0,
    currentHp:       overrides.currentHp       ?? 100,
    maxHp:           overrides.maxHp           ?? 100,
    attack:          overrides.attack          ?? 10,
    defense:         0,
    moveRange:       overrides.moveRange        ?? 3,
    actionPoints:    overrides.actionPoints     ?? 2,
    maxActionPoints: overrides.maxActionPoints  ?? 2,
    skills:          overrides.skills           ?? [],
    rules:           overrides.rules            ?? [],
    statusTags:      overrides.statusTags       ?? [],
    chargePoints:    0,
    maxChargePoints: 0,
    usedSkills:      [],
    hasMoved:        false,
  }
}

export function makePlayer(playerId: PlayerId, faction: 'red' | 'blue') {
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

export function makeState(options: {
  pieces?: ReturnType<typeof makePiece>[]
  currentPlayerId?: PlayerId
  phase?: 'start' | 'action' | 'end'
  turnNumber?: number
  width?: number
  height?: number
} = {}): BattleState {
  const { pieces = [], currentPlayerId = 'player-red', phase = 'action', turnNumber = 1 } = options
  const map = makeMap(options.width, options.height)

  return {
    map,
    pieces: pieces as any,
    graveyard: [],
    pieceStatsByTemplateId: {},
    skillsById: {},
    players: [
      makePlayer('player-red', 'red'),
      makePlayer('player-blue', 'blue'),
    ] as any,
    turn: {
      turnNumber,
      phase,
      currentPlayerId,
      actions: [],
    },
    actions: [],
    extensions: {},
    gameStartFired: true,
    _v: 1,
  } as any
}
