/* eslint-disable @typescript-eslint/no-explicit-any -- fixture crosses the browser VM boundary */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { makePiece, makeState } from '../helpers/minimal-state'

function loadBrowserEngine() {
  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
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
  runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath })
  return context.GameEngine as any
}

function makeFixture(browser: any) {
  const skill = JSON.parse(readFileSync(
    resolve(process.cwd(), 'data/skills/shishio-infinite-blade.json'),
    'utf8',
  ))
  const shishio = makePiece({
    instanceId: 'shishio',
    templateId: 'red-shishio',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    currentHp: 7,
    maxHp: 7,
    attack: 4,
  }) as any
  shishio.name = '志志雄真实'
  shishio.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
  const recastRule = browser.loadRuleById('rule-shishio-infinite-blade-recast', true)
  if (!recastRule) throw new Error('Missing Infinite Blade recast rule')
  shishio.rules = [recastRule]
  const first = makePiece({
    instanceId: 'first',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 1,
    currentHp: 10,
    maxHp: 10,
  })
  const second = makePiece({
    instanceId: 'second',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 2,
    currentHp: 10,
    maxHp: 10,
  })
  const state = makeState({
    pieces: [shishio, first, second],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 6,
    height: 5,
  }) as any
  state.players[0].actionPoints = 2
  state.skillsById[skill.id] = skill
  return state
}

function startInfiniteBlade(browser: any) {
  const state = makeFixture(browser)
  const action = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'shishio',
    skillId: 'shishio-infinite-blade',
  }
  let targetingError: any
  try {
    browser.applyBattleAction(state, action)
  } catch (error) {
    targetingError = error
  }
  if (!targetingError?.preparation) throw new Error('Missing first-target preparation')
  return browser.applyBattleAction(state, {
    ...action,
    targetPieceId: 'first',
    selectionId: targetingError.preparation.selectionId,
    stateRevision: targetingError.preparation.stateRevision,
  })
}

function startInfiniteBladeAgainstMarkedAlly(browser: any) {
  const skill = JSON.parse(readFileSync(
    resolve(process.cwd(), 'data/skills/shishio-infinite-blade.json'),
    'utf8',
  ))
  const shishio = makePiece({
    instanceId: 'nested-shishio',
    templateId: 'red-shishio',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    currentHp: 7,
    maxHp: 7,
    attack: 4,
  }) as any
  shishio.name = '志志雄真实'
  shishio.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
  shishio.rules = [browser.loadRuleById('rule-shishio-infinite-blade-recast', true)]

  const minato = makePiece({
    instanceId: 'nested-minato',
    templateId: 'blue-minato',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 5,
    y: 3,
    currentHp: 11,
    maxHp: 11,
    attack: 3,
  }) as any
  minato.name = '波风水门'
  minato.rules = [browser.loadRuleById('rule-minato-flying-raijin-trigger', true)]

  const markedAlly = makePiece({
    instanceId: 'marked-ally',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 2,
    y: 1,
    currentHp: 10,
    maxHp: 10,
  }) as any
  markedAlly.statusTags = [{
    id: 'nested-raijin-mark',
    type: 'flying-raijin-mark',
    name: '飞雷神',
    sourceId: minato.instanceId,
    stacks: 1,
    visible: true,
  }]

  const state = makeState({
    pieces: [shishio, minato, markedAlly],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 7,
    height: 5,
  }) as any
  state.players[0].actionPoints = 2
  state.skillsById[skill.id] = skill
  const action = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'nested-shishio',
    skillId: skill.id,
  }
  let targetingError: any
  try {
    browser.applyBattleAction(state, action)
  } catch (error) {
    targetingError = error
  }
  if (!targetingError?.preparation) throw new Error('Missing nested Infinite Blade preparation')
  return browser.applyBattleAction(state, {
    ...action,
    targetPieceId: 'marked-ally',
    selectionId: targetingError.preparation.selectionId,
    stateRevision: targetingError.preparation.stateRevision,
  })
}

function hp(state: any, pieceId: string) {
  return state.pieces.find((piece: any) => piece.instanceId === pieceId)?.currentHp
}

