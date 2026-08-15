import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }
vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    checkTriggers: vi.fn(() => TRIGGER_OK),
    updateCooldowns: vi.fn(),
    addRule: vi.fn(),
    removeRule: vi.fn(),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
  },
  TriggerType: {},
}))
vi.mock('@/lib/game/skill-repository', () => ({
  getSkillById: vi.fn(() => null),
  getAllSkills: vi.fn(() => []),
}))
vi.mock('@/lib/game/attached-effect', () => ({
  buildSelfObject: vi.fn(() => ({})),
  removeEffectFromPiece: vi.fn(),
  applyEffectToPiece: vi.fn(),
}))

import { getLegalNormalMoveTargetsForPlayer } from '@/lib/game/spatial'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`

describe('UI/server normal movement contract', () => {
  it('固定状态下共享 UI 集合与服务端逐格验算集合完全一致', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 2, y: 2, moveRange: 3 })
    const blocker = makePiece({ instanceId: 'summon', ownerPlayerId: 'player-blue', x: 3, y: 2 })
    const state = makeState({ pieces: [mover, blocker], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 5 })
    const uiTargets = new Set(getLegalNormalMoveTargetsForPlayer(state, 'player-red', 'mover').map(key))
    const serverTargets = new Set<string>()

    for (const tile of state.map.tiles) {
      try {
        applyBattleAction(state, {
          type: 'move',
          playerId: 'player-red',
          pieceId: 'mover',
          toX: tile.x,
          toY: tile.y,
        })
        serverTargets.add(key(tile))
      } catch {
        // Rejected tiles are intentionally absent from the legal set.
      }
    }

    expect([...uiTargets].sort()).toEqual([...serverTargets].sort())
  })

  it('战斗 UI 通过表现适配器调用浏览器引擎导出的共享普通移动集合', () => {
    const html = readFileSync(resolve(process.cwd(), 'data/pages/battle.html'), 'utf8')
    const legalAdapter = readFileSync(resolve(process.cwd(), 'data/pages/js/battle-ui/battle-legal-actions.js'), 'utf8')
    expect(html).toContain('BattleLegalActions.queryMoveCells')
    expect(legalAdapter).toContain('input.engine.getLegalNormalMoveTargetsForPlayer')
  })

  it('实际浏览器 bundle 导出并执行共享空间规则', () => {
    const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
    const bundleSource = readFileSync(bundlePath, 'utf8')
    expect(bundleSource).not.toContain('"node:crypto"')
    expect(bundleSource).not.toContain('"node:fs"')
    expect(bundleSource).not.toContain('"node:path"')
    expect(bundleSource).not.toContain('"node:zlib"')
    expect(bundleSource).not.toContain('"adm-zip"')
    const context: Record<string, unknown> = {
      Buffer,
      clearTimeout,
      console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      process,
      require: createRequire(import.meta.url),
      setTimeout,
    }
    runInNewContext(bundleSource, context, { filename: bundlePath })

    const engine = context.GameEngine as {
      manhattanDistance?: (from: { x: number; y: number }, to: { x: number; y: number }) => number
      getLegalNormalMoveTargetsForPlayer?: (
        state: ReturnType<typeof makeState>, playerId: string, pieceId: string,
      ) => Array<{ x: number; y: number }>
    }
    expect(engine.manhattanDistance).toBeTypeOf('function')
    expect(engine.getLegalNormalMoveTargetsForPlayer).toBeTypeOf('function')

    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 2, y: 2, moveRange: 3 })
    const blocker = makePiece({ instanceId: 'summon', ownerPlayerId: 'player-blue', x: 3, y: 2 })
    const state = makeState({ pieces: [mover, blocker], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 5 })

    expect(engine.manhattanDistance!({ x: 2, y: 2 }, { x: 3, y: 3 })).toBe(2)
    expect(engine.getLegalNormalMoveTargetsForPlayer!(state, 'player-red', 'mover').map(key).sort()).toEqual([
      '0,2', '1,2', '2,0', '2,1', '2,3', '2,4',
    ])
  })

  it('行动点不足时 UI 与服务端都没有合法普通移动目标', () => {
    const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 2, y: 2, moveRange: 3 })
    const state = makeState({ pieces: [mover], currentPlayerId: 'player-red', phase: 'action' })
    state.players.find(player => player.playerId === 'player-red')!.actionPoints = 0

    const uiTargets = getLegalNormalMoveTargetsForPlayer(state, 'player-red', 'mover')
    expect(uiTargets).toEqual([])
    expect(() => applyBattleAction(state, {
      type: 'move', playerId: 'player-red', pieceId: 'mover', toX: 2, toY: 1,
    })).toThrow(/action points/i)
  })

  it('格子目标默认使用曼哈顿距离，range=1 拒绝斜角', () => {
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 1, y: 1 })
    caster.skills = [{ skillId: 'grid-range-test', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster], currentPlayerId: 'player-red', phase: 'action' })
    state.skillsById['grid-range-test'] = {
      id: 'grid-range-test',
      name: 'Grid Range Test',
      description: '',
      kind: 'active',
      type: 'normal',
      cooldownTurns: 0,
      maxCharges: 0,
      powerMultiplier: 1,
      actionPointCost: 0,
      targetType: 'grid',
      range: 1,
      code: 'function executeSkill() { return { success: true } }',
    } as unknown as (typeof state.skillsById)[string]

    expect(() => applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'caster',
      skillId: 'grid-range-test',
      targetX: 2,
      targetY: 2,
    })).toThrow(/out of range/i)
  })
})
