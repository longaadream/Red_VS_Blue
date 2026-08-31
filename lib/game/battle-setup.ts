import { getMap, DEFAULT_MAP_ID, loadMaps } from "@/config/maps"
import {
  getServerGameProfileIdentityV1,
  type GameProfileIdentityV1,
} from '../content-pipeline/runtime/profile-game-identity'
import { assertSelectableMapId } from './map-selection'
import { rng } from "./rng"
import type { BoardMap } from "./map"
import type { PieceInstance, PieceTemplate, PieceStats } from "./piece"
import type { SkillDefinition, SkillState } from "./skills"
import {
  applyBattleAction,
  type BattleState,
  type DeploymentMode,
  type PlayerId,
} from "./turn"
import { loadJsonFilesServer } from "./file-loader"
import { DEFAULT_PIECES } from "./piece-repository"
import { getSkillById } from './skill-repository'
import { globalTriggerSystem, type TriggerResult } from "./triggers"
import { executeSkillFunction, loadRuleById } from './skills'
import path from 'path'
import fs from 'fs'
import { getUserDataDir } from '@/lib/app-paths'
import { pinBattleProfileIdentityV1, recordBattleInitialization } from './battle-trace'
import { RANDOM_STREAM_NAMES, RuleRuntime, withRuleRuntime } from './rule-runtime'
import { finalizeBattleTerminal } from './terminal'

import { DEPLOYMENT_DURATION_MS } from './deployment'

function assertSetupTriggerIsSynchronous(result: TriggerResult, eventType: string): void {
  if (!result.needsOptionSelection && !result.needsTargetSelection) return
  const kind = result.needsOptionSelection ? 'option' : 'target'
  const error = new Error(`[${eventType}] interactive ${kind} trigger is unsupported during battle setup`) as Error & { code?: string }
  error.name = 'InteractiveTriggerUnsupportedError'
  error.code = 'INTERACTIVE_TRIGGER_UNSUPPORTED'
  throw error
}
function fireInitialGameStart(state: BattleState): void {
  if (state.gameStartFired || state.turn.turnNumber !== 1) return

  state.gameStartFired = true

  for (const piece of [...state.pieces]) {
    const result = globalTriggerSystem.checkTriggers(state, {
      type: "afterPieceSummoned",
      playerId: piece.ownerPlayerId,
      sourcePiece: piece,
      pieceTemplateId: piece.templateId,
      faction: piece.faction,
    } as any)
    assertSetupTriggerIsSynchronous(result, 'afterPieceSummoned')
  }

  const result = globalTriggerSystem.checkTriggers(state, {
    type: "gameStart",
    playerId: state.turn.currentPlayerId,
    turnNumber: state.turn.turnNumber,
  })
  assertSetupTriggerIsSynchronous(result, 'gameStart')

  writeLog('[createInitialBattle] gameStart result: ' + JSON.stringify(result))
  if (result.success && result.messages.length > 0) {
    if (!state.actions) state.actions = []
    result.messages.forEach(message => {
      state.actions!.push({
        type: "triggerEffect",
        playerId: state.turn.currentPlayerId,
        turn: state.turn.turnNumber,
        payload: { message },
      })
    })
  }
}

function initializeProgressiveReserveEffects(
  state: BattleState,
  templatesById: ReadonlyMap<string, PieceTemplate>,
): void {
  const deployment = state.deployment
  if (deployment?.mode !== 'progressive-reserve-v1' || !deployment.reserves) return

  for (const playerId of deployment.playerIds) {
    const reserveKey = Object.keys(deployment.reserves).find(
      candidate => candidate.toLowerCase() === playerId.toLowerCase(),
    )
    const reserve = reserveKey ? deployment.reserves[reserveKey] : undefined
    if (!reserve) continue

    const setupPieces = reserve
      .filter(piece => templatesById.get(piece.templateId)?.progressiveDeployment?.reserveInitializationSkillId)
      .sort((left, right) => compareStableText(left.instanceId, right.instanceId))
    for (const setupPiece of setupPieces) {
      const setupSkillId = templatesById
        .get(setupPiece.templateId)
        ?.progressiveDeployment
        ?.reserveInitializationSkillId
      if (!setupSkillId) continue
      const setupSkill = state.skillsById[setupSkillId]
      if (!setupSkill) {
        throw new Error(`Progressive reserve initialization skill is missing: ${setupSkillId}`)
      }
      const reserveIndex = reserve.findIndex(piece => piece.instanceId === setupPiece.instanceId)
      if (reserveIndex < 0) {
        throw new Error(`Progressive reserve setup piece disappeared: ${setupPiece.instanceId}`)
      }

      const [piece] = reserve.splice(reserveIndex, 1)
      piece.x = null
      piece.y = null
      state.pieces.push(piece)
      const result = executeSkillFunction(setupSkill, {
        piece,
        target: null,
        targetPosition: null,
        battle: state,
        skill: {
          id: setupSkill.id,
          name: setupSkill.name,
          type: setupSkill.type,
          powerMultiplier: setupSkill.powerMultiplier,
          targeting: setupSkill.targeting,
        },
      }, state)
      if (!result.success || state.pieces.some(candidate => candidate.instanceId === piece.instanceId)) {
        throw new Error(result.message || `Progressive reserve initialization failed: ${setupSkillId}`)
      }
    }
  }

  deployment.reserveCounts = Object.fromEntries(
    deployment.playerIds.map(playerId => {
      const reserveKey = Object.keys(deployment.reserves ?? {}).find(
        candidate => candidate.toLowerCase() === playerId.toLowerCase(),
      )
      return [playerId, reserveKey ? deployment.reserves?.[reserveKey]?.length ?? 0 : 0]
    }),
  )
}

