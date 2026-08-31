/* eslint-disable @typescript-eslint/no-explicit-any -- the VM bridge validates runtime bundle values without shared static types */
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
    snapshotTransactionState: vi.fn(() => ({ nextRootEventId: 0, ruleLimits: [] })),
    restoreTransactionState: vi.fn(),
    updateCooldowns: vi.fn(),
  },
  TriggerType: {},
}))
vi.mock('@/lib/game/skill-repository', () => ({
  getAllSkills: vi.fn(() => []),
  getSkillById: vi.fn(() => null),
}))

import { mulberry32, setRng } from '@/lib/game/rng'
import { runBattleAction } from '@/lib/game/battle-runner'
import type { SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import type { TargetRef } from '@/lib/game/targeting'
import { applyBattleAction } from '@/lib/game/turn'
import type { BattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const FIXTURE_NAME = 'normal-move-with-blocker'
const FIXTURE_SEED = 0x5eed64

type BrowserEngine = {
  applyBattleAction: typeof applyBattleAction
  runBattleAction: typeof runBattleAction
  globalTriggerSystem: {
    addRules: (rules: any[]) => void
    checkTriggers: (state: any, context: any) => { success: boolean }
    clearRules: () => void
  }
  mulberry32: typeof mulberry32
  setRng: typeof setRng
}

type BrowserTargetingError = {
  needsTargetSelection?: true
  preparation?: { selectionId: string; stateRevision: number; candidates: TargetRef[] }
}

function loadSkill(skillId: string): SkillDefinition {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'data/skills', `${skillId}.json`), 'utf8'))
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
    TextDecoder,
    TextEncoder,
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

