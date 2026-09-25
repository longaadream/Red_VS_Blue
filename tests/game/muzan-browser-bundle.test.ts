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

function makeMuzan(options: Record<string, unknown> = {}) {
  return makePiece({
    instanceId: 'muzan',
    templateId: 'dark-muzan',
    name: '鬼舞辻无惨',
    ownerPlayerId: 'player-red',
    faction: 'evil',
    x: 3,
    y: 3,
    currentHp: 15,
    maxHp: 15,
    attack: 4,
    defense: 1,
    moveRange: 4,
    ...options,
  })
}

describe('Muzan real browser bundle resources', () => {
  it('loads every resource declared by the skills, rules, and pieces manifests into the runtime VFS', () => {
    const loaded = loadBrowserEngineWithRealResources()

    expect(loaded.primedFiles).toBeGreaterThan(0)
    expect(loaded.missing).toEqual([])
    expect(loaded.engine.applyBattleAction).toBeTypeOf('function')
    expect(loaded.engine.loadRuleById).toBeTypeOf('function')
  })

  it('executes real blood whip through the generated browser bundle and hits all four cardinal lines', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const muzan = makeMuzan({
      skills: [{ skillId: 'muzan-blood-whip', currentCooldown: 0, usesRemaining: -1 }],
    })
    const targets = [
      makePiece({ instanceId: 'east', ownerPlayerId: 'player-blue', faction: 'blue', x: 6, y: 3, currentHp: 10, maxHp: 10 }),
      makePiece({ instanceId: 'west', ownerPlayerId: 'player-blue', faction: 'blue', x: 0, y: 3, currentHp: 10, maxHp: 10 }),
      makePiece({ instanceId: 'south', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 6, currentHp: 10, maxHp: 10 }),
      makePiece({ instanceId: 'north', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 0, currentHp: 10, maxHp: 10 }),
      makePiece({ instanceId: 'diagonal', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 5, currentHp: 10, maxHp: 10 }),
      makePiece({ instanceId: 'ally', ownerPlayerId: 'player-red', faction: 'evil', x: 4, y: 3, currentHp: 10, maxHp: 10 }),
    ]
    const state = makeState({
      pieces: [muzan, ...targets],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players[0].actionPoints = 2
    withSkill(state, 'muzan-blood-whip')

    const result = engine.applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: 'muzan',
      skillId: 'muzan-blood-whip',
    })

    for (const id of ['east', 'west', 'south', 'north']) {
      expect(result.pieces.find((piece: any) => piece.instanceId === id)?.currentHp).toBe(6)
    }
    expect(result.pieces.find((piece: any) => piece.instanceId === 'diagonal')?.currentHp).toBe(10)
    expect(result.pieces.find((piece: any) => piece.instanceId === 'ally')?.currentHp).toBe(10)
    expect(result.players.find((player: any) => player.playerId === 'player-red')?.actionPoints).toBe(1)
    expect(result.pieces.find((piece: any) => piece.instanceId === 'muzan')?.skills[0]?.currentCooldown).toBe(1)
  })

  it('executes real regeneration at each global turn end and caps successful heals at three', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const muzan = makeMuzan({
      currentHp: 10,
      skills: [{ skillId: 'muzan-flesh-regeneration', currentCooldown: 0, usesRemaining: -1 }],
    })
    muzan.rules = [
      engine.loadRuleById('rule-muzan-regeneration-damage'),
      engine.loadRuleById('rule-muzan-regeneration-end'),
    ].filter(Boolean)
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 6, y: 6 })
    const state = makeState({
      pieces: [muzan, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    withSkill(state, 'muzan-flesh-regeneration')

    let current = state
    const hpAfterEnds: number[] = []
    for (let index = 0; index < 4; index += 1) {
      const playerId = current.turn.currentPlayerId
      current = engine.applyBattleAction(current, { type: 'endTurn', playerId })
      hpAfterEnds.push(current.pieces.find((piece: any) => piece.instanceId === 'muzan')?.currentHp)
      current = engine.applyBattleAction(current, { type: 'beginPhase' })
    }

    expect(hpAfterEnds).toEqual([12, 14, 15, 15])
    expect(current.extensions?.flowState).toEqual(expect.arrayContaining([
      expect.objectContaining({
        namespace: 'muzan-flesh-regeneration',
        name: 'successfulHeals',
        value: 3,
      }),
    ]))
  })

  it('resolves real parasitism host and landing selections through the browser transaction', () => {
    const { engine } = loadBrowserEngineWithRealResources()
    const muzan = makeMuzan({
      currentHp: 4,
      x: 3,
      y: 1,
      skills: [{ skillId: 'muzan-parasitism', currentCooldown: 0, usesRemaining: -1 }],
    })
    const attacker = makePiece({
      instanceId: 'attacker',
      templateId: 'red-venom',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 0,
      y: 1,
      attack: 4,
      skills: [{ skillId: 'muzan-blood-whip', currentCooldown: 0, usesRemaining: -1 }],
    })
    const host = makePiece({
      instanceId: 'host',
      templateId: 'red-venom',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 3,
      y: 2,
      currentHp: 7,
      maxHp: 10,
      skills: [{ skillId: 'muzan-blood-whip', currentCooldown: 0, usesRemaining: -1 }],
    })
    const state = makeState({
      pieces: [muzan, attacker, host],
      currentPlayerId: 'player-blue',
      phase: 'action',
      width: 7,
      height: 7,
    }) as any
    state.players.find((player: any) => player.playerId === 'player-blue').actionPoints = 2
    state.players.find((player: any) => player.playerId === 'player-red').chargePoints = 2
    for (const skillId of ['muzan-blood-whip', 'muzan-flesh-regeneration', 'muzan-parasitism']) {
      withSkill(state, skillId)
    }

    const prompted = engine.applyBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-blue',
      pieceId: 'attacker',
      skillId: 'muzan-blood-whip',
    })
    const hostPrompt = prompted.pendingTargetSelection
    expect(hostPrompt).toMatchObject({
      playerId: 'player-red',
      targetType: 'piece',
      canCancel: true,
    })
    expect(hostPrompt.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'piece', pieceId: 'host' }),
    ]))
    expect(prompted.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(2)
    // Pending transactions expose the rollback snapshot; damage and payment are
    // committed only after both parasite selections are supplied.
    expect(prompted.pieces.find((piece: any) => piece.instanceId === 'muzan')?.currentHp).toBe(4)

    const hostSelected = engine.applyBattleAction(prompted, {
      type: 'pendingTargetSelect',
      playerId: hostPrompt.playerId,
      targetPieceId: 'host',
      selectionId: hostPrompt.selectionId,
      stateRevision: hostPrompt.stateRevision,
    })
    const landingPrompt = hostSelected.pendingTargetSelection
    expect(landingPrompt).toMatchObject({
      playerId: 'player-red',
      targetType: 'cell',
      canCancel: true,
    })
    expect(landingPrompt.candidates.length).toBeGreaterThan(0)
    const landing = landingPrompt.candidates.find((candidate: any) => candidate.type === 'cell')
    expect(landing).toBeDefined()

    const resolved = engine.applyBattleAction(hostSelected, {
      type: 'pendingTargetSelect',
      playerId: landingPrompt.playerId,
      targetX: landing.x,
      targetY: landing.y,
      selectionId: landingPrompt.selectionId,
      stateRevision: landingPrompt.stateRevision,
    })
    const resolvedHost = resolved.pieces.find((piece: any) => piece.instanceId === 'host')
    const deadMuzan = resolved.graveyard.find((piece: any) => piece.instanceId === 'muzan')

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players.find((player: any) => player.playerId === 'player-red')?.chargePoints).toBe(0)
    expect(resolvedHost).toMatchObject({
      ownerPlayerId: 'player-red',
      faction: 'evil',
      currentHp: 7,
      x: 3,
      y: 2,
    })
    expect(resolvedHost.skills.map((skill: any) => skill.skillId)).toEqual(expect.arrayContaining([
      'muzan-blood-whip',
      'muzan-flesh-regeneration',
    ]))
    expect(resolvedHost.rules.map((rule: any) => rule.id)).toEqual(expect.arrayContaining([
      'rule-muzan-regeneration-damage',
      'rule-muzan-regeneration-end',
    ]))
    expect(deadMuzan).toMatchObject({ currentHp: 0, x: landing.x, y: landing.y })
  })
})
