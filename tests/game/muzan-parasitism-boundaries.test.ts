import { beforeEach, describe, expect, it } from 'vitest'
import { runBattleAction } from '@/lib/game/battle-runner'
import { loadAllSkillsById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function fixture(blockLandings = false) {
  const muzan = makePiece({ instanceId: 'muzan', ownerPlayerId: 'player-red', x: 2, y: 1,
    currentHp: 1, maxHp: 15, skills: [{ skillId: 'muzan-parasitism', currentCooldown: 0 }] })
  const host = makePiece({ instanceId: 'host', ownerPlayerId: 'player-blue', x: 3, y: 1, currentHp: 8, maxHp: 10 })
  const attacker = makePiece({ instanceId: 'attacker', ownerPlayerId: 'player-blue', x: 1, y: 1, attack: 10,
    skills: [{ skillId: 'arthas-frostmourne', currentCooldown: 0 }] })
  const state = makeState({ pieces: [muzan, host, attacker], width: 8, height: 6, currentPlayerId: 'player-blue' })
  state.skillsById = loadAllSkillsById()
  state.players.find(player => player.playerId === 'player-red')!.chargePoints = 2
  state.players.find(player => player.playerId === 'player-blue')!.actionPoints = 2
  if (blockLandings) {
    for (const tile of state.map.tiles) {
      if ([host, attacker].some(piece => Math.abs(tile.x - piece.x!) + Math.abs(tile.y - piece.y!) === 1)) tile.props.walkable = false
    }
  }
  const base = { type: 'useBasicSkill' as const, playerId: 'player-blue', pieceId: 'attacker', skillId: 'arthas-frostmourne' }
  const prepared = prepareAction(state, base)
  if (prepared.kind !== 'needTarget') throw new Error('Expected attack selection')
  const action: BattleAction = { ...base, targetPieceId: 'muzan', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
  return { state, action }
}

function answer(state: BattleState, target: { targetPieceId: string } | { targetX: number; targetY: number }): Extract<BattleAction, { type: 'pendingTargetSelect' }> {
  const pending = state.pendingTargetSelection!
  return { type: 'pendingTargetSelect', playerId: pending.playerId, selectionId: pending.selectionId,
    stateRevision: pending.stateRevision, ...target }
}

function start() {
  const { state, action } = fixture()
  return runBattleAction(state, action, { rootSeed: 216 }).state
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('Muzan authoritative selection boundaries', () => {
  it('finishes ordinary death without prompting when every host landing is blocked', () => {
    const { state, action } = fixture(true)
    const completed = runBattleAction(state, action, { rootSeed: 216 }).state
    expect(completed.pendingTargetSelection).toBeUndefined()
    expect(completed.graveyard.some(piece => piece.instanceId === 'muzan')).toBe(true)
    expect(completed.players.find(player => player.playerId === 'player-red')!.chargePoints).toBe(2)
  })

  it.each(['forged-host', 'stale-selection', 'wrong-player'] as const)('rejects %s without mutation', kind => {
    const state = start()
    const command = answer(state, { targetPieceId: 'host' })
    if (kind === 'forged-host' && command.type === 'pendingTargetSelect') command.targetPieceId = 'missing'
    if (kind === 'stale-selection' && command.type === 'pendingTargetSelect') command.selectionId = 'stale'
    if (kind === 'wrong-player') command.playerId = 'player-blue'
    const before = JSON.stringify(state)
    expect(() => runBattleAction(state, command)).toThrow()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('rejects an illegal landing and a repeated completed response without charging again', () => {
    const first = start()
    const second = runBattleAction(first, answer(first, { targetPieceId: 'host' })).state
    const before = JSON.stringify(second)
    expect(() => runBattleAction(second, answer(second, { targetX: 7, targetY: 5 }))).toThrow()
    expect(JSON.stringify(second)).toBe(before)
    const command = answer(second, { targetX: 4, targetY: 1 })
    const completed = runBattleAction(second, command).state
    const completedBefore = JSON.stringify(completed)
    expect(() => runBattleAction(completed, command)).toThrow()
    expect(JSON.stringify(completed)).toBe(completedBefore)
    expect(completed.players.find(player => player.playerId === 'player-red')!.chargePoints).toBe(0)
  })

  it('cancels at the landing step without transferring or paying', () => {
    const first = start()
    const second = runBattleAction(first, answer(first, { targetPieceId: 'host' })).state
    const pending = second.pendingTargetSelection!
    const completed = runBattleAction(second, { type: 'cancelPendingSelection', playerId: pending.playerId,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision }).state
    expect(completed.players.find(player => player.playerId === 'player-red')!.chargePoints).toBe(2)
    expect(completed.pieces.find(piece => piece.instanceId === 'host')!.ownerPlayerId).toBe('player-blue')
    expect(completed.graveyard.some(piece => piece.instanceId === 'muzan')).toBe(true)
  })

  it.each(['blocked', 'spent-charge'] as const)('rechecks %s after the position reaction', mode => {
    globalTriggerSystem.addRule({ id: 'parasitism-position-test', name: 'test', description: '',
      trigger: { type: 'beforePiecePositionChange' }, effect: battle => {
        if (mode === 'spent-charge') battle.players.find(player => player.playerId === 'player-red')!.chargePoints = 1
        return { success: true, blocked: mode === 'blocked' }
      } })
    const first = start()
    const second = runBattleAction(first, answer(first, { targetPieceId: 'host' })).state
    const completed = runBattleAction(second, answer(second, { targetX: 4, targetY: 1 })).state
    expect(completed.players.find(player => player.playerId === 'player-red')!.chargePoints).toBe(mode === 'blocked' ? 2 : 1)
    expect(completed.pieces.find(piece => piece.instanceId === 'host')!.ownerPlayerId).toBe('player-blue')
    expect(completed.graveyard.find(piece => piece.instanceId === 'muzan')).toMatchObject({ x: 2, y: 1, currentHp: 0 })
    expect(completed.actions?.some(action => action.type === 'deathParasitism')).toBe(false)
  })

  it('replays identical commands and seed to the same final state', () => {
    function complete() {
      const first = start()
      const second = runBattleAction(first, answer(first, { targetPieceId: 'host' })).state
      return runBattleAction(second, answer(second, { targetX: 4, targetY: 1 })).state
    }
    expect(complete()).toEqual(complete())
  })
})
