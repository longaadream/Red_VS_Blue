import { describe, it, expect, vi } from 'vitest'

// triggers 内部动态 require 了依赖文件系统的模块，测试环境里 mock 掉
const TRIGGER_OK = { success: true, messages: [], blocked: false }
vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    checkTriggers:   vi.fn(() => TRIGGER_OK),
    updateCooldowns: vi.fn(),
    addRule:         vi.fn(),
    removeRule:      vi.fn(),
    clearRules:      vi.fn(),
    getRules:        vi.fn(() => []),
  },
  TriggerType: {},
}))
vi.mock('@/lib/game/skill-repository', () => ({
  getSkillById: vi.fn(() => null),
  getAllSkills: vi.fn(() => []),
}))
// attached-effect 依赖 fs，也一并 mock
vi.mock('@/lib/game/attached-effect', () => ({
  buildSelfObject: vi.fn(() => ({})),
  removeEffectFromPiece: vi.fn(),
  applyEffectToPiece: vi.fn(),
}))

import { applyBattleAction, BATTLE_STATE_VERSION } from '@/lib/game/turn'
import { makeState, makePiece } from '../helpers/minimal-state'

// ─── 移动 ────────────────────────────────────────────────────────────────────

describe('move action', () => {
  it('移动到合法格子后位置更新', () => {
    const piece = makePiece({ instanceId: 'p1', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' })

    const next = applyBattleAction(state as any, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'p1',
      toX: 2,
      toY: 0,
    })

    const moved = next.pieces.find(p => p.instanceId === 'p1')
    expect(moved?.x).toBe(2)
    expect(moved?.y).toBe(0)
  })

  it('移动超过 moveRange 应抛出错误', () => {
    const piece = makePiece({ instanceId: 'p1', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 2 })
    const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' })

    expect(() =>
      applyBattleAction(state as any, {
        type: 'move',
        playerId: 'player-red',
        pieceId: 'p1',
        toX: 5,
        toY: 0,
      })
    ).toThrow()
  })

  it('移动后行动点减少', () => {
    const piece = makePiece({ instanceId: 'p1', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3, actionPoints: 2 })
    const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' })
    const initialAP = state.players.find(p => p.playerId === 'player-red')?.actionPoints ?? 2

    const next = applyBattleAction(state as any, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'p1',
      toX: 1,
      toY: 0,
    })

    const afterAP = next.players.find(p => p.playerId === 'player-red')?.actionPoints ?? 2
    expect(afterAP).toBeLessThan(initialAP)
  })
})

// ─── 回合流转 ────────────────────────────────────────────────────────────────

describe('endTurn / beginPhase', () => {
  it('endTurn 后当前玩家切换', () => {
    const state = makeState({ currentPlayerId: 'player-red', phase: 'action' })

    const afterEnd = applyBattleAction(state as any, {
      type: 'endTurn',
      playerId: 'player-red',
    })

    // endTurn 进入 end 阶段，再 beginPhase 进入下一回合 start
    const afterBegin = applyBattleAction(afterEnd, { type: 'beginPhase' })

    expect(afterBegin.turn.currentPlayerId).toBe('player-blue')
  })

  it('红蓝各走一回合后轮回到红方，回合数递增', () => {
    let state = makeState({ currentPlayerId: 'player-red', phase: 'action', turnNumber: 1 })

    state = applyBattleAction(state as any, { type: 'endTurn', playerId: 'player-red' })
    state = applyBattleAction(state, { type: 'beginPhase' })
    // 此时应轮到蓝方
    expect(state.turn.currentPlayerId).toBe('player-blue')

    state = applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
    state = applyBattleAction(state, { type: 'beginPhase' })
    // 蓝方结束后轮回红方，回合数递增
    expect(state.turn.currentPlayerId).toBe('player-red')
    expect(state.turn.turnNumber).toBeGreaterThan(1)
  })
})

// ─── 状态序列化版本 ──────────────────────────────────────────────────────────

describe('BattleState version', () => {
  it('_v 在 applyBattleAction 后被写入', () => {
    const state = makeState({ currentPlayerId: 'player-red', phase: 'action' })
    delete (state as any)._v   // 模拟无版本的旧状态

    const next = applyBattleAction(state as any, { type: 'beginPhase' })
    expect(next._v).toBe(BATTLE_STATE_VERSION)
  })

  it('版本不匹配时抛出错误', () => {
    const state = makeState({ currentPlayerId: 'player-red', phase: 'action' })
    ;(state as any)._v = 9999  // 伪造一个未来版本

    expect(() =>
      applyBattleAction(state as any, { type: 'beginPhase' })
    ).toThrow(/version mismatch/)
  })
})

// ─── safeCloneBattleState：返回独立副本 ─────────────────────────────────────

describe('state immutability', () => {
  it('applyBattleAction 不修改原始 state 的 pieces', () => {
    const piece = makePiece({ instanceId: 'p1', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' })
    const originalX = state.pieces[0].x

    applyBattleAction(state as any, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'p1',
      toX: 2,
      toY: 0,
    })

    expect(state.pieces[0].x).toBe(originalX)
  })
})