function makeDemonSummonFixture() {
  const anchor = makePiece({
    instanceId: 'differential-demon-anchor',
    templateId: 'red-anchor',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    currentHp: 20,
    maxHp: 20,
    attack: 3,
  })
  Object.assign(anchor, { name: '献祭者' })
  const state = makeState({
    pieces: [anchor],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 4,
    height: 4,
  }) as any
  const red = state.players.find((player: any) => player.playerId === 'player-red')
  red.hand = [{
    cardId: 'demon-summon-5',
    instanceId: 'differential-demon-card',
    actionPointCost: 3,
  }]
  red.discardPile = []
  red.actionPoints = 3
  state.extensions.kiljaedanPiece = {
    instanceId: 'differential-kiljaedan-hidden',
    templateId: 'kiljaedan',
    name: '基尔加丹',
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

  const draft = {
    type: 'playCard' as const,
    playerId: 'player-red',
    cardInstanceId: 'differential-demon-card',
    clientActionId: 'red139-browser-demon-damage-summon',
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected demon-summon-5 target preparation, received ${prepared.kind}`)
  }
  const action: BattleAction = {
    ...draft,
    targetPieceId: anchor.instanceId,
    targetX: anchor.x,
    targetY: anchor.y,
    extraTargets: [{ x: 2, y: 2 }],
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }

  return { action, state }
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

  it('keeps the real demon-summon-5 damage→summon EffectChain identical in Node and browser', () => {
    const nodeFixture = makeDemonSummonFixture()
    const browserFixture = structuredClone(nodeFixture)
    const browser = loadBrowserEngine()

    const nodeResult = runBattleAction(nodeFixture.state, nodeFixture.action, { rootSeed: FIXTURE_SEED })
    const browserResult = browser.runBattleAction(browserFixture.state, browserFixture.action, {
      rootSeed: FIXTURE_SEED,
    })

    expect(browserResult).toEqual(nodeResult)
    expect(browserResult.state.pieces.find((piece: any) => piece.instanceId === 'differential-demon-anchor'))
      .toMatchObject({ currentHp: 14, attack: 4 })
    expect(browserResult.state.pieces.find((piece: any) => piece.instanceId === 'differential-kiljaedan-hidden'))
      .toMatchObject({ templateId: 'kiljaedan', currentHp: 17, x: 2, y: 2 })
    expect(browserResult.state.extensions?.kiljaedanPiece).toBeUndefined()
    expect(browserResult.state.players.find((player: any) => player.playerId === 'player-red'))
      .toMatchObject({ actionPoints: 0, discardPile: ['demon-summon-5'] })
  })

  it('executes all four trigger consumer categories in the approved order', () => {
    const trace: string[] = []
    const browser = loadBrowserEngine()
    const browserRule = (id: string, priority: number) => ({
      id,
      name: id,
      description: id,
      priority,
      trigger: { type: 'ordering' },
      effect: () => { trace.push(id); return { success: true } },
    })
    const piece = makePiece({
      rules: [browserRule('piece-rule', 0)],
    }) as any
    const state = makeState({ pieces: [piece] }) as any
    state.extensions.trace = trace
    state.players[0].rules = [browserRule('player-rule', 0)]
    state.players[0].hand = [
      { cardId: 'ordering-response-first', instanceId: 'card-1', ownerPlayerId: 'player-red' },
      { cardId: 'ordering-response-second', instanceId: 'card-2', ownerPlayerId: 'player-red' },
    ]
    state.customCards = {
      'ordering-response-first': {
        id: 'ordering-response-first',
        name: 'ordering-response-first',
        description: 'ordering-response-first',
        type: 'reactive',
        trigger: { type: 'ordering' },
        code: "function executeCard(context) { context.battle.extensions.trace.push('response-card-first'); return { success: true } }",
      },
      'ordering-response-second': {
        id: 'ordering-response-second',
        name: 'ordering-response-second',
        description: 'ordering-response-second',
        type: 'reactive',
        trigger: { type: 'ordering' },
        code: "function executeCard(context) { context.battle.extensions.trace.push('response-card-second'); return { success: true } }",
      },
    }

    browser.globalTriggerSystem.clearRules()
    try {
      browser.globalTriggerSystem.addRules([browserRule('global-rule', 0)])
      const result = browser.globalTriggerSystem.checkTriggers(state, { type: 'ordering', playerId: 'player-red' })

      expect(result.success).toBe(true)
      expect(trace).toEqual([
        'global-rule',
        'piece-rule',
        'player-rule',
        'response-card-first',
        'response-card-second',
      ])
      expect(state.players[0].hand).toEqual([])
      expect(state.players[0].discardPile).toEqual(['ordering-response-first', 'ordering-response-second'])
    } finally {
      browser.globalTriggerSystem.clearRules()
    }
  })
  it('executes a migrated projectile skill through the tracked browser bundle', () => {
    const browser = loadBrowserEngine()
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 0, y: 0, attack: 10 })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0 })
    const state = makeState({ pieces: [caster, enemy], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 1 })
    const skill = loadSkill('blackwidow-lethal-strike')
    state.skillsById[skill.id] = skill
    state.pieces[0].skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]

    let targetingError: BrowserTargetingError | undefined
    try {
      browser.applyBattleAction(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: 'caster',
        skillId: skill.id,
      } as BattleAction)
    } catch (error) {
      targetingError = error as BrowserTargetingError
    }
    expect(targetingError?.needsTargetSelection).toBe(true)
    const preparation = targetingError?.preparation
    expect(preparation).toBeDefined()
    if (!preparation) throw new Error('Browser bundle did not provide target preparation')

    const result = browser.applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'caster',
      skillId: skill.id,
      targetX: 5,
      targetY: 0,
      selectionId: preparation.selectionId,
      stateRevision: preparation.stateRevision,
    } as BattleAction)

    expect(result.pieces.find(piece => piece.instanceId === 'enemy')?.currentHp).toBe(89)
  })

  it('does not offer shotgun directions hidden behind blocking cover in the tracked browser bundle', () => {
    const browser = loadBrowserEngine()
    const caster = makePiece({ instanceId: 'caster', ownerPlayerId: 'player-red', x: 2, y: 2, attack: 10 })
    const target = makePiece({ instanceId: 'target', ownerPlayerId: 'player-blue', x: 4, y: 2 })
    const state = makeState({ pieces: [caster, target], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 5 })
    const skill = loadSkill('hellfire-shotgun')
    state.skillsById[skill.id] = skill
    state.pieces[0].skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    const cover = state.map.tiles.find(tile => tile.x === 3 && tile.y === 2)
    if (!cover) throw new Error('Cover fixture tile is missing')
    cover.props = { ...cover.props, type: 'cover', bulletPassable: false }

    let targetingError: BrowserTargetingError | undefined
    try {
      browser.applyBattleAction(state, {
        type: 'useBasicSkill',
        playerId: 'player-red',
        pieceId: 'caster',
        skillId: skill.id,
      } as BattleAction)
    } catch (error) {
      targetingError = error as BrowserTargetingError
    }

    expect(targetingError?.needsTargetSelection).toBe(true)
    const preparation = targetingError?.preparation
    expect(preparation).toBeDefined()
    if (!preparation) throw new Error('Browser bundle did not provide target preparation')
    const candidates = preparation.candidates
      .filter((ref): ref is Extract<TargetRef, { type: 'cell' }> => ref.type === 'cell')
      .map(ref => `${ref.x},${ref.y}`)
    expect(candidates).not.toContain('3,2')
    expect(candidates).not.toContain('4,2')
    expect(candidates).not.toContain('5,2')
  })

  it('keeps the tracked browser bundle in sync with Muru hand multi-select pending metadata', () => {
    const browser = loadBrowserEngine()
    const caster = makePiece({
      instanceId: 'browser-liadrin', templateId: 'liadrin', ownerPlayerId: 'player-red', x: 0, y: 0,
    }) as any
    const enemy = makePiece({
      instanceId: 'browser-enemy', ownerPlayerId: 'player-blue', x: 2, y: 0, currentHp: 20, maxHp: 20,
    })
    const state = makeState({
      pieces: [caster, enemy], currentPlayerId: 'player-red', phase: 'action', width: 4, height: 1,
    }) as any
    const skill = loadSkill('muru-lament')
    state.skillsById[skill.id] = skill
    caster.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state.players[0].hand = ['holy-charge', 'holy-smite', 'holy-heal'].map((cardId, index) => ({
      cardId,
      instanceId: `browser-holy-${index}`,
      ownerPlayerId: 'player-red',
    }))

    const pending = browser.applyBattleAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: caster.instanceId,
      skillId: skill.id,
    } as BattleAction) as any

    expect(pending.pendingOptionSelection).toMatchObject({
      canCancel: true,
      selectionMode: 'multi',
      presentation: 'hand',
      minSelections: 1,
      maxSelections: 3,
    })
    expect(pending.pendingOptionSelection.options.map((option: any) => option.value))
      .toEqual(['browser-holy-0', 'browser-holy-1', 'browser-holy-2'])
    expect(pending.pendingOptionSelection.options.every((option: any) => !Array.isArray(option.value))).toBe(true)

    const resolved = browser.applyBattleAction(pending, {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption: ['browser-holy-1'],
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as BattleAction) as any

    expect(resolved.pendingOptionSelection).toBeUndefined()
    expect(resolved.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })
    expect(resolved.players[0].hand.map((card: any) => card.instanceId))
      .toEqual(['browser-holy-0', 'browser-holy-2'])
    expect(resolved.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBe(18)
  })
})
