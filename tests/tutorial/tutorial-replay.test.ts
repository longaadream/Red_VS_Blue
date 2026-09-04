/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, expect, it, vi } from 'vitest'

import { loadMaps } from '@/config/maps'
import { buildDefaultSkills, createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction } from '@/lib/game/battle-runner'
import { getPieceById } from '@/lib/game/piece-repository'
import { prepareAction } from '@/lib/game/targeting'
import { type BattleAction, type BattleState } from '@/lib/game/turn'

const PLAYER = 'training-red'
const OPPONENT = 'training-blue'
const ROOT_SEED = 188

beforeAll(async () => {
  await loadMaps()
})

function piece(state: BattleState, templateId: string) {
  const found = state.pieces.find(candidate => candidate.templateId === templateId && candidate.currentHp > 0)
  if (!found) throw new Error(`Missing living piece ${templateId}`)
  return found
}

function reserve(state: BattleState, playerId: string, templateId: string) {
  const found = (state.deployment?.reserves?.[playerId] ?? []).find(candidate => candidate.templateId === templateId)
  if (!found) throw new Error(`Missing reserve piece ${templateId}`)
  return found
}

function targeted(state: BattleState, action: Record<string, any>): BattleAction {
  const base = { ...action }
  delete base.targetPieceId
  delete base.targetX
  delete base.targetY
  const prepared = prepareAction(state, base as BattleAction)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return { ...action, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
}

function transition(state: BattleState, action: BattleAction): BattleState {
  const skills = state.skillsById
  const next = runBattleAction(state, action, { rootSeed: ROOT_SEED }).state
  next.skillsById = skills
  return next
}

function finishTurn(state: BattleState, playerId: string): BattleState {
  const ended = transition(state, { type: 'endTurn', playerId })
  const started = transition(ended, { type: 'beginPhase' })
  return transition(started, { type: 'beginPhase' })
}

async function createScenario(): Promise<BattleState> {
  const lightIds = ['uther', 'anduin', 'jaina', 'tracer', 'tyrande', 'turalyon', 'velen', 'blue-tirion-fordring']
  const darkIds = ['reaper', 'red-blackwidow', 'red-illidan', 'guldan', 'dark-aizen', 'dark-grimmjow', 'dark-ulquiorra', 'red-obito']
  const light = lightIds.map(id => getPieceById(id)!).filter(Boolean)
  const dark = darkIds.map(id => getPieceById(id)!).filter(Boolean)
  const state = await createInitialBattleForPlayers(
    [PLAYER, OPPONENT], [],
    [
      { playerId: OPPONENT, pieces: dark, faction: 'red', alignment: 'dark' },
      { playerId: PLAYER, pieces: light, faction: 'blue', alignment: 'light' },
    ],
    'large-hole-arena',
    { firstPlayerId: OPPONENT, rootSeed: ROOT_SEED, deploymentEnabled: true, deploymentStartedAt: 1_750_000_000_000 },
  )
  if (!state?.deployment) throw new Error('Expected progressive deployment state')
  state.skillsById = buildDefaultSkills()
  const uther = piece(state, 'uther')
  const reaper = piece(state, 'reaper')
  Object.assign(uther, { x: 6, y: 7 })
  Object.assign(reaper, { x: 8, y: 7, currentHp: 1 })
  state.deployment.reserves![PLAYER] = [reserve(state, PLAYER, 'anduin')]
  state.deployment.reserves![OPPONENT] = [reserve(state, OPPONENT, 'red-blackwidow')]
  state.deployment.reserveCounts = { [PLAYER]: 1, [OPPONENT]: 1 }
  state.deployment.offerPieceIds = [state.deployment.reserves![OPPONENT][0].instanceId]
  state.deployment.initialPositions = {
    [uther.instanceId]: { x: uther.x!, y: uther.y! },
    [reaper.instanceId]: { x: reaper.x!, y: reaper.y! },
  }
  return state
}

it('replays the complete three-turn first-session tutorial through authoritative rules', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  let state = await createScenario()
  expect(piece(state, 'uther').defense).toBeGreaterThan(0)
  expect(state.turn).toMatchObject({ currentPlayerId: OPPONENT, turnNumber: 1, phase: 'start' })
  const terrain = (x: number, y: number) => state.map.tiles.find(tile => tile.x === x && tile.y === y)?.props
  expect(terrain(6, 8)).toMatchObject({ type: 'floor', walkable: true, bulletPassable: true })
  expect(terrain(4, 8)).toMatchObject({ type: 'cover', walkable: true, bulletPassable: false })
  expect(terrain(0, 8)).toMatchObject({ type: 'wall', walkable: false, bulletPassable: false })
  expect(terrain(10, 8)).toMatchObject({ type: 'hole', walkable: false, bulletPassable: true })

  const widowReserve = reserve(state, OPPONENT, 'red-blackwidow')
  state = transition(state, {
    type: 'deployReservePiece', playerId: OPPONENT, pieceId: widowReserve.instanceId,
    expectedDeploymentRevision: state.deployment!.revision, toX: 17, toY: 8,
  })
  state = transition(state, { type: 'beginPhase' })
  const utherBeforeDefense = piece(state, 'uther').currentHp
  const reaper = piece(state, 'reaper')
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: OPPONENT, pieceId: reaper.instanceId,
    skillId: 'hellfire-shotgun', targetX: 6, targetY: 7,
  }))
  const utherAfterDefense = piece(state, 'uther').currentHp
  expect(utherAfterDefense).toBeLessThan(utherBeforeDefense)
  expect(utherBeforeDefense - utherAfterDefense).toBeLessThan(reaper.attack + 2)
  state = transition(state, { type: 'endTurn', playerId: OPPONENT })
  state = transition(state, { type: 'beginPhase' })
  expect(state.turn).toMatchObject({ currentPlayerId: PLAYER, turnNumber: 2, phase: 'start' })
  const anduinReserve = reserve(state, PLAYER, 'anduin')
  const apBeforeDeploy = state.players.find(player => player.playerId === PLAYER)!.actionPoints
  state = transition(state, {
    type: 'deployReservePiece', playerId: PLAYER, pieceId: anduinReserve.instanceId,
    expectedDeploymentRevision: state.deployment!.revision, toX: 5, toY: 1,
  })
  expect(state.players.find(player => player.playerId === PLAYER)!.actionPoints).toBe(apBeforeDeploy)
  state = transition(state, { type: 'beginPhase' })

  const luckyCoin = state.players.find(player => player.playerId === PLAYER)!.hand.find(card => card.cardId === 'lucky-coin')
  expect(luckyCoin).toBeDefined()
  const playerBeforeCoin = state.players.find(player => player.playerId === PLAYER)!
  const apBeforeCoin = playerBeforeCoin.actionPoints
  state = transition(state, { type: 'playCard', playerId: PLAYER, cardInstanceId: luckyCoin!.instanceId })
  expect(state.players.find(player => player.playerId === PLAYER)!.actionPoints).toBe(apBeforeCoin + 1)

  const anduin = piece(state, 'anduin')
  expect(anduin.statusTags.some(tag => tag.type === 'deployment-first-move-free')).toBe(true)
  const apBeforeFreeMove = state.players.find(player => player.playerId === PLAYER)!.actionPoints
  state = transition(state, { type: 'move', playerId: PLAYER, pieceId: anduin.instanceId, toX: 6, toY: 1 })
  expect(state.players.find(player => player.playerId === PLAYER)!.actionPoints).toBe(apBeforeFreeMove)

  const utherForShield = piece(state, 'uther')
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: PLAYER, pieceId: utherForShield.instanceId,
    skillId: 'shield-of-light', targetPieceId: utherForShield.instanceId,
  }))
  expect(piece(state, 'uther').statusTags.some(tag => tag.type === 'divine-shield')).toBe(true)
  const hpBeforeHeal = piece(state, 'uther').currentHp
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: PLAYER, pieceId: piece(state, 'anduin').instanceId,
    skillId: 'light-of-the-light', targetPieceId: piece(state, 'uther').instanceId,
  }))
  expect(piece(state, 'uther').currentHp).toBeGreaterThan(hpBeforeHeal)
  state = finishTurn(state, PLAYER)

  const hpBeforeShieldShot = piece(state, 'uther').currentHp
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: OPPONENT, pieceId: piece(state, 'reaper').instanceId,
    skillId: 'hellfire-shotgun', targetX: 6, targetY: 7,
  }))
  expect(piece(state, 'uther').currentHp).toBe(hpBeforeShieldShot)
  expect(piece(state, 'uther').statusTags.some(tag => tag.type === 'divine-shield')).toBe(false)
  state = finishTurn(state, OPPONENT)

  const chargeBeforeKill = state.players.find(player => player.playerId === PLAYER)!.chargePoints
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: PLAYER, pieceId: piece(state, 'uther').instanceId,
    skillId: 'blessed-hammer', targetPieceId: piece(state, 'reaper').instanceId,
  }))
  const defeatedReaper = state.pieces.find(candidate => candidate.templateId === 'reaper')
    || state.graveyard.find(candidate => candidate.templateId === 'reaper')
  expect(defeatedReaper?.currentHp).toBe(0)
  expect(state.players.find(player => player.playerId === PLAYER)!.chargePoints).toBe(chargeBeforeKill)
  expect(state.extensions?.tileEffects).toContainEqual(expect.objectContaining({
    tileType: 'charge-crystal', x: 8, y: 7,
  }))
  state = transition(state, {
    type: 'move', playerId: PLAYER, pieceId: piece(state, 'uther').instanceId, toX: 8, toY: 7,
  })
  expect(state.players.find(player => player.playerId === PLAYER)!.chargePoints).toBe(chargeBeforeKill + 1)
  state = finishTurn(state, PLAYER)

  const widow = piece(state, 'red-blackwidow')
  const utherBeforeBlockedShot = piece(state, 'uther').currentHp
  state = transition(state, targeted(state, {
    type: 'useBasicSkill', playerId: OPPONENT, pieceId: widow.instanceId,
    skillId: 'blackwidow-lethal-strike', targetX: 0, targetY: 8,
  }))
  expect(piece(state, 'uther').currentHp).toBe(utherBeforeBlockedShot)
  expect(String(state.actions?.at(-1)?.payload?.message ?? '')).toContain('地形阻挡')
  state = finishTurn(state, OPPONENT)
  expect(state.turn).toMatchObject({ currentPlayerId: PLAYER, turnNumber: 6, phase: 'action' })
  const apBeforeBlessing = state.players.find(player => player.playerId === PLAYER)!.actionPoints
  const chargeBeforeBlessing = state.players.find(player => player.playerId === PLAYER)!.chargePoints
  state = transition(state, {
    type: 'useChargeSkill', playerId: PLAYER, pieceId: piece(state, 'uther').instanceId,
    skillId: 'divine-blessing',
  })
  const playerAfterBlessing = state.players.find(player => player.playerId === PLAYER)!
  expect(playerAfterBlessing.actionPoints).toBe(apBeforeBlessing - 1)
  expect(playerAfterBlessing.chargePoints).toBe(chargeBeforeBlessing - 1)
}, 60_000)
