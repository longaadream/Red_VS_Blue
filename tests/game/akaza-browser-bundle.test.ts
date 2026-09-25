/* eslint-disable @typescript-eslint/no-explicit-any -- VM bridge validates the real browser bundle at runtime. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

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
  // The browser runtime and bundle must share one global object. In particular,
  // the bundle's external fs/path imports must resolve through this runtime VFS.
  context.window = context
  context.process = { env: {}, cwd: () => '' }

  const runtimePath = resolve(process.cwd(), 'data/pages/js/game-engine-runtime.js')
  runInNewContext(readFileSync(runtimePath, 'utf8'), context, { filename: runtimePath })
  const primedFiles = context.RvBGameEngine.primeJsonFiles(files)

  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath })

  return { engine: context.GameEngine as BrowserEngine, missing, primedFiles }
}

function withSkill(state: any, skillId: string) {
  state.skillsById[skillId] = readJson(`data/skills/${skillId}.json`)
}

function makeAkaza(options: Record<string, unknown> = {}) {
  return makePiece({
    instanceId: 'akaza',
    templateId: 'dark-akaza',
    name: '猗窝座',
    ownerPlayerId: 'player-red',
    faction: 'evil',
    x: 1,
    y: 1,
    currentHp: 16,
    maxHp: 16,
    attack: 4,
    defense: 0,
    moveRange: 5,
    ...options,
  })
}

function attachRule(engine: BrowserEngine, piece: any, ruleId: string) {
  const rule = engine.loadRuleById(ruleId)
  expect(rule).toBeTruthy()
  piece.rules = [...(piece.rules || []), rule]
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

function submitPrepared(
  engine: BrowserEngine,
  state: any,
  action: Record<string, unknown>,
  preparation: any,
  target: any,
  extraTargets: any[] = [],
) {
  return engine.applyBattleAction(state, {
    ...action,
    ...(target.type === 'piece'
      ? { targetPieceId: target.pieceId }
      : { targetX: target.x, targetY: target.y }),
    ...(extraTargets.length > 0 ? { extraTargets } : {}),
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  })
}

function skillState(skillId: string) {
  return { skillId, currentCooldown: 0, usesRemaining: -1 }
}

describe('Akaza real browser bundle resources', () => {
  it('loads the declared Akaza resources and exposes the expected piece stats', () => {
    const loaded = loadBrowserEngineWithRealResources()
    const piece = readJson('data/pieces/dark-akaza.json')

    expect(loaded.primedFiles).toBeGreaterThan(0)
    expect(loaded.missing).toEqual([])
    expect(loaded.engine.applyBattleAction).toBeTypeOf('function')
    expect(loaded.engine.loadRuleById).toBeTypeOf('function')
    expect(piece).toMatchObject({
      id: 'dark-akaza',
      faction: 'evil',
      stats: { maxHp: 16, attack: 4, defense: 0, moveRange: 5 },
    })
  })

  it('executes real annihilation through applyBattleAction with cardinal distance multipliers', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({ skills: [skillState('akaza-annihilation')] })
    const targets = [
      makePiece({ instanceId: 'near', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'middle', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'far', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'last', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 1, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'diagonal', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 2, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'opposite', ownerPlayerId: 'player-blue', faction: 'blue', x: 0, y: 1, currentHp: 99, maxHp: 100 }),
      makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'evil', x: 3, y: 1, currentHp: 99, maxHp: 100 }),
    ]
    const state = makeState({
      pieces: [akaza, ...targets],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 8,
      height: 5,
    }) as any
    state.players[0].actionPoints = 2
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-annihilation')

    const baseAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-annihilation',
    }
    const preparation = browserPrepare(engine, state, baseAction)
    expect(preparation).toMatchObject({ targetType: 'cell' })
    const east = preparation.candidates.find((candidate: any) =>
      candidate.type === 'cell' && candidate.x === 5 && candidate.y === 1,
    )
    expect(east).toBeDefined()

    const resolved = submitPrepared(engine, state, baseAction, preparation, east)
    const hp = (id: string) => resolved.pieces.find((piece: any) => piece.instanceId === id)?.currentHp
    expect(hp('near')).toBe(94)
    expect(hp('middle')).toBe(95)
    expect(hp('far')).toBe(97)
    expect(hp('last')).toBe(97)
    expect(hp('diagonal')).toBe(99)
    expect(hp('opposite')).toBe(99)
    // The ally shares a line cell with the middle target but must not be hit.
    expect(hp('ally')).toBe(99)
    expect(resolved.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'akaza')?.skills[0]?.currentCooldown).toBe(2)
  })

  it('applies the real fighting-spirit rule to a full-health enemy through the browser action', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({ skills: [skillState('akaza-disorder')] })
    const target = makePiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 50,
      maxHp: 50,
    })
    const state = makeState({
      pieces: [akaza, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 1
    attachRule(engine, akaza, 'rule-akaza-fighting-spirit')
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-disorder')

    const action = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-disorder',
    }
    const preparation = browserPrepare(engine, state, action)
    const targetCandidate = preparation.candidates.find((candidate: any) =>
      candidate.type === 'piece' && candidate.pieceId === 'target',
    )
    expect(targetCandidate).toBeDefined()
    const resolved = submitPrepared(engine, state, action, preparation, targetCandidate)

    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(44)
    expect(resolved.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
  })

  it('applies fighting-spirit damage and then the real same-turn disorder multiplier', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({
      skills: [skillState('akaza-annihilation'), skillState('akaza-disorder')],
    })
    const target = makePiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 49,
      maxHp: 50,
    })
    const state = makeState({
      pieces: [akaza, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 3
    attachRule(engine, akaza, 'rule-akaza-fighting-spirit')
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-annihilation')
    withSkill(state, 'akaza-disorder')

    const annihilationAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-annihilation',
    }
    const annihilationPreparation = browserPrepare(engine, state, annihilationAction)
    const east = annihilationPreparation.candidates.find((candidate: any) =>
      candidate.type === 'cell' && candidate.x === 2 && candidate.y === 1,
    )
    expect(east).toBeDefined()
    const afterAnnihilation = submitPrepared(engine, state, annihilationAction, annihilationPreparation, east)
    expect(afterAnnihilation.pieces.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(44)
    expect(afterAnnihilation.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(1)

    const disorderAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-disorder',
    }
    const disorderPreparation = browserPrepare(engine, afterAnnihilation, disorderAction)
    expect(disorderPreparation).toMatchObject({ targetType: 'piece' })
    const targetCandidate = disorderPreparation.candidates.find((candidate: any) =>
      candidate.type === 'piece' && candidate.pieceId === 'target',
    )
    expect(targetCandidate).toBeDefined()
    const resolved = submitPrepared(engine, afterAnnihilation, disorderAction, disorderPreparation, targetCandidate)

    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(38)
    expect(resolved.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'akaza')?.skills
      .find((skill: any) => skill.skillId === 'akaza-disorder')?.currentCooldown).toBe(1)
  })

  it('filters flash-step to a previously damaged enemy and completes both browser target selections', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({
      skills: [skillState('akaza-annihilation'), skillState('akaza-flash-step')],
    })
    const damaged = makePiece({
      instanceId: 'damaged',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 49,
      maxHp: 50,
    })
    const untouched = makePiece({
      instanceId: 'untouched',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 2,
      currentHp: 50,
      maxHp: 50,
    })
    const state = makeState({
      pieces: [akaza, damaged, untouched],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 2
    attachRule(engine, akaza, 'rule-akaza-fighting-spirit')
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-annihilation')
    withSkill(state, 'akaza-flash-step')

    const attackAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-annihilation',
    }
    const attackPreparation = browserPrepare(engine, state, attackAction)
    const east = attackPreparation.candidates.find((candidate: any) =>
      candidate.type === 'cell' && candidate.x === 2 && candidate.y === 1,
    )
    expect(east).toBeDefined()
    const afterAttack = submitPrepared(engine, state, attackAction, attackPreparation, east)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(44)
    expect(afterAttack.pieces.find((piece: any) => piece.instanceId === 'damaged')?.statusTags)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'akaza-damaged', sourceId: 'akaza' }),
      ]))

    const flashAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-flash-step',
    }
    const targetPreparation = browserPrepare(engine, afterAttack, flashAction)
    expect(targetPreparation).toMatchObject({ targetType: 'piece' })
    const candidateIds = targetPreparation.candidates
      .filter((candidate: any) => candidate.type === 'piece')
      .map((candidate: any) => candidate.pieceId)
    expect(candidateIds).toEqual(['damaged'])

    const landingPreparation = browserPrepare(engine, afterAttack, {
      ...flashAction,
      targetPieceId: 'damaged',
      selectionId: targetPreparation.selectionId,
      stateRevision: targetPreparation.stateRevision,
    })
    expect(landingPreparation).toMatchObject({ targetType: 'cell' })
    const landing = landingPreparation.candidates.find((candidate: any) =>
      candidate.type === 'cell' && !(candidate.x === 1 && candidate.y === 1),
    )
    expect(landing).toBeDefined()

    const resolved = submitPrepared(
      engine,
      afterAttack,
      flashAction,
      targetPreparation,
      { type: 'piece', pieceId: 'damaged' },
      [{ x: landing.x, y: landing.y }],
    )
    const resolvedAkaza = resolved.pieces.find((piece: any) => piece.instanceId === 'akaza')
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolvedAkaza).toMatchObject({ x: landing.x, y: landing.y, attack: 5 })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'damaged')?.currentHp).toBe(44)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === 'untouched')?.currentHp).toBe(50)
    expect(resolved.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(0)
    expect(resolvedAkaza.skills.find((skill: any) => skill.skillId === 'akaza-flash-step')?.currentCooldown).toBe(3)
  })

  it('does not create a source mark or flash-step candidate when a real hit is fully shielded', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({
      skills: [skillState('akaza-disorder'), skillState('akaza-flash-step')],
    })
    const target = makePiece({
      instanceId: 'shielded',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 50,
      maxHp: 50,
    }) as any
    target.shield = 10
    const state = makeState({
      pieces: [akaza, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 1
    attachRule(engine, akaza, 'rule-akaza-fighting-spirit')
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-disorder')
    withSkill(state, 'akaza-flash-step')

    const damageAction = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-disorder',
    }
    const damagePreparation = browserPrepare(engine, state, damageAction)
    const targetCandidate = damagePreparation.candidates.find((candidate: any) =>
      candidate.type === 'piece' && candidate.pieceId === 'shielded',
    )
    expect(targetCandidate).toBeDefined()
    const afterBlockedHit = submitPrepared(engine, state, damageAction, damagePreparation, targetCandidate)
    expect(afterBlockedHit.pieces.find((piece: any) => piece.instanceId === 'shielded')?.currentHp).toBe(50)
    expect(afterBlockedHit.pieces.find((piece: any) => piece.instanceId === 'shielded')?.statusTags)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'akaza-damaged', sourceId: 'akaza' }),
      ]))

    const flashPreparation = browserPrepare(engine, afterBlockedHit, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-flash-step',
    })
    expect(flashPreparation.candidates).not.toContainEqual({ type: 'piece', pieceId: 'shielded' })
  })

  it('does not let one Akaza borrow another Akaza source mark in the real browser target query', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const akaza = makeAkaza({
      skills: [skillState('akaza-flash-step')],
    })
    const otherAkaza = makeAkaza({
      instanceId: 'other-akaza',
      name: '另一猗窝座',
      x: 2,
      y: 2,
      skills: [skillState('akaza-disorder')],
    })
    const target = makePiece({
      instanceId: 'target',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 2,
      y: 1,
      currentHp: 50,
      maxHp: 50,
    })
    const state = makeState({
      pieces: [akaza, otherAkaza, target],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 1
    attachRule(engine, akaza, 'rule-akaza-damage-mark')
    attachRule(engine, otherAkaza, 'rule-akaza-damage-mark')
    withSkill(state, 'akaza-disorder')
    withSkill(state, 'akaza-flash-step')

    const otherAttack = {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'other-akaza',
      skillId: 'akaza-disorder',
    }
    const otherPreparation = browserPrepare(engine, state, otherAttack)
    const targetCandidate = otherPreparation.candidates.find((candidate: any) =>
      candidate.type === 'piece' && candidate.pieceId === 'target',
    )
    expect(targetCandidate).toBeDefined()
    const afterOtherAttack = submitPrepared(engine, state, otherAttack, otherPreparation, targetCandidate)
    expect(afterOtherAttack.pieces.find((piece: any) => piece.instanceId === 'target')?.currentHp).toBe(46)
    expect(afterOtherAttack.pieces.find((piece: any) => piece.instanceId === 'target')?.statusTags)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'akaza-damaged', sourceId: 'other-akaza' }),
      ]))

    const flashPreparation = browserPrepare(engine, afterOtherAttack, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'akaza',
      skillId: 'akaza-flash-step',
    })
    expect(flashPreparation.candidates).not.toContainEqual({ type: 'piece', pieceId: 'target' })
  })
})
