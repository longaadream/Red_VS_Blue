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

import { applyBattleAction, BATTLE_STATE_VERSION, summonPiece } from '@/lib/game/turn'
import type { BattleState } from '@/lib/game/turn'
import type { PieceInstance } from '@/lib/game/piece'
import { finalizePendingTargetSession, prepareAction } from '@/lib/game/targeting'
import { makeState, makePiece, makeTile } from '../helpers/minimal-state'
import { globalTriggerSystem } from '@/lib/game/triggers'

function withTargetCredentials(state: BattleState, action: Record<string, any>): Record<string, any> {
  const draft = { ...action }
  delete draft.targetPieceId
  delete draft.targetX
  delete draft.targetY
  delete draft.extraTargets
  const prepared = prepareAction(state, draft as any)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target preparation, received ${prepared.kind}`)
  return { ...action, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

describe('summon trigger contract', () => {
  it('dispatches the declared before and after summon events', () => {
    const state = makeState({ pieces: [] })
    const summoned: PieceInstance = {
      ...makePiece({
        instanceId: 'summoned-piece',
        templateId: 'test-piece',
        ownerPlayerId: 'player-red',
        faction: 'red',
        x: 2,
        y: 3,
      }),
      name: 'Summoned piece',
      skills: [],
      buffs: [],
      debuffs: [],
      ruleTags: [],
    }
    vi.mocked(globalTriggerSystem.checkTriggers).mockClear()

    const result = summonPiece(
      state,
      { templateId: 'test-piece', faction: 'red', ownerPlayerId: 'player-red', x: 2, y: 3 },
      () => ({ id: 'test-piece', rules: [] }),
      () => summoned,
    )

    expect(result).toMatchObject({ success: true, piece: summoned })
    expect(vi.mocked(globalTriggerSystem.checkTriggers).mock.calls.map(([, context]) => context.type)).toEqual([
      'beforePieceSummoned',
      'afterPieceSummoned',
    ])
  })
})

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

  it.each([
    ['友方存活棋子', makePiece({ instanceId: 'blocker-ally', ownerPlayerId: 'player-red', x: 1, y: 0 })],
    ['敌方存活棋子', makePiece({ instanceId: 'blocker-enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 })],
    ['存活召唤物', makePiece({ instanceId: 'summon', templateId: 'summoned-unit', ownerPlayerId: 'player-red', x: 1, y: 0 })],
  ])('路径上的%s阻挡普通移动且不污染状态', (_label, blocker) => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [mover, blocker], currentPlayerId: 'player-red', phase: 'action' })
    state.actions!.push({ type: 'existing', playerId: 'player-red', turn: 1 })
    state.extensions!.debugBattle = {
      appliedActionIds: ['existing-action'],
      actionLog: [{ index: 0, action: { type: 'existing' } }],
    }
    const before = JSON.stringify(state)

    expect(() => applyBattleAction(state, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'mover',
      toX: 2,
      toY: 0,
    })).toThrow(/blocked|occupied/i)

    expect(JSON.stringify(state)).toBe(before)
  })

  it.each([
    {
      label: '斜线',
      target: { x: 1, y: 1 },
      prepare: () => {},
      error: /straight line/i,
    },
    {
      label: '超出 moveRange',
      target: { x: 4, y: 0 },
      prepare: () => {},
      error: /moveRange/i,
    },
    {
      label: '终点不可行走',
      target: { x: 2, y: 0 },
      prepare: (state: BattleState) => {
        state.map.tiles = state.map.tiles.map(tile => tile.x === 2 && tile.y === 0
          ? { ...makeTile(2, 0, false), props: { ...makeTile(2, 0, false).props, type: 'hole' } } as unknown as typeof tile
          : tile)
      },
      error: /terrain/i,
    },
    {
      label: '路径地形阻挡',
      target: { x: 2, y: 0 },
      prepare: (state: BattleState) => {
        state.map.tiles = state.map.tiles.map(tile => tile.x === 1 && tile.y === 0
          ? { ...makeTile(1, 0, false), props: { ...makeTile(1, 0, false).props, type: 'wall' } } as unknown as typeof tile
          : tile)
      },
      error: /terrain/i,
    },
    {
      label: '终点被占用',
      target: { x: 2, y: 0 },
      prepare: (state: BattleState) => {
        state.pieces.push(makePiece({
          instanceId: 'occupant', ownerPlayerId: 'player-blue', x: 2, y: 0,
        }) as unknown as (typeof state.pieces)[number])
      },
      error: /occupied/i,
    },
  ])('$label的普通移动被拒绝且不扣 AP、不写 action trace', ({ target, prepare, error }) => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [mover], currentPlayerId: 'player-red', phase: 'action' })
    prepare(state)
    const before = JSON.stringify(state)

    expect(() => applyBattleAction(state, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'mover',
      toX: target.x,
      toY: target.y,
    })).toThrow(error)

    expect(JSON.stringify(state)).toBe(before)
    expect(state.players.find(p => p.playerId === 'player-red')?.actionPoints).toBe(2)
    expect(state.actions).toEqual([])
  })

  it('可行走掩体格允许进入并停留', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const state = makeState({ pieces: [mover], currentPlayerId: 'player-red', phase: 'action' })
    state.map.tiles = state.map.tiles.map(tile => tile.x === 1 && tile.y === 0
      ? { ...makeTile(1, 0, true), props: { ...makeTile(1, 0, true).props, type: 'cover' } } as unknown as typeof tile
      : tile)

    const next = applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'mover', toX: 1, toY: 0,
    })

    expect(next.pieces.find(p => p.instanceId === 'mover')).toMatchObject({ x: 1, y: 0 })
  })

  it('死亡棋子和墓地棋子不再阻挡普通移动', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    const dead = makePiece({ instanceId: 'dead', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 0 })
    const state = makeState({ pieces: [mover, dead], currentPlayerId: 'player-red', phase: 'action' })
    state.graveyard.push(makePiece({
      instanceId: 'buried', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 0,
    }) as unknown as (typeof state.graveyard)[number])

    const next = applyBattleAction(state, {
      type: 'move',
      playerId: 'player-red',
      pieceId: 'mover',
      toX: 2,
      toY: 0,
    })

    expect(next.pieces.find(p => p.instanceId === 'mover')).toMatchObject({ x: 2, y: 0 })
  })

  it('同一棋子可在行动点足够时连续普通移动，每次固定扣 1 AP', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 3 })
    let state = makeState({ pieces: [mover], currentPlayerId: 'player-red', phase: 'action' })
    state.players.find(p => p.playerId === 'player-red')!.actionPoints = 2

    state = applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'mover', toX: 2, toY: 0,
    })
    state = applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'mover', toX: 2, toY: 1,
    })

    expect(state.pieces.find(p => p.instanceId === 'mover')).toMatchObject({ x: 2, y: 1 })
    expect(state.players.find(p => p.playerId === 'player-red')?.actionPoints).toBe(0)
    expect(state.actions?.filter(action => action.type === 'move')).toHaveLength(2)
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

describe('projectile target validation', () => {
  it.each(['sleep-dart', 'blackwidow-lethal-strike', 'hellfire-shotgun'])(
    'rejects diagonal %s targets before beforeSkillUse triggers',
    (skillId) => {
      const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
      ;(caster as any).skills = [{ skillId, currentCooldown: 0, usesRemaining: -1 }]
      const minato = makePiece({ instanceId: 'minato', ownerPlayerId: 'player-blue', x: 1, y: 1, faction: 'blue' })
      const state = makeState({ pieces: [caster, minato], currentPlayerId: 'player-red', phase: 'action' }) as any
      state.skillsById[skillId] = {
        id: skillId,
        name: skillId,
        description: '',
        kind: 'active',
        type: 'normal',
        cooldownTurns: 0,
        maxCharges: 0,
        powerMultiplier: 1,
        actionPointCost: 0,
        range: 'single',
        targetType: 'piece',
        filter: 'enemy',
        targetRange: 99,
        requiresTarget: true,
        code: 'function executeSkill(context) { return { success: true } }',
      }
      vi.mocked(globalTriggerSystem.checkTriggers).mockClear()

      expect(() => applyBattleAction(state, withTargetCredentials(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: 'caster',
        skillId,
        targetPieceId: 'minato',
        targetX: 1,
        targetY: 1,
      }) as any)).toThrow(/same row or column/)

      expect(globalTriggerSystem.checkTriggers).not.toHaveBeenCalled()
    },
  )

  it('rejects script-level invalid targets before beforeSkillUse triggers', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    ;(caster as any).skills = [{ skillId: 'ally-only-test', currentCooldown: 0, usesRemaining: -1 }]
    const minato = makePiece({ instanceId: 'minato', ownerPlayerId: 'player-blue', x: 1, y: 0, faction: 'blue' })
    const state = makeState({ pieces: [caster, minato], currentPlayerId: 'player-red', phase: 'action' }) as any
    state.skillsById['ally-only-test'] = {
      id: 'ally-only-test',
      name: 'Ally Only Test',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 0,
      range: 'single',
      requiresTarget: true,
      code: "function executeSkill(context) { var target = selectTarget({ type: 'piece', range: 99, filter: 'ally' }); if (!target || target.needsTargetSelection) return target; context.battle.extensions.executed = true; return { success: true, message: 'ok' }; }",
    }
    vi.mocked(globalTriggerSystem.checkTriggers).mockClear()

    expect(() => applyBattleAction(state, withTargetCredentials(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'caster',
      skillId: 'ally-only-test',
      targetPieceId: 'minato',
    }) as any)).toThrow()

    expect(globalTriggerSystem.checkTriggers).not.toHaveBeenCalled()
    expect(state.extensions.executed).toBeUndefined()
  })
})

describe('interrupted skill release', () => {
  it('pays AP, cooldown, and uses when the caster dies during beforeSkillUse', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    ;(caster as any).skills = [{ skillId: 'paid-fizzle', currentCooldown: 0, usesRemaining: 1 }]
    const state = makeState({ pieces: [caster], currentPlayerId: 'player-red', phase: 'action' }) as any
    state.players.find((p: any) => p.playerId === 'player-red').actionPoints = 2
    state.skillsById['paid-fizzle'] = {
      id: 'paid-fizzle',
      name: 'Paid Fizzle',
      description: '',
      kind: 'active',
      type: 'ultimate',
      cooldownTurns: 2,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 1,
      range: 'self',
      requiresTarget: false,
      code: "function executeSkill(context) { context.battle.extensions.executed = true; return { success: true, message: 'executed' } }",
    }

    vi.mocked(globalTriggerSystem.checkTriggers).mockImplementationOnce((battle: any, context: any) => {
      expect(context.type).toBe('beforeSkillUse')
      battle.pieces.find((p: any) => p.instanceId === 'caster').currentHp = 0
      return { success: true, messages: ['Tracer interrupted the release'], blocked: false }
    })

    const next = applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'caster',
      skillId: 'paid-fizzle',
    } as any) as any

    expect(next.players.find((p: any) => p.playerId === 'player-red').actionPoints).toBe(1)
    expect(next.pieces.find((p: any) => p.instanceId === 'caster').currentHp).toBe(0)
    expect(next.pieces.find((p: any) => p.instanceId === 'caster').skills[0].currentCooldown).toBe(2)
    expect(next.pieces.find((p: any) => p.instanceId === 'caster').skills[0].usesRemaining).toBe(0)
    expect(next.extensions.executed).toBeUndefined()
    expect(next.actions.some((a: any) => a.type === 'useBasicSkill' && a.payload?.interrupted)).toBe(true)
  })
})

describe('card preflight and interrupted release', () => {
  it('rejects invalid card effects before beforeCardPlay triggers', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0 })
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 1, faction: 'blue' })
    const state = makeState({ pieces: [caster, target], currentPlayerId: 'player-red', phase: 'action' }) as any
    const red = state.players.find((p: any) => p.playerId === 'player-red')
    red.hand = [{ cardId: 'line-card', instanceId: 'card-1', actionPointCost: 1 }]
    red.actionPoints = 2
    state.customCards = {
      'line-card': {
        id: 'line-card',
        name: 'Line Card',
        description: '',
        type: 'active',
        actionPointCost: 1,
        targetType: 'piece',
        filter: 'ally',
        code: "function executeCard(context) { context.battle.extensions.executed = true; return { success: true, message: 'ok' }; }",
      },
    }
    vi.mocked(globalTriggerSystem.checkTriggers).mockClear()

    expect(() => applyBattleAction(state, withTargetCredentials(state, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-1',
      targetPieceId: 'target',
      targetX: 1,
      targetY: 1,
    }) as any)).toThrow(/ally/)

    expect(globalTriggerSystem.checkTriggers).not.toHaveBeenCalled()
  })

  it('pays AP and discards when the card target dies during beforeCardPlay', () => {
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 1, y: 0, faction: 'blue' })
    const state = makeState({ pieces: [target], currentPlayerId: 'player-red', phase: 'action' }) as any
    const red = state.players.find((p: any) => p.playerId === 'player-red')
    red.hand = [{ cardId: 'paid-card', instanceId: 'card-1', actionPointCost: 1 }]
    red.discardPile = []
    red.actionPoints = 2
    state.customCards = {
      'paid-card': {
        id: 'paid-card',
        name: 'Paid Card',
        description: '',
        type: 'active',
        actionPointCost: 1,
        targetType: 'piece',
        filter: 'enemy',
        code: "function executeCard(context) { if (!context.target) return { needsTargetSelection: true, targetType: 'piece', filter: 'enemy' }; context.battle.extensions.executed = true; return { success: true, message: 'card executed' }; }",
      },
    }

    vi.mocked(globalTriggerSystem.checkTriggers).mockImplementationOnce((battle: any, context: any) => {
      expect(context.type).toBe('beforeCardPlay')
      battle.pieces.find((p: any) => p.instanceId === 'target').currentHp = 0
      return { success: true, messages: ['Target was removed'], blocked: false }
    })

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-1',
      targetPieceId: 'target',
      targetX: 1,
      targetY: 0,
    }) as any) as any

    const nextRed = next.players.find((p: any) => p.playerId === 'player-red')
    expect(nextRed.actionPoints).toBe(1)
    expect(nextRed.hand).toEqual([])
    expect(nextRed.discardPile).toEqual(['paid-card'])
    expect(next.pieces.find((p: any) => p.instanceId === 'target').currentHp).toBe(0)
    expect(next.extensions.executed).toBeUndefined()
    expect(next.actions.some((a: any) => a.type === 'playCard' && a.payload?.interrupted)).toBe(true)
  })

  it('resolves multi-target cards with a piece target followed by a grid target', () => {
    const anchor = makePiece({ instanceId: 'anchor', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 20, maxHp: 20, attack: 3 })
    const state = makeState({ pieces: [anchor], currentPlayerId: 'player-red', phase: 'action' }) as any
    const red = state.players.find((p: any) => p.playerId === 'player-red')
    red.hand = [{ cardId: 'summon-final', instanceId: 'card-1', actionPointCost: 1 }]
    red.discardPile = []
    red.actionPoints = 3
    state.extensions.kiljaedanPiece = {
      instanceId: 'kiljaedan-hidden',
      templateId: 'kiljaedan',
      name: 'Kiljaedan',
      ownerPlayerId: 'player-red',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
      x: 0,
      y: 0,
      skills: [],
      rules: [],
    }
    state.customCards = {
      'summon-final': {
        id: 'summon-final',
        name: 'Summon Final',
        description: '',
        type: 'active',
        actionPointCost: 1,
        code: "function executeCard(context) { var anchor = selectTarget({ type: 'piece', filter: 'ally', range: 99 }); if (!anchor || anchor.needsTargetSelection) return anchor; var pos = selectTarget({ type: 'grid', range: 99, filter: 'all' }); if (!pos || pos.needsTargetSelection) return pos; var kj = context.battle.extensions.kiljaedanPiece; kj.x = pos.x; kj.y = pos.y; kj.currentHp = kj.maxHp; context.battle.pieces.push(kj); delete context.battle.extensions.kiljaedanPiece; return { success: true, message: 'summoned' }; }",
      },
    }
    vi.mocked(globalTriggerSystem.checkTriggers).mockReturnValue({ success: true, messages: [], blocked: false } as any)

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-1',
      targetPieceId: 'anchor',
      targetX: 0,
      targetY: 0,
      extraTargets: [{ x: 2, y: 2 }],
    }) as any) as any

    expect(next.extensions.kiljaedanPiece).toBeUndefined()
    const summoned = next.pieces.find((p: any) => p.instanceId === 'kiljaedan-hidden')
    expect(summoned?.x).toBe(2)
    expect(summoned?.y).toBe(2)
    expect(summoned?.currentHp).toBe(17)
    expect(next.players.find((p: any) => p.playerId === 'player-red').discardPile).toEqual(['summon-final'])
  })

  it('resolves the real demon-summon-5 card with an ally target followed by a grid target', () => {
    const anchor = makePiece({ instanceId: 'anchor', ownerPlayerId: 'player-red', x: 0, y: 0, currentHp: 20, maxHp: 20, attack: 3, faction: 'red' })
    const state = makeState({ pieces: [anchor], currentPlayerId: 'player-red', phase: 'action' }) as any
    const red = state.players.find((p: any) => p.playerId === 'player-red')
    red.hand = [{ cardId: 'demon-summon-5', instanceId: 'card-5', actionPointCost: 3 }]
    red.discardPile = []
    red.actionPoints = 3
    state.extensions.kiljaedanPiece = {
      instanceId: 'kiljaedan-hidden',
      templateId: 'kiljaedan',
      name: 'Kiljaedan',
      ownerPlayerId: 'player-red',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
      x: 0,
      y: 0,
      skills: [],
      rules: [],
      statusTags: [],
    }
    vi.mocked(globalTriggerSystem.checkTriggers).mockReturnValue({ success: true, messages: [], blocked: false } as any)

    const next = applyBattleAction(state, withTargetCredentials(state, {
      type: 'playCard',
      playerId: 'player-red',
      cardInstanceId: 'card-5',
      targetPieceId: 'anchor',
      targetX: 0,
      targetY: 0,
      extraTargets: [{ x: 2, y: 2 }],
    }) as any) as any

    expect(next.extensions.kiljaedanPiece).toBeUndefined()
    const summoned = next.pieces.find((p: any) => p.instanceId === 'kiljaedan-hidden')
    expect(summoned?.x).toBe(2)
    expect(summoned?.y).toBe(2)
    expect(summoned?.currentHp).toBe(17)
    expect(next.players.find((p: any) => p.playerId === 'player-red').discardPile).toEqual(['demon-summon-5'])
  })
})

describe('generic pending target selection', () => {
  it('pendingTargetSelect clears selector and applies effectCode', () => {
    const state = makeState({ currentPlayerId: 'player-blue', phase: 'action' }) as any
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-blue',
      title: '选择测试格',
      targetType: 'cell',
      range: 99,
      filter: 'all',
      effectCode: "function(ctx) { if (!ctx.battle.extensions) ctx.battle.extensions = {}; ctx.battle.extensions.tileEffects = [{ x: ctx.targetX, y: ctx.targetY, tileType: 'test-anchor' }]; return { success: true, message: 'ok' }; }",
    }, 0)

    const next = applyBattleAction(state, {
      type: 'pendingTargetSelect',
      playerId: 'player-blue',
      targetX: 1,
      targetY: 1,
      selectionId: state.pendingTargetSelection.selectionId,
      stateRevision: state.pendingTargetSelection.stateRevision,
    } as any) as any

    expect(next.pendingTargetSelection).toBeUndefined()
    expect(next.extensions.tileEffects).toEqual([{ x: 1, y: 1, tileType: 'test-anchor' }])
    expect(next.actions.at(-1)?.payload?.message).toBe('ok')
  })
})