function makeIchigoFixture(browser: any) {
  const skill = JSON.parse(readFileSync(
    resolve(process.cwd(), 'data/skills/ichigo-black-getsuga-tensho.json'),
    'utf8',
  ))
  const ichigo = makePiece({
    instanceId: 'ichigo',
    templateId: 'blue-ichigo',
    ownerPlayerId: 'player-red',
    x: 1,
    y: 1,
    currentHp: 12,
    maxHp: 12,
    attack: 5,
  }) as any
  ichigo.name = '黑崎一护'
  ichigo.skills = [{ skillId: skill.id, currentCooldown: 0, usesRemaining: -1 }]
  const teleportRule = browser.loadRuleById('rule-ichigo-black-getsuga-teleport', true)
  if (!teleportRule) throw new Error('Missing Black Getsuga teleport rule')
  ichigo.rules = [teleportRule]

  const toxinOwner = makePiece({
    instanceId: 'toxin-owner',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 3,
    y: 1,
    currentHp: 30,
    maxHp: 30,
  })
  const shishio = makePiece({
    instanceId: 'burn-owner',
    templateId: 'red-shishio',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 5,
    y: 3,
    currentHp: 7,
    maxHp: 7,
  })
  const state = makeState({
    pieces: [ichigo, toxinOwner, shishio],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 6,
    height: 4,
  }) as any
  state.players[0].actionPoints = 3
  state.skillsById[skill.id] = skill
  const blue = state.players.find((player: any) => player.playerId === 'player-blue')
  blue.statusTags = [
    {
      id: 'toxin-a',
      type: 'lethal-toxin',
      name: '致命毒素',
      currentDuration: -1,
      intensity: 4,
      value: 3,
      extraValue: 0,
      sourceId: 'toxin-owner',
    },
    {
      id: 'toxin-b',
      type: 'lethal-toxin',
      name: '致命毒素',
      currentDuration: -1,
      intensity: 4,
      value: 5,
      extraValue: 2,
      sourceId: 'toxin-owner',
    },
  ]
  blue.rules = [browser.loadRuleById('rule-blackwidow-toxin-player', true)]
  state.extensions = {
    ...(state.extensions ?? {}),
    amaterasuCells: [{ x: 3, y: 0 }],
    shishioBurnTiles: [{ x: 3, y: 0 }],
    tileEffects: [
      { sourceId: 'toxin-a', tileType: 'lethal-toxin', x: 3, y: 0, ownerPlayerId: 'player-blue' },
      { sourceId: 'toxin-b', tileType: 'lethal-toxin', x: 5, y: 2, ownerPlayerId: 'player-blue' },
    ],
  }
  return state
}

function startBlackGetsuga(browser: any) {
  const state = makeIchigoFixture(browser)
  const action = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'ichigo',
    skillId: 'ichigo-black-getsuga-tensho',
  }
  let targetingError: any
  try {
    browser.applyBattleAction(state, action)
  } catch (error) {
    targetingError = error
  }
  if (!targetingError?.preparation) throw new Error('Missing Black Getsuga direction preparation')
  return browser.applyBattleAction(state, {
    ...action,
    targetX: 5,
    targetY: 1,
    selectionId: targetingError.preparation.selectionId,
    stateRevision: targetingError.preparation.stateRevision,
  })
}

describe('RED-129 Shishio Infinite Blade tracked-browser regression', () => {
  it('resolves the optional second strike without rebuilding the tracked bundle', () => {
    const browser = loadBrowserEngine()
    const pending = startInfiniteBlade(browser)
    expect(pending.players[0].actionPoints).toBe(2)
    expect([hp(pending, 'shishio'), hp(pending, 'first'), hp(pending, 'second')]).toEqual([7, 10, 10])
    expect(pending.pendingTargetSelection.source).toEqual({
      type: 'rule',
      id: 'rule-shishio-infinite-blade-recast',
      pieceId: 'shishio',
    })

    const session = pending.pendingTargetSelection
    const resolved = browser.applyBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: session.playerId,
      targetPieceId: 'second',
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    })

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0].actionPoints).toBe(1)
    expect([hp(resolved, 'shishio'), hp(resolved, 'first'), hp(resolved, 'second')]).toEqual([6, 6, 6])
    expect((resolved.actions ?? []).filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })

  it('commits only the first strike when the optional second strike is cancelled', () => {
    const browser = loadBrowserEngine()
    const pending = startInfiniteBlade(browser)
    const session = pending.pendingTargetSelection
    const cancelled = browser.applyBattleAction(pending, {
      type: 'cancelPendingSelection',
      playerId: session.playerId,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    })

    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0].actionPoints).toBe(1)
    expect([hp(cancelled, 'shishio'), hp(cancelled, 'first'), hp(cancelled, 'second')]).toEqual([7, 6, 10])
    expect((cancelled.actions ?? []).filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })

  it('resumes Infinite Blade second-stage selection after confirming Flying Raijin', () => {
    const browser = loadBrowserEngine()
    const raijinPending = startInfiniteBladeAgainstMarkedAlly(browser)
    expect(raijinPending.pendingOptionSelection.source).toEqual({
      type: 'rule',
      id: 'rule-minato-flying-raijin-trigger',
      pieceId: 'nested-minato',
    })
    expect([hp(raijinPending, 'nested-shishio'), hp(raijinPending, 'marked-ally')]).toEqual([7, 10])

    const raijinSession = raijinPending.pendingOptionSelection
    const recastPending = browser.applyBattleAction(raijinPending, {
      type: 'pendingOptionSelect',
      playerId: raijinSession.playerId,
      selectedOption: 'yes',
      selectionId: raijinSession.selectionId,
      stateRevision: raijinSession.stateRevision,
    })

    expect(recastPending.pendingOptionSelection).toBeUndefined()
    expect(recastPending.pendingTargetSelection.source).toEqual({
      type: 'rule',
      id: 'rule-shishio-infinite-blade-recast',
      pieceId: 'nested-shishio',
    })
    expect(recastPending.players[0].actionPoints).toBe(2)
    expect([hp(recastPending, 'nested-shishio'), hp(recastPending, 'marked-ally')]).toEqual([7, 10])

    const recastSession = recastPending.pendingTargetSelection
    const resolved = browser.applyBattleAction(recastPending, {
      type: 'pendingTargetSelect',
      playerId: recastSession.playerId,
      targetPieceId: 'marked-ally',
      selectionId: recastSession.selectionId,
      stateRevision: recastSession.stateRevision,
    })
    const minato = resolved.pieces.find((piece: any) => piece.instanceId === 'nested-minato')
    const shishio = resolved.pieces.find((piece: any) => piece.instanceId === 'nested-shishio')
    const markedAlly = resolved.pieces.find((piece: any) => piece.instanceId === 'marked-ally')

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0].actionPoints).toBe(1)
    expect([shishio.currentHp, markedAlly.currentHp]).toEqual([3, 2])
    expect(minato.attack).toBe(4)
    expect(Math.abs(minato.x - shishio.x) + Math.abs(minato.y - shishio.y)).toBe(1)
    expect(markedAlly.statusTags.some((tag: any) => tag.type === 'flying-raijin-mark')).toBe(false)
    expect(shishio.statusTags).toContainEqual(expect.objectContaining({
      type: 'flying-raijin-mark',
      sourceId: 'nested-minato',
    }))
    expect((resolved.actions ?? []).filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })
})

