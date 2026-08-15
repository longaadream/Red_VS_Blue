import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const TRIGGER_OK = { success: true, messages: [], blocked: false }

vi.mock('@/lib/game/triggers', () => ({
  globalTriggerSystem: {
    addRule: vi.fn(),
    checkTriggers: vi.fn(() => TRIGGER_OK),
    clearRules: vi.fn(),
    getRules: vi.fn(() => []),
    removeRule: vi.fn(),
    updateCooldowns: vi.fn(),
  },
  TriggerType: {},
}))

vi.mock('@/lib/game/skill-repository', () => ({
  getAllSkills: vi.fn(() => []),
  getSkillById: vi.fn(() => null),
}))

vi.mock('@/lib/game/attached-effect', () => ({
  applyEffectToPiece: vi.fn(),
  buildSelfObject: vi.fn(() => ({})),
  removeEffectFromPiece: vi.fn(),
}))

import { mulberry32, setRng } from '@/lib/game/rng'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const FIXTURE_NAME = 'normal-move-with-blocker'
const FIXTURE_SEED = 0x5eed64

type BrowserEngine = {
  applyBattleAction: typeof applyBattleAction
  mulberry32: typeof mulberry32
  setRng: typeof setRng
}

function loadBrowserEngine(): BrowserEngine {
  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  const bundleSource = readFileSync(bundlePath, 'utf8')
  const context: Record<string, unknown> = {
    Buffer,
    clearTimeout,
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    process,
    require: createRequire(import.meta.url),
    setTimeout,
  }

  runInNewContext(bundleSource, context, { filename: bundlePath })
  return context.GameEngine as BrowserEngine
}

function makeFixture() {
  const mover = makePiece({ instanceId: 'mover', ownerPlayerId: 'player-red', x: 2, y: 2, moveRange: 3 })
  const blocker = makePiece({ instanceId: 'blocker', ownerPlayerId: 'player-blue', x: 3, y: 2 })
  const state = makeState({ pieces: [mover, blocker], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 5 })

  return {
    action: { type: 'move' as const, playerId: 'player-red', pieceId: 'mover', toX: 2, toY: 1 },
    state,
  }
}

describe('game engine Node/browser differential fixture', () => {
  it(`${FIXTURE_NAME} (seed ${FIXTURE_SEED}) returns the same state and action log`, () => {
    const nodeFixture = makeFixture()
    const browserFixture = makeFixture()
    const browser = loadBrowserEngine()

    expect(browser.applyBattleAction).toBeTypeOf('function')
    expect(browser.setRng).toBeTypeOf('function')
    expect(browser.mulberry32).toBeTypeOf('function')

    setRng(mulberry32(FIXTURE_SEED))
    const nodeResult = applyBattleAction(nodeFixture.state, nodeFixture.action)

    browser.setRng(browser.mulberry32(FIXTURE_SEED))
    const browserResult = browser.applyBattleAction(browserFixture.state, browserFixture.action)

    expect({ fixture: FIXTURE_NAME, seed: FIXTURE_SEED, result: browserResult }).toEqual({
      fixture: FIXTURE_NAME,
      seed: FIXTURE_SEED,
      result: nodeResult,
    })
  })
})