function normalizeProgressiveStreamPlayerId(playerId: string): string {
  return playerId.trim().toLowerCase()
}

function appendSetupTriggerMessages(
  state: BattleState,
  playerId: string,
  result: TriggerResult,
): void {
  if (!result.success || result.messages.length === 0) return
  if (!state.actions) state.actions = []
  result.messages.forEach(message => {
    state.actions!.push({
      type: 'triggerEffect',
      playerId,
      turn: state.turn.turnNumber,
      payload: { message },
    })
  })
}

function initializeProgressiveOpeningVanguards(
  state: BattleState,
  runtime: RuleRuntime,
): void {
  const deployment = state.deployment
  if (deployment?.mode !== 'progressive-reserve-v1' || !deployment.reserves) return

  for (const playerId of deployment.playerIds) {
    const reserveKey = Object.keys(deployment.reserves).find(
      candidate => candidate.toLowerCase() === playerId.toLowerCase(),
    )
    const reserve = reserveKey ? deployment.reserves[reserveKey] : undefined
    if (!reserve) throw new Error(`Progressive reserve is missing for ${playerId}`)

    const eligible = reserve
      .filter(piece => piece.isCore === true && piece.currentHp > 0)
      .sort((left, right) => compareStableText(left.instanceId, right.instanceId))
    if (eligible.length === 0) {
      throw new Error(`Progressive opening vanguard is unavailable for ${playerId}`)
    }

    const streamPlayerId = normalizeProgressiveStreamPlayerId(playerId)
    const piece = eligible[runtime.nextInt(
      `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningPiece}/${streamPlayerId}`,
      eligible.length,
    )]
    const emptyWalkableTiles = state.map.tiles
      .filter(tile => tile.props.walkable && !state.pieces.some(candidate =>
        candidate.x === tile.x && candidate.y === tile.y))
      .sort((left, right) => left.y - right.y || left.x - right.x)
    if (emptyWalkableTiles.length === 0) {
      throw new Error(`Progressive opening vanguard has no empty walkable position for ${playerId}`)
    }
    const selectedTile = emptyWalkableTiles[runtime.nextInt(
      `${RANDOM_STREAM_NAMES.progressiveDeploymentOpeningCell}/${streamPlayerId}`,
      emptyWalkableTiles.length,
    )]

    const beforeContext = {
      type: 'beforePieceSummoned' as const,
      playerId,
      targetPosition: { x: selectedTile.x, y: selectedTile.y },
      pieceTemplateId: piece.templateId,
      faction: piece.faction,
    }
    const beforeResult = globalTriggerSystem.checkTriggers(state, beforeContext)
    assertSetupTriggerIsSynchronous(beforeResult, 'beforePieceSummoned')
    appendSetupTriggerMessages(state, playerId, beforeResult)
    if (beforeResult.blocked) {
      throw new Error(beforeResult.messages.join('；') || `Progressive opening summon was blocked for ${playerId}`)
    }

    const finalPosition = beforeContext.targetPosition
    const finalTile = finalPosition && state.map.tiles.find(tile =>
      tile.x === finalPosition.x && tile.y === finalPosition.y)
    const finalPositionOccupied = finalPosition && state.pieces.some(candidate =>
      candidate.x === finalPosition.x && candidate.y === finalPosition.y)
    if (!finalPosition || !finalTile?.props.walkable || finalPositionOccupied) {
      throw new Error(`Progressive opening summon resolved to an invalid position for ${playerId}`)
    }

    const reserveIndex = reserve.findIndex(candidate => candidate.instanceId === piece.instanceId)
    if (reserveIndex < 0) throw new Error(`Progressive opening vanguard disappeared for ${playerId}`)
    reserve.splice(reserveIndex, 1)
    piece.x = finalPosition.x
    piece.y = finalPosition.y
    state.pieces.push(piece)

    const afterResult = globalTriggerSystem.checkTriggers(state, {
      type: 'afterPieceSummoned',
      playerId,
      sourcePiece: piece,
      pieceTemplateId: piece.templateId,
      faction: piece.faction,
    })
    assertSetupTriggerIsSynchronous(afterResult, 'afterPieceSummoned')
    appendSetupTriggerMessages(state, playerId, afterResult)
  }

  deployment.reserveCounts = Object.fromEntries(
    deployment.playerIds.map(playerId => {
      const reserveKey = Object.keys(deployment.reserves ?? {}).find(
        candidate => candidate.toLowerCase() === playerId.toLowerCase(),
      )
      return [playerId, reserveKey ? deployment.reserves?.[reserveKey]?.length ?? 0 : 0]
    }),
  )
  deployment.initialPositions = collectCorePositions(state.pieces)
  deployment.openingVanguardsInitialized = true
}

