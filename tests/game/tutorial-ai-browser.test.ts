/* eslint-disable @typescript-eslint/no-explicit-any -- VM bridge validates the generated browser API at runtime. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { hashStable } from '@/lib/game/battle-trace'
import { makePiece, makeState } from '../helpers/minimal-state'

const ROOT_SEED = 0x228a11
const RESOURCE_CATEGORIES = ['skills', 'rules', 'pieces', 'cards', 'maps'] as const

type BrowserEngine = {
  applyBattleAction: (state: any, action: any) => any
  createInitialBattleForPlayers: (...args: any[]) => Promise<any>
  getPieceById: (id: string) => any
  listLegalAIActions: (state: any, playerId: string) => any[]
  planTutorialAiAction: (state: any, playerId: string, rootSeed: number, options?: any) => any
  TUTORIAL_AI_DEFAULTS: Record<string, number>
}

type BrowserLoad = {
  engine: BrowserEngine
  tutorialEngine: BrowserEngine
  lessons: any
  missing: string[]
  primedFiles: number
}

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
  // The adventure client supplies this game-start rule explicitly because the
  // legacy rules manifest still names the older alias.
  files['data/rules/rule-lucky-coin-gamestart.json'] = readJson('data/rules/rule-lucky-coin-gamestart.json')

  const context: Record<string, any> = {
    Buffer,
    clearTimeout,
    console: { error: () => undefined, log: () => undefined, warn: () => undefined },
    performance,
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

  const lessonsPath = resolve(process.cwd(), 'data/pages/js/tutorial/tutorial-lessons.js')
  runInNewContext(readFileSync(lessonsPath, 'utf8'), context, { filename: lessonsPath })

  // The browser entry starts with an empty DEFAULT_PIECES table because it
  // cannot use the server-only filesystem loader. Build the same page-owned
  // piece table that battle.html passes to tutorial-lessons.createBattle.
  const engine = context.GameEngine as BrowserEngine
  context.__RVB_PIECE_JSON = Object.fromEntries(
    (readJson('data/pieces/manifest.json') as string[]).map(id => [
      id,
      JSON.stringify(files[`data/pieces/${id}.json`]),
    ]),
  )
  runInNewContext(
    '__RVB_PIECES_BY_ID = Object.create(null); Object.keys(__RVB_PIECE_JSON).forEach(function (id) { __RVB_PIECES_BY_ID[id] = JSON.parse(__RVB_PIECE_JSON[id]) })',
    context,
  )
  delete context.__RVB_PIECE_JSON

  // Match battle.html: parse the published identity inside the VM and pass a
  // VM-local getPieceById adapter to tutorial-lessons.createBattle.
  context.__RVB_PROFILE_JSON = JSON.stringify(getServerGameProfileIdentityV1())
  runInNewContext(
    `__RVB_TUTORIAL_ENGINE = Object.assign({}, GameEngine, {
      tutorialProfileIdentity: GameEngine.parseGameProfileIdentityV1(JSON.parse(__RVB_PROFILE_JSON)),
      getPieceById: function (id) { return __RVB_PIECES_BY_ID[id] },
    })`,
    context,
  )
  delete context.__RVB_PROFILE_JSON

  return {
    engine,
    tutorialEngine: context.__RVB_TUTORIAL_ENGINE as BrowserEngine,
    lessons: context.RvBTutorialLessons,
    missing,
    primedFiles,
  }
}

function browserEngine(): BrowserEngine {
  cachedBrowserLoad ??= loadBrowserEngineWithRealResources()
  expect(cachedBrowserLoad.primedFiles).toBeGreaterThan(RESOURCE_CATEGORIES.length)
  expect(cachedBrowserLoad.missing).toEqual([])
  expect(cachedBrowserLoad.engine.planTutorialAiAction).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.applyBattleAction).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.createInitialBattleForPlayers).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.getPieceById).toBeTypeOf('function')
  expect(cachedBrowserLoad.lessons.get).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.TUTORIAL_AI_DEFAULTS).toMatchObject({
    nodesPerDecision: 128,
    turnTimeMs: 2500,
    decisionTimeMs: 250,
  })
  return cachedBrowserLoad.engine
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

function tacticalState() {
  const caster = makePiece({
    instanceId: 'red-caster',
    templateId: 'uther',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    moveRange: 2,
    attack: 4,
    maxHp: 15,
    currentHp: 15,
    skills: [skillState('blessed-hammer')],
  }) as any
  caster.isCore = true

  const target = makePiece({
    instanceId: 'blue-target',
    templateId: 'target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 3,
    y: 0,
    maxHp: 12,
    currentHp: 12,
    actionPoints: 0,
    maxActionPoints: 0,
  }) as any
  target.isCore = true

  const state = makeState({
    pieces: [caster, target],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 8,
    height: 3,
  }) as any
  state.players[0].actionPoints = 2
  state.players[0].maxActionPoints = 2
  state.skillsById['blessed-hammer'] = readJson('data/skills/blessed-hammer.json')
  return state
}

describe('RED-228 generated browser tutorial AI bundle', () => {
  it('primes real resources, replans move then skill, and preserves authoritative inputs', () => {
    const engine = browserEngine()
    const state = tacticalState()
    const beforePlanningHash = hashStable(state)

    const first = engine.planTutorialAiAction(state, 'player-red', ROOT_SEED)
    expect(first.nextAction?.action).toMatchObject({ type: 'move', pieceId: 'red-caster' })
    expect(first.nodes).toBeGreaterThan(0)
    expect(first.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(hashStable(state)).toBe(beforePlanningHash)

    const beforeMoveHash = hashStable(state)
    const afterMove = engine.applyBattleAction(state, first.nextAction.action)
    expect(hashStable(state)).toBe(beforeMoveHash)
    expect(afterMove.pieces.find((piece: any) => piece.instanceId === 'red-caster')).toMatchObject({ y: 0 })
    expect(afterMove.pieces.find((piece: any) => piece.instanceId === 'red-caster')?.x).toBeGreaterThan(0)

    const beforeSecondPlanningHash = hashStable(afterMove)
    const second = engine.planTutorialAiAction(afterMove, 'player-red', ROOT_SEED, {
      continuation: first.continuation,
      actionsTakenThisTurn: 1,
    })
    expect(second.nextAction?.action).toMatchObject({
      type: 'useBasicSkill',
      pieceId: 'red-caster',
      skillId: 'blessed-hammer',
      targetPieceId: 'blue-target',
    })
    expect(second.nodes).toBeGreaterThan(0)
    expect(second.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(hashStable(afterMove)).toBe(beforeSecondPlanningHash)

    const beforeSkillHash = hashStable(afterMove)
    const afterSkill = engine.applyBattleAction(afterMove, second.nextAction.action)
    expect(hashStable(afterMove)).toBe(beforeSkillHash)
    expect(afterSkill.pieces.find((piece: any) => piece.instanceId === 'blue-target')?.currentHp).toBe(8)

    // Keep the measured budget evidence visible in the focused QA run without asserting a wall-clock deadline.
    console.info('[RED-228 browser AI]', JSON.stringify({
      seed: ROOT_SEED,
      defaults: engine.TUTORIAL_AI_DEFAULTS,
      firstAction: first.nextAction?.action,
      firstNodes: first.nodes,
      firstElapsedMs: first.elapsedMs,
      secondAction: second.nextAction?.action,
      secondNodes: second.nodes,
      secondElapsedMs: second.elapsedMs,
    }))
  })

  it('plans and executes a real terrain lesson inside one VM realm', async () => {
    const loaded = cachedBrowserLoad ?? loadBrowserEngineWithRealResources()
    cachedBrowserLoad = loaded
    const engine = browserEngine()
    const lesson = loaded.lessons.get('terrain')
    expect(lesson).toMatchObject({ id: 'terrain', mapId: 'large-hole-arena', rootSeed: 18704 })

    // Keep lesson construction, map lookup, piece lookup, and authority in the
    // generated VM. Passing a Node-created BattleState here would cross realms
    // and can change runtime collection/prototype behavior in the bundle.
    expect(loaded.tutorialEngine.getPieceById('reaper')).toBeTruthy()
    let state = await loaded.lessons.createBattle(loaded.tutorialEngine, lesson)
    expect(state).toBeTruthy()
    state = engine.applyBattleAction(state, {
      type: 'endTurn',
      playerId: lesson.player.playerId,
    })
    state = engine.applyBattleAction(state, { type: 'beginPhase' })

    const beforePlanningHash = hashStable(state)
    const legal = engine.listLegalAIActions(state, lesson.opponent.playerId)
    const decision = engine.planTutorialAiAction(state, lesson.opponent.playerId, lesson.rootSeed)
    const evaluated = decision.trace.filter((row: any) => row.reason === 'evaluated')
    process.stdout.write('[RED-228 browser terrain AI] ' + JSON.stringify({
      seed: lesson.rootSeed,
      map: lesson.mapId,
      legalCount: legal.length,
      action: decision.nextAction?.action,
      nodes: decision.nodes,
      considered: decision.considered,
      elapsedMs: decision.elapsedMs,
      stopReason: decision.stopReason,
      evaluated: evaluated.length,
      rejected: decision.trace.filter((row: any) => row.reason === 'rejected').length,
    }) + '\n')
    expect(legal.length).toBeGreaterThan(0)
    expect(decision.nodes).toBeGreaterThan(0)
    expect(evaluated.length).toBeGreaterThan(0)
    expect(decision.nextAction?.action).toBeDefined()
    expect(decision.nextAction?.action.type).toMatch(/^(move|useBasicSkill|useChargeSkill|playCard)$/)
    expect(hashStable(state)).toBe(beforePlanningHash)

    const beforeAuthorityHash = hashStable(state)
    const nextState = engine.applyBattleAction(state, decision.nextAction!.action)
    expect(hashStable(state)).toBe(beforeAuthorityHash)
    expect(nextState.actions.length).toBeGreaterThan(state.actions.length)

  })
})
