/* eslint-disable @typescript-eslint/no-explicit-any -- VM bridge validates the real browser bundle at runtime. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { applyBattleAction as applyNodeBattleAction } from '@/lib/game/turn'
import { loadRuleById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'

type BrowserEngine = {
  applyBattleAction: (state: any, action: any) => any
  loadRuleById: (ruleId: string) => any
}

type BrowserLoad = {
  engine: BrowserEngine
  missing: string[]
  primedFiles: number
}

const RESOURCE_CATEGORIES = ['skills', 'rules', 'pieces'] as const
const SHADOW_SKILL_ID = 'shadow-ride-sweep'
const SHADOW_RULE_ID = 'rule-momentum-consume'
const COLT_ZONE_RULE_ID = 'rule-colt-zone-endturn'
const COLT_STRIDE_RULE_ID = 'rule-colt-big-stride'

let cachedBrowserLoad: BrowserLoad | undefined

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8'))
}

function loadBrowserEngineWithRealResources(): BrowserLoad {
  const files: Record<string, unknown> = {}
  const missing: string[] = []

  for (const category of RESOURCE_CATEGORIES) {
    const manifestPath = `data/${category}/manifest.json`
    const ids = readJson(manifestPath)
    files[manifestPath] = ids
    for (const id of ids as string[]) {
      const relativePath = `data/${category}/${id}.json`
      try {
        files[relativePath] = readJson(relativePath)
      } catch {
        missing.push(relativePath)
      }
    }
  }

  const context: Record<string, any> = {
    Buffer,
    clearTimeout,
    console: { error: () => undefined, log: () => undefined, warn: () => undefined },
    setTimeout,
    TextDecoder,
    TextEncoder,
  }
  context.window = context
  context.process = { env: {}, cwd: () => '' }

  const runtimePath = resolve(process.cwd(), 'data/pages/js/game-engine-runtime.js')
  runInNewContext(readFileSync(runtimePath, 'utf8'), context, { filename: runtimePath })
  const primedFiles = context.RvBGameEngine.primeJsonFiles(files)

  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath })

  return { engine: context.GameEngine as BrowserEngine, missing, primedFiles }
}

function browserEngine(): BrowserEngine {
  cachedBrowserLoad ??= loadBrowserEngineWithRealResources()
  expect(cachedBrowserLoad.primedFiles).toBeGreaterThan(0)
  expect(cachedBrowserLoad.missing).toEqual([])
  expect(cachedBrowserLoad.engine.applyBattleAction).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.loadRuleById).toBeTypeOf('function')
  return cachedBrowserLoad.engine
}

function attachBrowserRule(engine: BrowserEngine, piece: any, ruleId: string) {
  const rule = engine.loadRuleById(ruleId)
  expect(rule).toBeTruthy()
  piece.rules = [...(piece.rules || []), rule]
}

function attachNodeRule(piece: any, ruleId: string) {
  const rule = loadRuleById(ruleId)
  expect(rule).toBeTruthy()
  piece.rules = [...(piece.rules || []), rule]
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

function browserPrepare(engine: BrowserEngine, state: any, action: Record<string, unknown>) {
  try {
    engine.applyBattleAction(state, action)
  } catch (error) {
    const targetingError = error as any
    expect(targetingError.needsTargetSelection).toBe(true)
    expect(targetingError.preparation).toMatchObject({
      kind: 'needTarget',
      selectionId: expect.any(String),
      stateRevision: expect.any(Number),
    })
    return targetingError.preparation
  }
  throw new Error('Expected browser applyBattleAction to request a target')
}

function stateSummary(state: any) {
  const piece = (instanceId: string) => state.pieces.find((candidate: any) => candidate.instanceId === instanceId)
  const zone = state.extensions?.coltZones?.colt
  const pending = state.pendingTargetSelection
  return {
    colt: { x: piece('colt')?.x, y: piece('colt')?.y, hp: piece('colt')?.currentHp },
    oldLine: piece('old-line')?.currentHp,
    newLine: piece('new-line')?.currentHp,
    coverEnemy: piece('cover-enemy')?.currentHp,
    behindCover: piece('behind-cover')?.currentHp,
    beyondFour: piece('beyond-four')?.currentHp,
    pathEnemy: piece('path-enemy')?.currentHp,
    sideEnemy: piece('side-enemy')?.currentHp,
    ally: piece('ally')?.currentHp,
    zone: zone && { turns: zone.turns, kind: zone.kind, dx: zone.dx, dy: zone.dy },
    phase: state.turn.phase,
    currentPlayerId: state.turn.currentPlayerId,
    pending: pending && {
      playerId: pending.playerId,
      canCancel: pending.canCancel,
      targetType: pending.targetType,
      candidateCount: pending.candidates?.length ?? pending.targetCandidates?.length,
    },
    actionTypes: (state.actions || []).map((action: any) => action.type),
  }
}

function makeShadowState(momentum = 7) {
  const shadow = makePiece({
    instanceId: 'shadow',
    templateId: 'shadow',
    ownerPlayerId: 'player-red',
    faction: 'evil',
    x: 1,
    y: 5,
    attack: 5,
    currentHp: 20,
    maxHp: 20,
    skills: [skillState(SHADOW_SKILL_ID)],
  })
  shadow.momentum = momentum
  shadow.statusTags = [{ type: 'momentum-core', stacks: momentum, skillIds: [SHADOW_SKILL_ID] }]
  const pathEnemy = makePiece({
    instanceId: 'path-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 5, currentHp: 20, maxHp: 20,
  })
  const sideEnemy = makePiece({
    instanceId: 'side-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 4, currentHp: 20, maxHp: 20,
  })
  const coverEnemy = makePiece({
    instanceId: 'cover-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 2, currentHp: 20, maxHp: 20,
  })
  const behindCover = makePiece({
    instanceId: 'behind-cover', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1, currentHp: 20, maxHp: 20,
  })
  const beyondFour = makePiece({
    instanceId: 'beyond-four', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, maxHp: 20,
  })
  const ally = makePiece({
    instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 2, y: 3, currentHp: 20, maxHp: 20,
  })
  const state = makeState({
    pieces: [shadow, pathEnemy, sideEnemy, coverEnemy, behindCover, beyondFour, ally],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 8,
    height: 8,
  }) as any
  state.players[0].actionPoints = 10
  state.skillsById[SHADOW_SKILL_ID] = readJson(`data/skills/${SHADOW_SKILL_ID}.json`)
  const cover = state.map.tiles.find((tile: any) => tile.x === 3 && tile.y === 2)
  cover.props = { ...cover.props, type: 'cover', walkable: true, bulletPassable: false }
  return state
}

function resolveShadowNode(state: any) {
  const action = {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: SHADOW_SKILL_ID,
  }
  const preparation = prepareAction(state, action as any)
  if (preparation.kind !== 'needTarget') throw new Error('Node Shadow action did not request dash target')
  const afterDash = applyNodeBattleAction(state, {
    ...action,
    targetX: 4,
    targetY: 5,
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  } as any)
  const pending = afterDash.pendingTargetSelection
  if (!pending) throw new Error('Node Shadow action did not request side target')
  return applyNodeBattleAction(afterDash, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: 4,
    targetY: 4,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  } as any)
}

function resolveShadowBrowser(engine: BrowserEngine, state: any) {
  const action = {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'shadow', skillId: SHADOW_SKILL_ID,
  }
  const preparation = browserPrepare(engine, state, action)
  const afterDash = engine.applyBattleAction(state, {
    ...action,
    targetX: 4,
    targetY: 5,
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  })
  const pending = afterDash.pendingTargetSelection
  expect(pending).toBeDefined()
  return engine.applyBattleAction(afterDash, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: 4,
    targetY: 4,
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  })
}

function prepareColtState(kind = 'revolver', currentPlayerId = 'player-blue') {
  const colt = makePiece({
    instanceId: 'colt', templateId: 'colt', name: '柯尔特', ownerPlayerId: 'player-red', faction: 'good',
    x: 1, y: 1, attack: 6, currentHp: 20, maxHp: 20,
  })
  const oldLine = makePiece({
    instanceId: 'old-line', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20,
  })
  const newLine = makePiece({
    instanceId: 'new-line', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 2, currentHp: 20, maxHp: 20,
  })
  const state = makeState({
    pieces: [colt, oldLine, newLine], currentPlayerId, phase: 'action', width: 9, height: 6,
  }) as any
  state.players[0].actionPoints = 0
  state.extensions.coltZones = {
    colt: { sourceId: 'colt', kind, dx: 1, dy: 0, turns: 2 },
  }
  return state
}

function prepareColtFriendBlockState() {
  const colt = makePiece({
    instanceId: 'colt', templateId: 'colt', name: '柯尔特', ownerPlayerId: 'player-red', faction: 'good',
    x: 0, y: 0, attack: 6, currentHp: 20, maxHp: 20,
  })
  const ally = makePiece({
    instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'red', x: 1, y: 0, currentHp: 20, maxHp: 20,
  })
  const enemy = makePiece({
    instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0, currentHp: 20, maxHp: 20,
  })
  const state = makeState({
    pieces: [colt, ally, enemy], currentPlayerId: 'player-red', phase: 'action', width: 6, height: 1,
  }) as any
  state.extensions.coltZones = {
    colt: { sourceId: 'colt', kind: 'revolver', dx: 1, dy: 0, turns: 1 },
  }
  return state
}

function attachColtRules(state: any, attach: (piece: any, ruleId: string) => void) {
  const colt = state.pieces.find((piece: any) => piece.instanceId === 'colt')
  if (!colt) throw new Error('Missing Colt')
  attach(colt, COLT_STRIDE_RULE_ID)
  attach(colt, COLT_ZONE_RULE_ID)
}

function resolveColtEndTurnNode(cancel: boolean) {
  const state = prepareColtState()
  attachColtRules(state, attachNodeRule)
  const pending = applyNodeBattleAction(state, { type: 'endTurn', playerId: 'player-blue' } as any)
  expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', canCancel: true })
  const session = pending.pendingTargetSelection!
  const identity = { playerId: 'player-red', selectionId: session.selectionId, stateRevision: session.stateRevision }
  return applyNodeBattleAction(pending, cancel
    ? { type: 'cancelPendingSelection', ...identity } as any
    : { type: 'pendingTargetSelect', ...identity, targetX: 1, targetY: 2 } as any)
}

function resolveColtEndTurnBrowser(engine: BrowserEngine, cancel: boolean) {
  const state = prepareColtState()
  attachColtRules(state, (piece, ruleId) => attachBrowserRule(engine, piece, ruleId))
  const pending = engine.applyBattleAction(state, { type: 'endTurn', playerId: 'player-blue' })
  expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', canCancel: true })
  const session = pending.pendingTargetSelection
  const identity = { playerId: 'player-red', selectionId: session.selectionId, stateRevision: session.stateRevision }
  return engine.applyBattleAction(pending, cancel
    ? { type: 'cancelPendingSelection', ...identity }
    : { type: 'pendingTargetSelect', ...identity, targetX: 1, targetY: 2 })
}

describe('RED-218 browser game-engine bundle regressions', () => {
  it('uses the executed detour path for momentum gain in Node and the browser bundle', () => {
    const path = [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 0 }]
    const makeDetourState = () => {
      const sonic = makePiece({
        instanceId: 'detour-sonic', templateId: 'sonic', ownerPlayerId: 'player-red', x: 0, y: 0, moveRange: 4,
        skills: [{ skillId: 'sonic-spin-dash', currentCooldown: 0, usesRemaining: -1 }],
      })
      sonic.statusTags = [{ type: 'momentum-core', stacks: 0 }]
      const blocker = makePiece({ instanceId: 'detour-blocker', ownerPlayerId: 'player-blue', x: 1, y: 0 })
      return makeState({ pieces: [sonic, blocker], currentPlayerId: 'player-red', phase: 'action', width: 5, height: 3 }) as any
    }
    const engine = browserEngine()
    const nodeState = makeDetourState()
    const nodeSonic = nodeState.pieces.find((piece: any) => piece.instanceId === 'detour-sonic')
    attachNodeRule(nodeSonic, 'rule-momentum-gain')
    const browserState = makeDetourState()
    const browserSonic = browserState.pieces.find((piece: any) => piece.instanceId === 'detour-sonic')
    attachBrowserRule(engine, browserSonic, 'rule-momentum-gain')

    const action = { type: 'move', playerId: 'player-red', pieceId: 'detour-sonic', toX: 2, toY: 0, path }
    const nodeResult = applyNodeBattleAction(nodeState, action as any)
    const browserResult = engine.applyBattleAction(browserState, action)

    expect((nodeResult.pieces.find((piece: any) => piece.instanceId === 'detour-sonic') as any)?.momentum).toBe(4)
    expect(browserResult.pieces.find((piece: any) => piece.instanceId === 'detour-sonic')?.momentum).toBe(4)
    expect(browserResult.actions?.find((entry: any) => entry.type === 'move')?.payload?.path).toEqual(path)
  })

  it('matches Node for Shadow momentum-7 side fire through cover and beyond four cells', () => {
    const engine = browserEngine()
    const nodeState = makeShadowState(7)
    attachNodeRule(nodeState.pieces.find((piece: any) => piece.instanceId === 'shadow'), SHADOW_RULE_ID)
    const browserState = makeShadowState(7)
    attachBrowserRule(engine, browserState.pieces.find((piece: any) => piece.instanceId === 'shadow'), SHADOW_RULE_ID)

    const nodeResult = resolveShadowNode(nodeState)
    const browserResult = resolveShadowBrowser(engine, browserState)

    expect(stateSummary(browserResult)).toEqual(stateSummary(nodeResult))
    expect(stateSummary(browserResult)).toMatchObject({
      pathEnemy: 13,
      sideEnemy: 13,
      coverEnemy: 13,
      behindCover: 20,
      beyondFour: 13,
      ally: 20,
      colt: { x: undefined, y: undefined },
    })
    expect(browserResult.pendingTargetSelection).toBeUndefined()
  })

  it('matches Node for Colt cancel: pending owner chooses to forgo, then the original zone fires once', () => {
    const engine = browserEngine()
    const nodeResult = resolveColtEndTurnNode(true)
    const browserResult = resolveColtEndTurnBrowser(engine, true)

    expect(stateSummary(browserResult)).toEqual(stateSummary(nodeResult))
    expect(stateSummary(browserResult)).toMatchObject({
      colt: { x: 1, y: 1 },
      oldLine: 14,
      newLine: 20,
      zone: { turns: 1, kind: 'revolver', dx: 1, dy: 0 },
      phase: 'end',
      currentPlayerId: 'player-blue',
    })
    expect(browserResult.pendingTargetSelection).toBeUndefined()
  })

  it('matches Node for Colt selected free move: movement resolves before the zone from the new position', () => {
    const engine = browserEngine()
    const nodeResult = resolveColtEndTurnNode(false)
    const browserResult = resolveColtEndTurnBrowser(engine, false)

    expect(stateSummary(browserResult)).toEqual(stateSummary(nodeResult))
    expect(stateSummary(browserResult)).toMatchObject({
      colt: { x: 1, y: 2 },
      oldLine: 20,
      newLine: 14,
      zone: { turns: 1, kind: 'revolver', dx: 1, dy: 0 },
      phase: 'end',
      currentPlayerId: 'player-blue',
    })
    expect(browserResult.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
    expect(browserResult.actions?.filter((action: any) => action.type === 'move')).toHaveLength(1)
    expect(browserResult.pendingTargetSelection).toBeUndefined()
  })

  it('matches Node for Colt Revolver friendly blocking instead of hitting behind the ally', () => {
    const engine = browserEngine()
    const nodeState = prepareColtFriendBlockState()
    attachNodeRule(nodeState.pieces.find((piece: any) => piece.instanceId === 'colt'), COLT_ZONE_RULE_ID)
    const browserState = prepareColtFriendBlockState()
    attachBrowserRule(engine, browserState.pieces.find((piece: any) => piece.instanceId === 'colt'), COLT_ZONE_RULE_ID)

    const nodeResult = applyNodeBattleAction(nodeState, { type: 'endTurn', playerId: 'player-red' } as any)
    const browserResult = engine.applyBattleAction(browserState, { type: 'endTurn', playerId: 'player-red' })

    expect(stateSummary(browserResult)).toEqual(stateSummary(nodeResult))
    expect(browserResult.pieces.find((piece: any) => piece.instanceId === 'ally')?.currentHp).toBe(20)
    expect(browserResult.pieces.find((piece: any) => piece.instanceId === 'enemy')?.currentHp).toBe(20)
    expect(browserResult.extensions?.coltZones?.colt).toBeUndefined()
    expect(browserResult.pendingTargetSelection).toBeUndefined()
  })
})