function writeLog(message: string) {
  const logDir = path.join(getUserDataDir(), 'logs')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  const logFile = path.join(logDir, 'game.log')
  const timestamp = new Date().toISOString()
  fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`)
}

// 确保地图数据在模块加载时就被加载
loadMaps().catch(error => {
  console.error('Error loading maps in battle-setup:', error)
})

export function buildDefaultSkills(): Record<string, SkillDefinition> {
  // 从文件系统加载技能数据
  const loadedSkills = loadJsonFilesServer<SkillDefinition>('data/skills')
  
  console.log('Loaded skills from files:', Object.keys(loadedSkills))
  console.log('Number of skills:', Object.keys(loadedSkills).length)
  
  return loadedSkills
}

export function buildDefaultPieceStats(): Record<string, PieceStats> {
  return {
    "red-warrior": {
      maxHp: 120,
      attack: 20,
      defense: 5,
      moveRange: 3,
    },
    "blue-warrior": {
      maxHp: 120,
      attack: 20,
      defense: 5,
      moveRange: 3,
    },
  }
}

// 玩家选择的棋子信息
interface PlayerSelectedPieces {
  playerId: string
  pieces: PieceTemplate[]
  faction?: 'red' | 'blue'
  alignment?: 'light' | 'dark'
}

export const DEMO_DEPLOYMENT_MAP_ID = 'large-hole-arena'

export interface InitialPieceBuildOptions {
  deterministicDeployment?: boolean
  progressiveDeployment?: boolean
}

const FORCE_RULE_RELOAD = process.env.NODE_ENV !== 'production'

function isUltimateSkill(skillId: string): boolean {
  return getSkillById(skillId)?.type === 'ultimate'
}

function cloneInitialStatusTags(pieceTemplate: PieceTemplate): PieceInstance['statusTags'] {
  return (pieceTemplate.initialStatusTags || []).map(tag => ({
    ...tag,
    relatedRules: tag.relatedRules ? [...tag.relatedRules] : undefined,
  }))
}

/** 将棋子模板中的 rules 加载到棋子实例上。 */
function applyInitialRules(piece: PieceInstance, pieceTemplate: PieceTemplate): void {
  const templateRules = pieceTemplate.rules
  if (templateRules && Array.isArray(templateRules)) {
    if (!piece.rules) piece.rules = []
    for (const ruleId of templateRules) {
      const rule = loadRuleById(ruleId, FORCE_RULE_RELOAD)
      if (rule && !piece.rules.some((r: any) => r.id === ruleId)) {
        piece.rules.push(rule)
      }
    }
  }
}

export function buildInitialPiecesForPlayers(
  map: BoardMap,
  players: PlayerId[],
  selectedPieces: PieceTemplate[],
  playerSelectedPieces?: PlayerSelectedPieces[],
  randomFloat: () => number = rng,
  options: InitialPieceBuildOptions = {},
): PieceInstance[] {
  if (players.length !== 2) return []

  const deterministicDeployment = options.deterministicDeployment === true
  const progressiveDeployment = options.progressiveDeployment === true
  if (deterministicDeployment) {
    if (!playerSelectedPieces || playerSelectedPieces.length !== 2 || playerSelectedPieces.some(player => player.pieces.length !== 8)) {
      throw new Error('Demo deployment requires exactly two players with eight pieces each')
    }
    const comparePlayerIds = progressiveDeployment
      ? compareStableProgressivePlayerIds
      : compareStableText
    players = [...players].sort(comparePlayerIds)
    playerSelectedPieces = [...playerSelectedPieces]
      .sort((left, right) => comparePlayerIds(left.playerId, right.playerId))
      .map(playerInfo => progressiveDeployment
        ? {
            ...playerInfo,
            pieces: [...playerInfo.pieces]
              .sort((left, right) => compareStableText(left.id, right.id)),
          }
        : playerInfo)
  }

  const [p1, p2] = players

  const pieces: PieceInstance[] = []
  const playerFactionById = new Map<string, 'red' | 'blue'>()
  if (playerSelectedPieces) {
    for (const playerInfo of playerSelectedPieces) {
      if (playerInfo.faction === 'red' || playerInfo.faction === 'blue') {
        playerFactionById.set(playerInfo.playerId.toLowerCase(), playerInfo.faction)
      }
    }
  }
  const redPlayer = players.find(playerId => playerFactionById.get(playerId.toLowerCase()) === 'red') || p1
  const bluePlayer = players.find(playerId => playerFactionById.get(playerId.toLowerCase()) === 'blue') || players.find(playerId => playerId !== redPlayer) || p2
  
  // 找到所有可走的地板方格（F方格）
  const floorTiles = map.tiles.filter(tile => 
    tile.props.walkable && tile.props.type === "floor"
  )
  
  // Demo 部署严格使用普通地板；旧入口保留历史回退行为。
  const availableTiles = (deterministicDeployment
    ? floorTiles
    : (floorTiles.length > 0 ? floorTiles : map.tiles.filter(tile => tile.props.walkable)))
    .slice()
    .sort((left, right) => left.y - right.y || left.x - right.x)
  const deploymentPositions: Array<{ x: number; y: number }> = []
  if (deterministicDeployment && !progressiveDeployment) {
    if (availableTiles.length < 16) throw new Error('Demo deployment map does not contain sixteen ordinary floor tiles')
    for (let index = 0; index < 16; index += 1) {
      const swapIndex = index + Math.floor(randomFloat() * (availableTiles.length - index))
      const selected = availableTiles[swapIndex]
      availableTiles[swapIndex] = availableTiles[index]
      availableTiles[index] = selected
      deploymentPositions.push({ x: selected.x, y: selected.y })
    }
  }
  
  // 随机选择位置的函数，确保位置不重叠
  const getRandomPosition = () => {
    if (progressiveDeployment) return { x: null, y: null }
    if (deterministicDeployment) {
      const position = deploymentPositions[pieces.length]
      if (!position) throw new Error('Demo deployment exhausted its precomputed positions')
      return position
    }
    if (availableTiles.length === 0) {
      // 如果没有可走的方格，返回默认位置
      return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) }
    }
    
    // 尝试最多100次，找到一个未被占用的位置
    for (let i = 0; i < 100; i++) {
      const randomIndex = Math.floor(randomFloat() * availableTiles.length)
      const position = { x: availableTiles[randomIndex].x, y: availableTiles[randomIndex].y }
      
      // 检查位置是否已经被占用
      const isOccupied = pieces.some(piece => piece.x === position.x && piece.y === position.y)
      if (!isOccupied) {
        return position
      }
    }
    
    // 如果所有位置都被占用，返回第一个可用位置
    return { x: availableTiles[0].x, y: availableTiles[0].y }
  }
  
  console.log('Selected pieces count:', selectedPieces.length)
  console.log('Selected pieces:', selectedPieces)
  console.log('Player selected pieces:', playerSelectedPieces)
  
  // 初始化棋子计数器
  let redPieceIndex = 0
  let bluePieceIndex = 0
  
  // 分配棋子给玩家
  // 优先使用玩家选择的棋子信息
  if (playerSelectedPieces && playerSelectedPieces.length > 0) {
    console.log('Using player selected pieces info for allocation')
    console.log('Player selected pieces:', playerSelectedPieces)
    console.log('Red player:', redPlayer)
    console.log('Blue player:', bluePlayer)
    
    // 为每个玩家分配棋子
    // 根据 playerInfo.playerId 匹配 players 数组中的玩家，确保 ownerPlayerId 正确
    playerSelectedPieces.forEach((playerInfo) => {
      const playerId = playerInfo.playerId
      
      const playerIndexInArray = players.findIndex(p => p.toLowerCase() === playerId.toLowerCase())

      if (playerIndexInArray === -1) {
        console.error(`Player ${playerId} not found in players array:`, players)
        return
      }

      const ownerPlayerId = players[playerIndexInArray]
      const expectedFaction: 'red' | 'blue' =
        (playerInfo.faction as 'red' | 'blue')
        || playerFactionById.get(ownerPlayerId.toLowerCase())
        || (ownerPlayerId === bluePlayer ? 'blue' : 'red')
      
      console.log(`Allocating pieces for player ${playerId} (owner: ${ownerPlayerId}, faction: ${expectedFaction}, index: ${playerIndexInArray})`)

      let pieceIndex = 0
      playerInfo.pieces.forEach(pieceTemplate => {
        const position = getRandomPosition()
        const actualFaction = expectedFaction
        pieces.push({
          instanceId: `${ownerPlayerId}-${pieceIndex + 1}`,
          ...(deterministicDeployment ? { isCore: true } : {}),
          templateId: pieceTemplate.id,
          name: pieceTemplate.name,
          ownerPlayerId,
          faction: actualFaction,
          currentHp: pieceTemplate.stats.maxHp,
          maxHp: pieceTemplate.stats.maxHp,
          attack: pieceTemplate.stats.attack,
          defense: pieceTemplate.stats.defense,
          moveRange: pieceTemplate.stats.moveRange,
          x: position.x,
          y: position.y,
          skills: pieceTemplate.skills.map(s => {
            // 检查技能是否为限定技
            const isUltimate = isUltimateSkill(s.skillId);
            return {
              skillId: s.skillId,
              currentCooldown: 0,
              currentCharges: 0,
              unlocked: true,
              usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
            } as SkillState;
          }),
          rules: [],
          buffs: [],
          debuffs: [],
          ruleTags: [],
          statusTags: cloneInitialStatusTags(pieceTemplate),
        })
        pieceIndex++
        
        // 更新计数器
        if (actualFaction === "red") {
          redPieceIndex++
        } else {
          bluePieceIndex++
        }
      })
    })
  } else {
    // 没有玩家选择的棋子信息，按玩家顺序平均分配所有棋子（奇数给红方，偶数给蓝方）
    // 不再依赖棋子模板的 faction 字段（已改为 evil/good 正邪阵营，与队伍颜色无关）
    console.log('Using default allocation by player order')
    const half = Math.ceil(selectedPieces.length / 2)
    selectedPieces.forEach((pieceTemplate, index) => {
      const isRedPlayer = index < half
      const playerId = isRedPlayer ? redPlayer : bluePlayer
      const faction: 'red' | 'blue' = isRedPlayer ? 'red' : 'blue'
      const pieceIndex = isRedPlayer ? redPieceIndex : bluePieceIndex

      const position = getRandomPosition()
      pieces.push({
        instanceId: `${playerId}-${pieceIndex + 1}`,
        templateId: pieceTemplate.id,
        name: pieceTemplate.name,
        ownerPlayerId: playerId,
        faction,
        currentHp: pieceTemplate.stats.maxHp,
        maxHp: pieceTemplate.stats.maxHp,
        attack: pieceTemplate.stats.attack,
        defense: pieceTemplate.stats.defense,
        moveRange: pieceTemplate.stats.moveRange,
        x: position.x,
        y: position.y,
        skills: pieceTemplate.skills.map(s => {
          const isUltimate = isUltimateSkill(s.skillId)
          return {
            skillId: s.skillId,
            currentCooldown: 0,
            currentCharges: 0,
            unlocked: true,
            usesRemaining: isUltimate ? 1 : -1,
          } as SkillState
        }),
        rules: [],
        buffs: [],
        debuffs: [],
        ruleTags: [],
        statusTags: cloneInitialStatusTags(pieceTemplate),
      })

      if (isRedPlayer) redPieceIndex++
      else bluePieceIndex++
    })
  }
  
  console.log('Red pieces created:', redPieceIndex)
  console.log('Blue pieces created:', bluePieceIndex)

  if (deterministicDeployment && pieces.length !== 16) {
    throw new Error(`Demo deployment created ${pieces.length} pieces instead of sixteen`)
  }
  
  // 确保每个玩家至少有一个棋子
  if (pieces.length === 0) {
    console.log('No pieces created, adding default pieces')
    
    // 获取两个不同的随机位置
    const redPosition = getRandomPosition()
    let bluePosition = getRandomPosition()
    
    // 确保两个位置不同
    while (bluePosition.x === redPosition.x && bluePosition.y === redPosition.y && availableTiles.length > 1) {
      bluePosition = getRandomPosition()
    }
    
    // 添加默认红方棋子
    const defaultRedPiece = DEFAULT_PIECES["red-warrior"]
    pieces.push({
      instanceId: `${redPlayer}-1`,
      templateId: defaultRedPiece.id,
      name: defaultRedPiece.name,
      ownerPlayerId: redPlayer,
      faction: "red",
      currentHp: defaultRedPiece.stats.maxHp,
      maxHp: defaultRedPiece.stats.maxHp,
      attack: defaultRedPiece.stats.attack,
      defense: defaultRedPiece.stats.defense,
      moveRange: defaultRedPiece.stats.moveRange,
      x: redPosition.x,
      y: redPosition.y,
      skills: defaultRedPiece.skills.map(s => {
        // 检查技能是否为限定技
        const isUltimate = isUltimateSkill(s.skillId);
        return {
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
          usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
        };
      }),
      rules: [],
      buffs: [],
      debuffs: [],
      ruleTags: [],
      statusTags: cloneInitialStatusTags(defaultRedPiece),
    })
    
    // 添加默认蓝方棋子
    const defaultBluePiece = DEFAULT_PIECES["blue-warrior"]
    pieces.push({
      instanceId: `${bluePlayer}-1`,
      templateId: defaultBluePiece.id,
      name: defaultBluePiece.name,
      ownerPlayerId: bluePlayer,
      faction: "blue",
      currentHp: defaultBluePiece.stats.maxHp,
      maxHp: defaultBluePiece.stats.maxHp,
      attack: defaultBluePiece.stats.attack,
      defense: defaultBluePiece.stats.defense,
      moveRange: defaultBluePiece.stats.moveRange,
      x: bluePosition.x,
      y: bluePosition.y,
      skills: defaultBluePiece.skills.map(s => {
        // 检查技能是否为限定技
        const isUltimate = isUltimateSkill(s.skillId);
        return {
          skillId: s.skillId,
          currentCooldown: 0,
          currentCharges: 0,
          unlocked: true,
          usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
        };
      }),
      rules: [],
      buffs: [],
      debuffs: [],
      ruleTags: [],
      statusTags: cloneInitialStatusTags(defaultBluePiece),
    })
  } else {
    // 检查是否每个玩家至少有一个棋子
    const redPlayerPieces = pieces.filter(p => p.ownerPlayerId === redPlayer)
    const bluePlayerPieces = pieces.filter(p => p.ownerPlayerId === bluePlayer)
    
    console.log('Red player pieces count:', redPlayerPieces.length)
    console.log('Blue player pieces count:', bluePlayerPieces.length)
    
    // 如果红方玩家没有棋子，添加默认红方棋子
    if (redPlayerPieces.length === 0) {
      console.log('Red player has no pieces, adding default red piece')
      const position = getRandomPosition()
      const defaultRedPiece = DEFAULT_PIECES["red-warrior"]
      pieces.push({
        instanceId: `${redPlayer}-1`,
        templateId: defaultRedPiece.id,
        name: defaultRedPiece.name,
        ownerPlayerId: redPlayer,
        faction: "red",
        currentHp: defaultRedPiece.stats.maxHp,
        maxHp: defaultRedPiece.stats.maxHp,
        attack: defaultRedPiece.stats.attack,
        defense: defaultRedPiece.stats.defense,
        moveRange: defaultRedPiece.stats.moveRange,
        x: position.x,
        y: position.y,
        skills: defaultRedPiece.skills.map(s => {
          // 检查技能是否为限定技
          const isUltimate = isUltimateSkill(s.skillId);
          return {
            skillId: s.skillId,
            currentCooldown: 0,
            currentCharges: 0,
            unlocked: true,
            usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
          };
        }),
        rules: [],
        buffs: [],
        debuffs: [],
        ruleTags: [],
        statusTags: cloneInitialStatusTags(defaultRedPiece),
      })
    }

    // 如果蓝方玩家没有棋子，添加默认蓝方棋子
    if (bluePlayerPieces.length === 0) {
      console.log('Blue player has no pieces, adding default blue piece')
      const position = getRandomPosition()
      const defaultBluePiece = DEFAULT_PIECES["blue-warrior"]
      pieces.push({
        instanceId: `${bluePlayer}-1`,
        templateId: defaultBluePiece.id,
        name: defaultBluePiece.name,
        ownerPlayerId: bluePlayer,
        faction: "blue",
        currentHp: defaultBluePiece.stats.maxHp,
        maxHp: defaultBluePiece.stats.maxHp,
        attack: defaultBluePiece.stats.attack,
        defense: defaultBluePiece.stats.defense,
        moveRange: defaultBluePiece.stats.moveRange,
        x: position.x,
        y: position.y,
        skills: defaultBluePiece.skills.map(s => {
          // 检查技能是否为限定技
          const isUltimate = isUltimateSkill(s.skillId);
          return {
            skillId: s.skillId,
            currentCooldown: 0,
            currentCharges: 0,
            unlocked: true,
            usesRemaining: isUltimate ? 1 : -1, // 限定技1次，普通技能无限制
          };
        }),
        rules: [],
        buffs: [],
        debuffs: [],
        ruleTags: [],
        statusTags: cloneInitialStatusTags(defaultBluePiece),
      })
    }
  }
  
  console.log('Final pieces count:', pieces.length)
  console.log('Final pieces:', pieces)
  
  return pieces
}

export async function createInitialBattleForPlayers(
  playerIds: PlayerId[],
  selectedPieces: PieceTemplate[],
  playerSelectedPieces?: PlayerSelectedPieces[],
  mapId?: string,
  options?: {
    firstPlayerId?: PlayerId
    rootSeed?: number
    deploymentEnabled?: boolean
    /** New matches default to progressive-reserve-v1; legacy is replay/test compatibility only. */
    deploymentMode?: DeploymentMode
    deploymentStartedAt?: number
    profileIdentity?: GameProfileIdentityV1
  },
): Promise<BattleState | null> {
  if (playerIds.length !== 2) return null

  const deploymentMode: DeploymentMode | undefined = options?.deploymentEnabled
    ? options.deploymentMode ?? 'progressive-reserve-v1'
    : undefined
  const progressiveDeployment = deploymentMode === 'progressive-reserve-v1'
  const orderedIds = [...playerIds]
  const orderedPSP = playerSelectedPieces ? [...playerSelectedPieces] : undefined
  let resolvedMapId = mapId

  if (options?.deploymentEnabled) {
    if (typeof options.rootSeed !== 'number') throw new Error('Demo deployment requires an explicit root seed')
    if (!Number.isSafeInteger(options.deploymentStartedAt) || (options.deploymentStartedAt ?? -1) < 0) {
      throw new Error('Demo deployment requires an explicit non-negative deployment start time')
    }
    resolvedMapId = assertSelectableMapId(mapId)
    const comparePlayerIds = progressiveDeployment
      ? compareStableProgressivePlayerIds
      : compareStableText
    orderedIds.sort(comparePlayerIds)
    orderedPSP?.sort((left, right) => comparePlayerIds(left.playerId, right.playerId))
  }

  const [p1, p2] = orderedIds
  
  writeLog('[createInitialBattleForPlayers] mapId: ' + resolvedMapId)
  writeLog('[createInitialBattleForPlayers] DEFAULT_MAP_ID: ' + DEFAULT_MAP_ID)
  
  // 尝试获取指定地图或默认地图
  let map = getMap(resolvedMapId || DEFAULT_MAP_ID)
  writeLog('[createInitialBattleForPlayers] map from getMap: ' + (map ? map.name : 'NOT FOUND'))
  
  // 如果地图没有加载成功，尝试异步加载
  if (!map && !options?.deploymentEnabled) {
    writeLog('Map ' + (resolvedMapId || DEFAULT_MAP_ID) + ' not found in cache, trying to load...')
    await loadMaps()
    map = getMap(resolvedMapId || DEFAULT_MAP_ID)
    writeLog('[createInitialBattleForPlayers] map after loadMaps: ' + (map ? map.name : 'NOT FOUND'))
  }
  
  if (!map && options?.deploymentEnabled) {
    throw new Error(`Map ${String(resolvedMapId)} not found`)
  }

  // 如果地图仍然没有加载成功，旧入口使用默认地图
  if (!map) {
    console.warn(`Map ${resolvedMapId || DEFAULT_MAP_ID} not found, using default map`)
    
    // 创建一个更真实的默认地图，包含墙壁和不同类型的格子
    const defaultMap: BoardMap = {
      id: "default-8x6",
      name: "默认地图",
      width: 8,
      height: 6,
      tiles: [],
      rules: []
    }
    
    // 生成地图格子
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        // 边缘是墙壁
        if (x === 0 || x === 7 || y === 0 || y === 5) {
          defaultMap.tiles.push({
            id: `default-${x}-${y}`,
            x,
            y,
            props: {
              walkable: false,
              bulletPassable: false,
              type: "wall",
            },
          })
        } 
        // 中间区域是地板
        else {
          defaultMap.tiles.push({
            id: `default-${x}-${y}`,
            x,
            y,
            props: {
              walkable: true,
              bulletPassable: true,
              type: "floor",
            },
          })
        }
      }
    }
    
    map = defaultMap
  }

  // 只有 psp 里有实际棋子时才传给 buildInitialPiecesForPlayers，否则用 selectedPieces
  const runtime = typeof options?.rootSeed === 'number'
    ? new RuleRuntime({ rootSeed: options.rootSeed, tick: 0 })
    : undefined
  const deploymentRandom = runtime
    ? () => runtime.nextRandom(RANDOM_STREAM_NAMES.deployment)
    : rng
  const pspForBuild = (orderedPSP && orderedPSP.some(p => p.pieces.length > 0)) ? orderedPSP : undefined
  const pieces = buildInitialPiecesForPlayers(
    map,
    orderedIds,
    selectedPieces,
    pspForBuild,
    deploymentRandom,
    {
      deterministicDeployment: options?.deploymentEnabled === true,
      progressiveDeployment,
    },
  )
  const progressiveReserves = progressiveDeployment
    ? Object.fromEntries(orderedIds.map(playerId => [
        playerId,
        pieces
          .filter(piece => piece.ownerPlayerId.toLowerCase() === playerId.toLowerCase()),
      ]))
    : undefined
  const boardPieces = progressiveDeployment ? [] : pieces

  // 先后手：由 battle-setup 统一决定（不在调用方重复随机）
  const firstPlayer = options?.firstPlayerId && orderedIds.includes(options.firstPlayerId)
    ? options.firstPlayerId
    : ((runtime
        ? runtime.nextRandom(RANDOM_STREAM_NAMES.turnOrder)
        : rng()) < 0.5 ? orderedIds[0] : orderedIds[1])
  const secondPlayer = firstPlayer === orderedIds[0] ? orderedIds[1] : orderedIds[0]

  const skills = buildDefaultSkills()
  console.log('Skills for battle:', Object.keys(skills))
  console.log('Teleport in skills:', 'teleport' in skills)

  // 重置全局规则注册表，避免上一场战斗残留规则。
  globalTriggerSystem.clearRules()

  const playerAlignments = Object.fromEntries(
    (playerSelectedPieces ?? [])
      .filter(player => player.alignment === 'light' || player.alignment === 'dark')
      .map(player => [player.playerId.toLowerCase(), player.alignment]),
  )

  let state: BattleState = {
    map,
    pieces: boardPieces,
    graveyard: [],
    pieceStatsByTemplateId: buildDefaultPieceStats(),
    skillsById: skills,
    players: [
      { playerId: p1, chargePoints: 0, actionPoints: firstPlayer === p1 ? 1 : 0, maxActionPoints: firstPlayer === p1 ? 1 : 0, hand: [], discardPile: [], rules: [] },
      { playerId: p2, chargePoints: 0, actionPoints: firstPlayer === p2 ? 1 : 0, maxActionPoints: firstPlayer === p2 ? 1 : 0, hand: [], discardPile: [], rules: [] },
    ],
    turn: {
      currentPlayerId: firstPlayer,
      turnNumber: 1,
      phase: "start",
      actions: {
        hasMoved: false,
        hasUsedBasicSkill: false,
        hasUsedChargeSkill: false,
      },
    },
    deployment: options?.deploymentEnabled ? {
      mode: deploymentMode,
      status: progressiveDeployment ? 'turn-ready' : 'awaiting-locks',
      playerIds: [...orderedIds],
      choices: {},
      initialPositions: collectCorePositions(boardPieces),
      locks: Object.fromEntries(orderedIds.map(playerId => [playerId, { locked: false }])),
      startedAt: options.deploymentStartedAt!,
      deadlineAt: options.deploymentStartedAt! + DEPLOYMENT_DURATION_MS,
      revision: 0,
      ...(progressiveReserves ? {
        reserves: progressiveReserves,
        reserveCounts: Object.fromEntries(orderedIds.map(playerId => [
          playerId,
          progressiveReserves[playerId]?.length ?? 0,
        ])),
      } : {}),
    } : undefined,
    ...(Object.keys(playerAlignments).length > 0 ? { extensions: { playerAlignments } } : {}),
  }

  if (runtime) {
    pinBattleProfileIdentityV1(state, options?.profileIdentity ?? getServerGameProfileIdentityV1(), runtime.rootSeed)
  }

  // 为每个棋子加载模板 rules。
  const allSelectedPieces: PieceTemplate[] = []
  if (orderedPSP && orderedPSP.some(p => p.pieces.length > 0)) {
    orderedPSP.forEach(pi => pi.pieces.forEach(pt => allSelectedPieces.push(pt)))
  } else {
    selectedPieces.forEach(pt => allSelectedPieces.push(pt))
  }

  const initializeRules = () => {
    pieces.forEach(piece => {
      const template = allSelectedPieces.find(t => t.id === piece.templateId)
      if (template) {
        applyInitialRules(piece, template)
      }
    })

    // 将幸运币规则绑到后手玩家，gameStart 时由规则自动发牌（规则发牌，非硬编码）
    const luckyRule = loadRuleById('rule-lucky-coin-gamestart', FORCE_RULE_RELOAD)
    const secondPlayerState = state.players.find(p => p.playerId === secondPlayer) as any
    if (luckyRule && secondPlayerState) {
      if (!secondPlayerState.rules) secondPlayerState.rules = []
      secondPlayerState.rules.push(luckyRule)
      writeLog('[createInitialBattle] First player: ' + firstPlayer + ', rule-lucky-coin-gamestart → second player: ' + secondPlayer)
    }

    if (progressiveDeployment) {
      initializeProgressiveReserveEffects(
        state,
        new Map(allSelectedPieces.map(template => [template.id, template])),
      )
      if (!runtime) throw new Error('Progressive opening deployment requires a deterministic rule runtime')
      initializeProgressiveOpeningVanguards(state, runtime)
      // The first board-only core settlement boundary is after both opening
      // summon queues, but before gameStart and the first reserve offer.
      finalizeBattleTerminal(state, { type: 'beginPhase' })
      if (!state.terminalResult) state = applyBattleAction(state, { type: 'beginPhase' })
    }

    // 部署完成后由首个 beginPhase 触发 gameStart；旧入口保持立即触发。
    if (!options?.deploymentEnabled) fireInitialGameStart(state)
  }

  if (runtime) {
    withRuleRuntime(runtime, initializeRules)
    recordBattleInitialization(state, runtime, orderedIds)
  } else {
    initializeRules()
  }

  writeLog('[createInitialBattle] Battle state created, pieces count: ' + state.pieces.length)
  return state
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareStableProgressivePlayerIds(left: string, right: string): number {
  const normalized = compareStableText(
    normalizeProgressiveStreamPlayerId(left),
    normalizeProgressiveStreamPlayerId(right),
  )
  return normalized || compareStableText(left, right)
}

function collectCorePositions(pieces: PieceInstance[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(pieces
    .filter(piece => piece.isCore && piece.x !== null && piece.y !== null)
    .map(piece => [piece.instanceId, { x: piece.x as number, y: piece.y as number }]))
}
