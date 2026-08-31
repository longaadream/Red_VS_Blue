/* eslint-disable @typescript-eslint/no-explicit-any -- the VM bridge validates runtime bundle values without shared static types */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
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
import {
  hashBattleState,
  recordBattleInitialization,
  runBattleAction,
} from '@/lib/game/battle-runner'
import { RuleRuntime } from '@/lib/game/rule-runtime'
import type { SkillDefinition } from '@/lib/game/skills'
import type { TargetRef } from '@/lib/game/targeting'
import { applyBattleAction } from '@/lib/game/turn'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import { pinTestBattleState } from './profile-test-identity'

const FIXTURE_NAME = 'normal-move-with-blocker'
const FIXTURE_SEED = 0x5eed64

type BrowserEngine = {
  applyBattleAction: typeof applyBattleAction
  globalTriggerSystem: {
    addRules: (rules: any[]) => void
    checkTriggers: (state: any, context: any) => { success: boolean }
    clearRules: () => void
  }
  hashBattleState: typeof hashBattleState
  mulberry32: typeof mulberry32
  runBattleAction: typeof runBattleAction
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

const PROGRESSIVE_FIXTURE_SEED = 0x138b0
const PROGRESSIVE_MODE = 'progressive-reserve-v1'
const PROGRESSIVE_PLAYERS = ['player-red', 'player-blue'] as const

function makeProgressiveCore(
  instanceId: string,
  ownerPlayerId: typeof PROGRESSIVE_PLAYERS[number],
  x: number | null,
  y: number | null,
) {
  return {
    ...makePiece({
      instanceId,
      ownerPlayerId,
      faction: ownerPlayerId === 'player-red' ? 'red' : 'blue',
      x: x ?? 0,
      y: y ?? 0,
      currentHp: 12,
      maxHp: 12,
      moveRange: 2,
    }),
    name: instanceId,
    isCore: true,
    x,
    y,
    buffs: [],
    debuffs: [],
    ruleTags: [],
  }
}

function makeProgressiveRunnerFixture(): BattleState {
  const redVanguard = makeProgressiveCore('red-vanguard', PROGRESSIVE_PLAYERS[0], 0, 0)
  const blueVanguard = makeProgressiveCore('blue-vanguard', PROGRESSIVE_PLAYERS[1], 11, 0)
  const redReserve = makeProgressiveCore('red-reserve', PROGRESSIVE_PLAYERS[0], null, null)
  const state = makeState({
    pieces: [redVanguard, blueVanguard] as any,
    currentPlayerId: PROGRESSIVE_PLAYERS[0],
    phase: 'start',
    width: 12,
    height: 9,
  }) as any
  state.gameStartFired = true
  state.deployment = {
    mode: PROGRESSIVE_MODE,
    status: 'awaiting-reserve-deploy',
    playerIds: [...PROGRESSIVE_PLAYERS],
    choices: {},
    locks: {
      [PROGRESSIVE_PLAYERS[0]]: { locked: false },
      [PROGRESSIVE_PLAYERS[1]]: { locked: false },
    },
    startedAt: 1_750_000_000_000,
    deadlineAt: 1_750_000_030_000,
    revision: 7,
    initialPositions: {
      [redVanguard.instanceId]: { x: redVanguard.x, y: redVanguard.y },
      [blueVanguard.instanceId]: { x: blueVanguard.x, y: blueVanguard.y },
    },
    openingVanguardsInitialized: true,
    reserves: {
      [PROGRESSIVE_PLAYERS[0]]: [redReserve],
      [PROGRESSIVE_PLAYERS[1]]: [],
    },
    reserveCounts: {
      [PROGRESSIVE_PLAYERS[0]]: 1,
      [PROGRESSIVE_PLAYERS[1]]: 0,
    },
    activePlayerId: PROGRESSIVE_PLAYERS[0],
    offerTurnNumber: 1,
    offerPieceIds: [redReserve.instanceId],
    legalPositions: [{ x: 5, y: 6 }],
  }
  pinTestBattleState(state, PROGRESSIVE_FIXTURE_SEED)
  recordBattleInitialization(
    state,
    new RuleRuntime({ rootSeed: PROGRESSIVE_FIXTURE_SEED }),
    [...PROGRESSIVE_PLAYERS],
  )
  return state
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function runtimeCursors(state: BattleState): Record<string, number> {
  return cloneJson((state.extensions as any)?.debugBattle?.authority?.runtimeCursors ?? {})
}

function captureRuleError(run: () => unknown): Record<string, unknown> {
  try {
    run()
  } catch (error) {
    const ruleError = error as any
    return cloneJson({
      code: ruleError?.code,
      name: ruleError?.name,
      determinism: ruleError?.determinism,
    })
  }
  throw new Error('Expected the progressive deployment command to be rejected')
}

function progressiveStateContract(state: BattleState) {
  const deployment = state.deployment
  return cloneJson({
    deployment: deployment && {
      mode: deployment.mode,
      status: deployment.status,
      revision: deployment.revision,
      openingVanguardsInitialized: deployment.openingVanguardsInitialized,
      activePlayerId: deployment.activePlayerId,
      offerPieceIds: deployment.offerPieceIds,
      reserveCounts: deployment.reserveCounts,
      reservePieceIds: Object.fromEntries(Object.entries(deployment.reserves ?? {})
        .map(([playerId, pieces]) => [playerId, pieces.map(piece => piece.instanceId)])),
    },
    pieces: state.pieces.map(piece => ({
      instanceId: piece.instanceId,
      ownerPlayerId: piece.ownerPlayerId,
      isCore: piece.isCore,
      currentHp: piece.currentHp,
      x: piece.x,
      y: piece.y,
      statusTags: piece.statusTags,
    })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    turn: state.turn,
    terminalResult: state.terminalResult,
    runtimeCursors: runtimeCursors(state),
  })
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

  it('rejects stale and missing progressive deployment revisions identically without state or RNG mutation', () => {
    const browser = loadBrowserEngine()
    const source = makeProgressiveRunnerFixture()
    const staleRevision = source.deployment!.revision - 1

    expect(browser.runBattleAction).toBeTypeOf('function')
    expect(browser.hashBattleState).toBeTypeOf('function')

    for (const expectedDeploymentRevision of [staleRevision, undefined]) {
      const nodeState = cloneJson(source)
      const browserState = cloneJson(source)
      const action = {
        type: 'deployReservePiece',
        playerId: PROGRESSIVE_PLAYERS[0],
        expectedDeploymentRevision,
        pieceId: 'red-reserve',
        toX: 5,
        toY: 6,
        clientActionId: expectedDeploymentRevision === undefined
          ? 'browser-progressive-missing-revision'
          : 'browser-progressive-stale-revision',
      } as unknown as BattleAction
      const nodeBefore = {
        hash: hashBattleState(nodeState),
        cursors: runtimeCursors(nodeState),
        contract: progressiveStateContract(nodeState),
      }
      const browserBefore = {
        hash: browser.hashBattleState(browserState),
        cursors: runtimeCursors(browserState),
        contract: progressiveStateContract(browserState),
      }

      const nodeError = captureRuleError(() =>
        runBattleAction(nodeState, action, { rootSeed: PROGRESSIVE_FIXTURE_SEED }))
      const browserError = captureRuleError(() =>
        browser.runBattleAction(browserState, action, { rootSeed: PROGRESSIVE_FIXTURE_SEED }))

      expect(nodeError).toMatchObject({ code: 'PROGRESSIVE_DEPLOYMENT_STALE_REVISION' })
      expect(browserError).toEqual(nodeError)
      expect(hashBattleState(nodeState)).toBe(nodeBefore.hash)
      expect(browser.hashBattleState(browserState)).toBe(browserBefore.hash)
      expect(runtimeCursors(nodeState)).toEqual(nodeBefore.cursors)
      expect(runtimeCursors(browserState)).toEqual(browserBefore.cursors)
      expect(progressiveStateContract(nodeState)).toEqual(nodeBefore.contract)
      expect(progressiveStateContract(browserState)).toEqual(browserBefore.contract)
      expect(browserBefore).toEqual(nodeBefore)
    }
  })

  it('executes progressive reserve deploy and tagged first move through the tracked bundle with the Node state hash', () => {
    const browser = loadBrowserEngine()
    const source = makeProgressiveRunnerFixture()
    const nodeState = cloneJson(source)
    const browserState = cloneJson(source)
    const deployAction: BattleAction = {
      type: 'deployReservePiece',
      playerId: PROGRESSIVE_PLAYERS[0],
      expectedDeploymentRevision: source.deployment!.revision,
      pieceId: 'red-reserve',
      toX: 5,
      toY: 6,
      clientActionId: 'browser-progressive-deploy',
    }

    const nodeDeployed = runBattleAction(nodeState, deployAction, {
      rootSeed: PROGRESSIVE_FIXTURE_SEED,
    })
    const browserDeployed = browser.runBattleAction(browserState, deployAction, {
      rootSeed: PROGRESSIVE_FIXTURE_SEED,
    })

    expect(browserDeployed.stateHash).toBe(nodeDeployed.stateHash)
    expect(browser.hashBattleState(browserDeployed.state)).toBe(hashBattleState(nodeDeployed.state))
    expect(progressiveStateContract(browserDeployed.state))
      .toEqual(progressiveStateContract(nodeDeployed.state))
    expect(cloneJson(browserDeployed.trace?.deployment)).toEqual(cloneJson(nodeDeployed.trace?.deployment))
    expect(browserDeployed.trace?.deployment).toMatchObject({
      command: 'deploy',
      mode: PROGRESSIVE_MODE,
      status: 'complete',
      openingVanguardsInitialized: true,
      lastDeployedPieceId: 'red-reserve',
      deployedPosition: { x: 5, y: 6 },
    })
    expect(nodeDeployed.state.turn.phase).toBe('action')
    expect(nodeDeployed.state.pieces.find(piece => piece.instanceId === 'red-reserve')?.statusTags)
      .toContainEqual(expect.objectContaining({
        type: 'deployment-first-move-free',
        grantedTurnNumber: 1,
      }))

    const moveAction: BattleAction = {
      type: 'move',
      playerId: PROGRESSIVE_PLAYERS[0],
      pieceId: 'red-reserve',
      toX: 5,
      toY: 5,
    }
    const nodeMoved = runBattleAction(nodeDeployed.state, moveAction, {
      rootSeed: PROGRESSIVE_FIXTURE_SEED,
    })
    const browserMoved = browser.runBattleAction(browserDeployed.state, moveAction, {
      rootSeed: PROGRESSIVE_FIXTURE_SEED,
    })

    expect(browserMoved.stateHash).toBe(nodeMoved.stateHash)
    expect(browser.hashBattleState(browserMoved.state)).toBe(hashBattleState(nodeMoved.state))
    expect(progressiveStateContract(browserMoved.state))
      .toEqual(progressiveStateContract(nodeMoved.state))
    expect(browserMoved.trace?.deployment).toBeUndefined()
    expect(nodeMoved.state.turn.phase).toBe('action')
    expect(nodeMoved.state.players.find(player => player.playerId === PROGRESSIVE_PLAYERS[0])?.actionPoints)
      .toBe(nodeDeployed.state.players.find(player => player.playerId === PROGRESSIVE_PLAYERS[0])?.actionPoints)
    expect(nodeMoved.state.pieces.find(piece => piece.instanceId === 'red-reserve')?.statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'deployment-first-move-free' }))
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
