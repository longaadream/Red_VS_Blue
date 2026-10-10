/* eslint-disable @typescript-eslint/no-explicit-any -- browser VM and JSON fixtures use runtime-shaped state. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it } from 'vitest'

import { applyBattleAction as applyNodeBattleAction } from '@/lib/game/turn'
import { getPieceById } from '@/lib/game/piece-repository'
import { mulberry32 } from '@/lib/game/rng'
import { prepareAction } from '@/lib/game/targeting'
import { loadRuleById } from '@/lib/game/skills'
import { makePiece, makeState } from '../helpers/minimal-state'

type BrowserEngine = {
  applyBattleAction: (state: any, action: any) => any
  getPieceById: (pieceId: string) => any
  loadRuleById: (ruleId: string, forceReload?: boolean) => any
  mulberry32: (seed: number) => () => number
  setRng: (rng: () => number) => void
}

type BrowserLoad = {
  engine: BrowserEngine
  missing: string[]
  primedFiles: number
  setMathRandom: (random: () => number) => void
  restoreMathRandom: () => void
}

const RESOURCE_CATEGORIES = ['cards', 'skills', 'rules', 'pieces'] as const
const ROOT_SEED = 7
const BANKAI_ID = 'ichigo-bankai-tensa-zangetsu'
const BLESSING_ID = 'elune-blessing'
const EXPEDITION_ID = 'turalyon-expedition-order'
const MARCH_RULE_ID = 'rule-turalyon-lightforged-march'

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

  const browserMath = runInNewContext('Math', context) as Math
  const nativeMathRandom = browserMath.random
  return {
    engine: context.GameEngine as BrowserEngine,
    missing,
    primedFiles,
    setMathRandom: (random) => { browserMath.random = random },
    restoreMathRandom: () => { browserMath.random = nativeMathRandom },
  }
}

function browserEngine(): BrowserEngine {
  cachedBrowserLoad ??= loadBrowserEngineWithRealResources()
  expect(cachedBrowserLoad.primedFiles).toBeGreaterThan(0)
  expect(cachedBrowserLoad.missing).toEqual([])
  expect(cachedBrowserLoad.engine.applyBattleAction).toBeTypeOf('function')
  expect(cachedBrowserLoad.engine.getPieceById).toBeTypeOf('function')
  return cachedBrowserLoad.engine
}

function withSeededNodeMath<T>(operation: () => T): T {
  const nativeMathRandom = Math.random
  Math.random = mulberry32(ROOT_SEED)
  try {
    return operation()
  } finally {
    Math.random = nativeMathRandom
  }
}

function withSeededBrowserMath<T>(operation: () => T): T {
  const load = cachedBrowserLoad!
  load.setMathRandom(mulberry32(ROOT_SEED))
  try {
    return operation()
  } finally {
    load.restoreMathRandom()
  }
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

function card(cardId: string, instanceId: string, actionPointCost = 1) {
  return { cardId, instanceId, ownerPlayerId: 'player-red', actionPointCost }
}

function actionIdentity(pending: any) {
  return {
    selectionId: pending.selectionId,
    stateRevision: pending.stateRevision,
  }
}

function summarizeState(state: any) {
  const hand = (state.players?.[0]?.hand ?? []).map((entry: any) => ({
    cardId: entry.cardId,
    // Generated card IDs are runtime identity and may differ between the two
    // isolated hosts; the card ID, hand order, and discard are authoritative.
    instanceId: typeof entry.instanceId === 'string' && entry.instanceId.startsWith('ci-')
      ? '<generated-card-instance>'
      : entry.instanceId,
    actionPointCost: entry.actionPointCost,
  }))
  const pieces = (state.pieces ?? [])
    .map((piece: any) => ({
      instanceId: piece.instanceId,
      x: piece.x,
      y: piece.y,
      currentHp: piece.currentHp,
      attack: piece.attack,
      moveRange: piece.moveRange,
      hasMoved: piece.hasMoved,
      skills: (piece.skills ?? []).map((skill: any) => ({
        skillId: skill.skillId,
        currentCooldown: skill.currentCooldown,
      })),
      statusTags: (piece.statusTags ?? []).map((tag: any) => ({
        id: tag.id,
        type: tag.type,
        intensity: tag.intensity,
        currentUses: tag.currentUses,
      })),
    }))
    .sort((a: any, b: any) => a.instanceId.localeCompare(b.instanceId))
  const pendingTarget = state.pendingTargetSelection
  const pendingOption = state.pendingOptionSelection
  return {
    players: {
      actionPoints: state.players?.[0]?.actionPoints,
      chargePoints: state.players?.[0]?.chargePoints,
      hand,
      discardPile: [...(state.players?.[0]?.discardPile ?? [])],
      buffs: state.players?.[0]?.buffs,
    },
    pieces,
    pendingTarget: pendingTarget && {
      targetType: pendingTarget.targetType,
      canCancel: pendingTarget.canCancel,
      candidateCount: pendingTarget.targetCandidates?.length ?? pendingTarget.candidates?.length,
      candidates: (pendingTarget.targetCandidates ?? pendingTarget.candidates ?? [])
        .map((candidate: any) => ({
          type: candidate.type,
          pieceId: candidate.pieceId,
          x: candidate.x,
          y: candidate.y,
        }))
        .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      selectedTargets: pendingTarget.selectedTargets,
    },
    pendingOption: pendingOption && {
      canCancel: pendingOption.canCancel,
      options: pendingOption.options,
    },
    actions: (state.actions ?? []).map((entry: any) => ({
      type: entry.type,
      playerId: entry.playerId,
      payload: {
        freeMove: entry.payload?.freeMove,
        path: entry.payload?.path,
        pieceId: entry.payload?.pieceId,
        targetId: entry.payload?.targetId,
        finalDamage: entry.payload?.finalDamage,
        finalHeal: entry.payload?.finalHeal,
      },
    })),
  }
}

function makeBankaiState(chargePoints: number) {
  const ichigo = makePiece({
    instanceId: 'red259-ichigo',
    templateId: 'blue-ichigo',
    name: '黑崎一护',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    attack: 5,
    moveRange: 4,
    skills: [skillState(BANKAI_ID)],
  }) as any
  const state = makeState({ pieces: [ichigo], currentPlayerId: 'player-red', phase: 'action' }) as any
  state.skillsById[BANKAI_ID] = readJson(`data/skills/${BANKAI_ID}.json`)
  state.players[0].actionPoints = 2
  state.players[0].chargePoints = chargePoints
  return state
}

function makeBlessingState() {
  const tyrande = makePiece({
    instanceId: 'red259-tyrande',
    templateId: 'tyrande',
    name: '泰兰德',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    currentHp: 5,
    maxHp: 30,
    attack: 4,
    moveRange: 3,
    skills: [skillState(BLESSING_ID)],
  }) as any
  const enemy = makePiece({
    instanceId: 'red259-enemy',
    templateId: 'enemy',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 0,
    currentHp: 20,
    maxHp: 20,
  }) as any
  const state = makeState({ pieces: [tyrande, enemy], currentPlayerId: 'player-red', phase: 'action' }) as any
  state.skillsById[BLESSING_ID] = readJson(`data/skills/${BLESSING_ID}.json`)
  state.players[0].actionPoints = 3
  state.players[0].hand = []
  return state
}

function makeVelenState() {
  const template = getPieceById('velen')
  if (!template) throw new Error('Node piece repository did not load Velen')
  const velen = makePiece({
    instanceId: 'red259-velen',
    templateId: 'velen',
    name: template.name,
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    skills: template.skills.map((entry: any) => skillState(entry.skillId)),
  }) as any
  const state = makeState({ pieces: [velen], currentPlayerId: 'player-red', phase: 'action' }) as any
  state.skillsById[EXPEDITION_ID] = readJson(`data/skills/${EXPEDITION_ID}.json`)
  state.players[0].actionPoints = 2
  state.players[0].hand = [card('holy-smite', 'red259-existing-card')]
  return state
}

function makeMarchState() {
  const turalyon = makePiece({
    instanceId: 'red259-turalyon',
    templateId: 'turalyon',
    name: '图拉扬',
    ownerPlayerId: 'player-red',
    x: 0,
    y: 0,
    rules: [loadRuleById(MARCH_RULE_ID, true)!],
  }) as any
  const mover = makePiece({
    instanceId: 'red259-mover',
    templateId: 'ally',
    name: '友军',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    moveRange: 3,
  }) as any
  const state = makeState({
    pieces: [turalyon, mover],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 8,
    height: 8,
  }) as any
  state.players[0].actionPoints = 4
  state.players[0].hand = [
    card('holy-charge', 'red259-march-card-1', 2),
    card('holy-charge', 'red259-march-card-2', 2),
  ]
  return state
}

function attachBrowserMarchRule(engine: BrowserEngine, state: any) {
  const turalyon = state.pieces.find((piece: any) => piece.instanceId === 'red259-turalyon')
  const rule = engine.loadRuleById(MARCH_RULE_ID)
  expect(rule).toBeTruthy()
  turalyon.rules = [rule]
}

function browserPrepareOption(engine: BrowserEngine, state: any, action: any) {
  try {
    engine.applyBattleAction(state, action)
  } catch (error) {
    const selectionError = error as any
    expect(selectionError.needsOptionSelection).toBe(true)
    expect(selectionError.preparation).toMatchObject({
      kind: 'needOption',
      selectionId: expect.any(String),
      stateRevision: expect.any(Number),
    })
    return selectionError.preparation
  }
  throw new Error('Expected browser applyBattleAction to request an option')
}

function selectPiece(apply: (state: any, action: any) => any, state: any, pieceId: string) {
  const pending = state.pendingTargetSelection
  return apply(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetPieceId: pieceId,
    ...actionIdentity(pending),
  })
}

function selectCell(apply: (state: any, action: any) => any, state: any, x: number, y: number) {
  const pending = state.pendingTargetSelection
  return apply(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-red',
    targetX: x,
    targetY: y,
    ...actionIdentity(pending),
  })
}

function marchRuleIds(state: any) {
  return state.pieces.find((piece: any) => piece.instanceId === 'red259-turalyon')?.rules?.map((rule: any) => rule.id)
}

afterEach(() => {
  cachedBrowserLoad?.restoreMathRandom()
})

describe('RED-259 browser game-engine bundle parity', () => {
  it('loads all RED259 JSON through the real browser VFS and matches Node for Bankai CP gating', () => {
    const engine = browserEngine()
    const action = {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: 'red259-ichigo',
      skillId: BANKAI_ID,
    }

    const insufficientNode = makeBankaiState(1)
    const insufficientBrowser = makeBankaiState(1)
    const beforeNode = JSON.stringify(insufficientNode)
    const beforeBrowser = JSON.stringify(insufficientBrowser)
    expect(() => applyNodeBattleAction(insufficientNode, action as any)).toThrow()
    expect(() => engine.applyBattleAction(insufficientBrowser, action)).toThrow()
    expect(JSON.stringify(insufficientNode)).toBe(beforeNode)
    expect(JSON.stringify(insufficientBrowser)).toBe(beforeBrowser)

    const sufficientNode = makeBankaiState(2)
    const sufficientBrowser = makeBankaiState(2)
    const nodeResult = applyNodeBattleAction(sufficientNode, action as any)
    const browserResult = engine.applyBattleAction(sufficientBrowser, action)
    expect(summarizeState(browserResult)).toEqual(summarizeState(nodeResult))
    expect(summarizeState(browserResult)).toMatchObject({
      players: { chargePoints: 0 },
      pieces: [expect.objectContaining({
        instanceId: 'red259-ichigo',
        attack: 6,
        moveRange: 6,
        skills: expect.arrayContaining([expect.objectContaining({ skillId: 'ichigo-black-getsuga-tensho' })]),
      })],
    })
  })

  it('matches Node for seeded Elune blessing: real holy smite 5→7, one-use consumption, and cooldown 2', () => {
    const engine = browserEngine()
    const skillAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'red259-tyrande',
      skillId: BLESSING_ID,
    }

    const nodeAfterBlessing = withSeededNodeMath(() => applyNodeBattleAction(makeBlessingState(), skillAction as any))
    const browserAfterBlessing = withSeededBrowserMath(() => engine.applyBattleAction(makeBlessingState(), skillAction))
    expect(summarizeState(browserAfterBlessing)).toEqual(summarizeState(nodeAfterBlessing))
    expect(browserAfterBlessing.players[0].hand).toHaveLength(1)
    expect(browserAfterBlessing.players[0].hand[0].cardId).toBe('holy-smite')
    expect(browserAfterBlessing.players[0].buffs['elune-blessing-buff']).toMatchObject({ multiplier: 1.5, uses: 1 })
    expect(browserAfterBlessing.pieces.find((piece: any) => piece.instanceId === 'red259-tyrande')?.skills)
      .toEqual(expect.arrayContaining([expect.objectContaining({ skillId: BLESSING_ID, currentCooldown: 2 })]))

    const firstCardId = nodeAfterBlessing.players[0].hand[0].instanceId
    const nodeAfterFirstCard = applyNodeBattleAction(nodeAfterBlessing, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: firstCardId,
    } as any)
    const browserAfterFirstCard = engine.applyBattleAction(browserAfterBlessing, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: browserAfterBlessing.players[0].hand[0].instanceId,
    })
    expect(summarizeState(browserAfterFirstCard)).toEqual(summarizeState(nodeAfterFirstCard))
    expect(browserAfterFirstCard.pieces.find((piece: any) => piece.instanceId === 'red259-enemy')?.currentHp).toBe(13)
    expect(browserAfterFirstCard.players[0].buffs['elune-blessing-buff']).toMatchObject({ multiplier: 1.5, uses: 0 })

    const secondCard = card('holy-smite', 'red259-second-smite')
    nodeAfterFirstCard.players[0].hand.push(secondCard)
    browserAfterFirstCard.players[0].hand.push({ ...secondCard })
    const nodeAfterSecondCard = applyNodeBattleAction(nodeAfterFirstCard, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: secondCard.instanceId,
    } as any)
    const browserAfterSecondCard = engine.applyBattleAction(browserAfterFirstCard, {
      type: 'playCard', playerId: 'player-red', cardInstanceId: secondCard.instanceId,
    })
    expect(summarizeState(browserAfterSecondCard)).toEqual(summarizeState(nodeAfterSecondCard))
    expect(browserAfterSecondCard.pieces.find((piece: any) => piece.instanceId === 'red259-enemy')?.currentHp).toBe(8)
  })

  it('loads Velen from the real piece definition and matches all three Expedition Order choices, cost 1 and cooldown 2', () => {
    const engine = browserEngine()
    const nodeTemplate = getPieceById('velen')
    const browserTemplate = readJson('data/pieces/velen.json')
    expect(nodeTemplate?.skills.map((entry: any) => entry.skillId)).toContain(EXPEDITION_ID)
    expect(browserTemplate?.skills.map((entry: any) => entry.skillId)).toContain(EXPEDITION_ID)
    expect(browserTemplate?.skills.map((entry: any) => entry.skillId)).toEqual(nodeTemplate?.skills.map((entry: any) => entry.skillId))

    for (const selectedOption of ['holy-smite', 'holy-heal', 'holy-charge']) {
      const nodeState = makeVelenState()
      const browserState = makeVelenState()
      const action = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'red259-velen', skillId: EXPEDITION_ID,
      }
      const nodePreparation = prepareAction(nodeState, action as any)
      expect(nodePreparation.kind).toBe('needOption')
      if (nodePreparation.kind !== 'needOption') throw new Error('Expected Node Expedition Order option')
      const browserPreparation = browserPrepareOption(engine, browserState, action)
      expect(browserPreparation.options).toEqual(nodePreparation.options)
      expect(browserPreparation.options).toEqual([
        { label: '圣光惩戒', value: 'holy-smite' },
        { label: '圣光治疗', value: 'holy-heal' },
        { label: '圣光充能', value: 'holy-charge' },
      ])

      const nodeResult = applyNodeBattleAction(nodeState, {
        ...action,
        selectedOption,
        selectionId: nodePreparation.selectionId,
        stateRevision: nodePreparation.stateRevision,
      } as any)
      const browserResult = engine.applyBattleAction(browserState, {
        ...action,
        selectedOption,
        selectionId: browserPreparation.selectionId,
        stateRevision: browserPreparation.stateRevision,
      })
      expect(summarizeState(browserResult)).toEqual(summarizeState(nodeResult))
      expect(browserResult.players[0].hand.map((entry: any) => entry.cardId)).toEqual(['holy-smite', selectedOption])
      expect(browserResult.players[0].actionPoints).toBe(1)
      expect(browserResult.pieces[0].skills.find((entry: any) => entry.skillId === EXPEDITION_ID))
        .toMatchObject({ currentCooldown: 2 })
    }
  })

  it('matches Node for two consecutive March corner routes and preserves free normal movement', () => {
    const engine = browserEngine()
    const nodeState = makeMarchState()
    const browserState = makeMarchState()
    attachBrowserMarchRule(engine, browserState)
    expect(marchRuleIds(browserState)).toEqual([MARCH_RULE_ID])

    for (const [index, destination] of [[1, { x: 3, y: 2 }], [2, { x: 4, y: 3 }]] as const) {
      const cardInstanceId = `red259-march-card-${index}`
      const playAction = { type: 'playCard', playerId: 'player-red', cardInstanceId }
      const nodePendingPiece = applyNodeBattleAction(nodeState, playAction as any)
      const browserPendingPiece = engine.applyBattleAction(browserState, playAction)
      expect(summarizeState(browserPendingPiece)).toEqual(summarizeState(nodePendingPiece))
      expect(browserPendingPiece.pendingTargetSelection).toMatchObject({ targetType: 'piece', canCancel: true })

      const nodePendingCell = selectPiece(applyNodeBattleAction as any, nodePendingPiece, 'red259-mover')
      const browserPendingCell = selectPiece(engine.applyBattleAction, browserPendingPiece, 'red259-mover')
      expect(summarizeState(browserPendingCell)).toEqual(summarizeState(nodePendingCell))
      expect(browserPendingCell.pendingTargetSelection).toMatchObject({ targetType: 'grid', canCancel: true })
      const browserCandidates = browserPendingCell.pendingTargetSelection.targetCandidates
        ?? browserPendingCell.pendingTargetSelection.candidates
      expect(browserCandidates).toContainEqual({ type: 'cell', ...destination })

      const nodeResult = selectCell(applyNodeBattleAction as any, nodePendingCell, destination.x, destination.y)
      const browserResult = selectCell(engine.applyBattleAction, browserPendingCell, destination.x, destination.y)
      expect(summarizeState(browserResult)).toEqual(summarizeState(nodeResult))
      const mover = browserResult.pieces.find((piece: any) => piece.instanceId === 'red259-mover')
      expect(mover).toMatchObject({ x: destination.x, y: destination.y, hasMoved: false })
      expect(browserResult.actions.filter((entry: any) => entry.type === 'move')).toHaveLength(index)
      const move = browserResult.actions.filter((entry: any) => entry.type === 'move').at(-1)
      expect(move?.payload).toMatchObject({ freeMove: true, pieceId: 'red259-mover' })
      const positionChange = browserResult.actions.filter((entry: any) => entry.type === 'positionChanged').at(-1)
      expect(positionChange?.payload).toMatchObject({ pieceId: 'red259-mover', movementKind: 'walk' })
      expect(positionChange?.payload.path.length).toBeGreaterThan(1)
      for (const [stepIndex, step] of positionChange.payload.path.entries()) {
        const previous = stepIndex === 0 ? { x: index === 1 ? 1 : 3, y: index === 1 ? 1 : 2 } : positionChange.payload.path[stepIndex - 1]
        expect(Math.abs(step.x - previous.x) + Math.abs(step.y - previous.y)).toBe(1)
      }
      nodeState.pieces = nodeResult.pieces
      nodeState.players = nodeResult.players
      nodeState.actions = nodeResult.actions
      nodeState.targetingRevision = nodeResult.targetingRevision
      browserState.pieces = browserResult.pieces
      browserState.players = browserResult.players
      browserState.actions = browserResult.actions
      browserState.targetingRevision = browserResult.targetingRevision
    }
  })

  it('matches Node when the first March is canceled once and the second card still opens its own pending move', () => {
    const engine = browserEngine()
    const nodeState = makeMarchState()
    const browserState = makeMarchState()
    attachBrowserMarchRule(engine, browserState)
    const firstAction = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-march-card-1' }
    const nodePending = applyNodeBattleAction(nodeState, firstAction as any)
    const browserPending = engine.applyBattleAction(browserState, firstAction)
    const cancel = (state: any, apply: (state: any, action: any) => any) => apply(state, {
      type: 'cancelPendingSelection',
      playerId: 'player-red',
      ...actionIdentity(state.pendingTargetSelection),
    })
    const nodeAfterCancel = cancel(nodePending, applyNodeBattleAction as any)
    const browserAfterCancel = cancel(browserPending, engine.applyBattleAction)
    expect(summarizeState(browserAfterCancel)).toEqual(summarizeState(nodeAfterCancel))
    expect(browserAfterCancel.pendingTargetSelection).toBeUndefined()
    expect(browserAfterCancel.players[0]).toMatchObject({ actionPoints: 2, discardPile: ['holy-charge'] })
    expect(browserAfterCancel.actions.filter((entry: any) => entry.type === 'move')).toHaveLength(0)

    const secondAction = { type: 'playCard', playerId: 'player-red', cardInstanceId: 'red259-march-card-2' }
    const nodeSecondPending = applyNodeBattleAction(nodeAfterCancel, secondAction as any)
    const browserSecondPending = engine.applyBattleAction(browserAfterCancel, secondAction)
    expect(summarizeState(browserSecondPending)).toEqual(summarizeState(nodeSecondPending))
    expect(browserSecondPending.pendingTargetSelection).toMatchObject({ targetType: 'piece', canCancel: true })
  })
})