describe('RED-129 tracked-browser pending damage compatibility', () => {
  it('resolves Black Getsuga landing hazards through data rules in the frozen bundle', () => {
    const browser = loadBrowserEngine()
    const pending = startBlackGetsuga(browser)

    expect(pending.pendingTargetSelection.source).toEqual({
      type: 'rule',
      id: 'rule-ichigo-black-getsuga-teleport',
      pieceId: 'ichigo',
    })
    expect(pending.players[0].actionPoints).toBe(3)
    expect([hp(pending, 'ichigo'), hp(pending, 'toxin-owner')]).toEqual([12, 30])
    expect(pending.extensions?.ichigoBlackGetsugaTeleportByCaster).toBeUndefined()

    const session = pending.pendingTargetSelection
    const resolved = browser.applyBattleAction(pending, {
      type: 'pendingTargetSelect',
      playerId: session.playerId,
      targetX: 3,
      targetY: 0,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    })
    const ichigo = resolved.pieces.find((piece: any) => piece.instanceId === 'ichigo')
    const blue = resolved.players.find((player: any) => player.playerId === 'player-blue')

    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(ichigo).toMatchObject({ x: 3, y: 0, currentHp: 2 })
    expect(ichigo.skills[0]).toMatchObject({ currentCooldown: 1 })
    expect(ichigo.statusTags).toContainEqual(expect.objectContaining({
      type: 'amaterasu-burn',
      stacks: 1,
    }))
    expect(hp(resolved, 'toxin-owner')).toBe(20)
    expect(blue.statusTags.filter((tag: any) => tag.type === 'lethal-toxin')).toEqual([
      expect.objectContaining({ id: 'toxin-b', value: 5, extraValue: 2 }),
    ])
    expect(blue.rules).toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(resolved.extensions.tileEffects).toEqual([
      expect.objectContaining({ sourceId: 'toxin-b', x: 5, y: 2 }),
    ])
    expect(resolved.extensions.ichigoBlackGetsugaTeleportByCaster).toBeUndefined()
    expect((resolved.actions ?? []).filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })

  it('cancels Black Getsuga teleport while committing its projectile exactly once', () => {
    const browser = loadBrowserEngine()
    const pending = startBlackGetsuga(browser)
    const session = pending.pendingTargetSelection
    const cancelled = browser.applyBattleAction(pending, {
      type: 'cancelPendingSelection',
      playerId: session.playerId,
      selectionId: session.selectionId,
      stateRevision: session.stateRevision,
    })
    const ichigo = cancelled.pieces.find((piece: any) => piece.instanceId === 'ichigo')
    const blue = cancelled.players.find((player: any) => player.playerId === 'player-blue')

    expect(cancelled.pendingTargetSelection).toBeUndefined()
    expect(cancelled.players[0].actionPoints).toBe(1)
    expect(ichigo).toMatchObject({ x: 1, y: 1, currentHp: 12 })
    expect(ichigo.skills[0]).toMatchObject({ currentCooldown: 1 })
    expect(hp(cancelled, 'toxin-owner')).toBe(20)
    expect(blue.statusTags.filter((tag: any) => tag.type === 'lethal-toxin')).toHaveLength(2)
    expect(cancelled.extensions.ichigoBlackGetsugaTeleportByCaster).toBeUndefined()
    expect((cancelled.actions ?? []).filter((entry: any) => entry.type === 'useBasicSkill')).toHaveLength(1)
  })
})
