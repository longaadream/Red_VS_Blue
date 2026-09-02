/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored character rules expose dynamic runtime fields. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateBotActions } from '@/lib/game/ai'
import { runBattleAction } from '@/lib/game/battle-runner'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { prepareAction, targetRefKey } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

function json(path: string): any {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))
}

function expectJpeg(path: string): void {
  expect([...readFileSync(resolve(process.cwd(), path)).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
}

function rule(id: string): any {
  const loaded = loadRuleById(id, true)
  if (!loaded) throw new Error(`Rule ${id} did not load`)
  return loaded
}

function selectedAction(state: any, base: Record<string, unknown>, targetPieceId: string): any {
  const prepared = prepareAction(state, base as any)
  if (prepared.kind !== 'needTarget') throw new Error(`Expected target selection, received ${prepared.kind}`)
  return { ...base, targetPieceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

function loadBrowserEngine(): {
  runBattleAction: typeof runBattleAction
  loadRuleById: typeof loadRuleById
  globalTriggerSystem: { clearRules: () => void }
} {
  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  const context: Record<string, unknown> = {
    Buffer,
    clearTimeout,
    console,
    process,
    require: createRequire(import.meta.url),
    setTimeout,
    TextDecoder,
    TextEncoder,
  }
  runInNewContext(readFileSync(bundlePath, 'utf8'), context, { filename: bundlePath })
  return context.GameEngine as ReturnType<typeof loadBrowserEngine>
}

beforeEach(() => globalTriggerSystem.clearRules())
afterEach(() => globalTriggerSystem.clearRules())

describe('RED-163 dark character contract', () => {
  it('registers Aizen, Ulquiorra and Grimmjow with their approved base stats', () => {
    const manifest = json('data/pieces/manifest.json')
    expect(manifest).toEqual(expect.arrayContaining([
      'dark-aizen',
      'dark-ulquiorra',
      'dark-grimmjow',
    ]))

    expect(json('data/pieces/dark-aizen.json')).toMatchObject({
      faction: 'evil',
      image: 'aizen.jpg',
      stats: { maxHp: 9, attack: 4, defense: 0, moveRange: 4 },
    })
    expect(json('data/skills/aizen-kyoka-suiguetsu.json')).toMatchObject({ actionPointCost: 1 })
    const ulquiorra = json('data/pieces/dark-ulquiorra.json')
    expect(ulquiorra).toMatchObject({
      faction: 'evil',
      image: 'ulquiorra.jpg',
      stats: { maxHp: 12, attack: 4, defense: 1, moveRange: 3 },
      transformedSkills: [{ skillId: 'ulquiorra-black-cero', triggeredBy: 'ulquiorra-resurreccion' }],
    })
    expect(ulquiorra.skills).not.toContainEqual(expect.objectContaining({ skillId: 'ulquiorra-black-cero' }))
    const grimmjow = json('data/pieces/dark-grimmjow.json')
    expect(grimmjow).toMatchObject({
      faction: 'evil',
      image: 'grimmjow.jpg',
      stats: { maxHp: 5, attack: 4, defense: 0, moveRange: 4 },
      transformedSkills: [{ skillId: 'grimmjow-panther-claw', triggeredBy: 'grimmjow-resurreccion' }],
    })
    expect(grimmjow.skills).not.toContainEqual(expect.objectContaining({ skillId: 'grimmjow-panther-claw' }))
    for (const image of ['aizen.jpg', 'ulquiorra.jpg', 'grimmjow.jpg']) expectJpeg(`public/${image}`)
  })

  it('applies a configured statusTag rule to any skill primary target', () => {
    const caster = makePiece({
      instanceId: 'pressure-caster', ownerPlayerId: 'player-red', x: 1, y: 1, attack: 4,
    })
    const lower = makePiece({
      instanceId: 'lower', ownerPlayerId: 'player-blue', x: 2, y: 1, attack: 3,
    })
    const equal = makePiece({
      instanceId: 'equal', ownerPlayerId: 'player-blue', x: 1, y: 2, attack: 4,
    })
    caster.skills = [{ skillId: 'arbitrary-pressure-test', currentCooldown: 0, usesRemaining: -1 }] as never
    const state = makeState({ pieces: [caster, lower, equal] })
    state.players[0].actionPoints = 3
    state.skillsById['arbitrary-pressure-test'] = {
      id: 'arbitrary-pressure-test', name: 'test', description: '', kind: 'active', type: 'normal',
      cooldownTurns: 0, maxCharges: 0, powerMultiplier: 1, actionPointCost: 1,
      range: 'single', requiresTarget: true,
      statusTag: { id: 'fixture-pressure', type: 'skill-rule', rule: 'rule-spiritual-pressure' },
      targeting: { steps: [{ kind: 'target', type: 'piece', filter: 'enemy', range: 3 }] },
      code: 'function executeSkill() { return { success: true }; }',
    } as never

    const prepared = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId,
      skillId: 'arbitrary-pressure-test',
    })
    expect(prepared.kind).toBe('needTarget')
    if (prepared.kind !== 'needTarget') return
    expect(prepared.candidates.map(targetRefKey)).toEqual(['piece:lower'])
    expect(generateBotActions(state, 'player-red').find((action: any) => (
      action.type === 'useBasicSkill' && action.skillId === 'arbitrary-pressure-test'
    ))).toMatchObject({ targetPieceId: 'lower' })
    const beforeRejected = JSON.stringify(state)
    expect(() => applyBattleAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId,
      skillId: 'arbitrary-pressure-test', targetPieceId: equal.instanceId,
      selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
    } as any)).toThrow()
    expect(JSON.stringify(state)).toBe(beforeRejected)

    delete (state.skillsById['arbitrary-pressure-test'] as any).statusTag
    const withoutTag = prepareAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId,
      skillId: 'arbitrary-pressure-test',
    })
    expect(withoutTag.kind).toBe('needTarget')
    if (withoutTag.kind !== 'needTarget') return
    expect(withoutTag.candidates.map(targetRefKey)).toEqual(['piece:lower', 'piece:equal'])
  })

  it('regenerates per positive damage instance and transforms only at its next turn start', () => {
    const ulquiorra = makePiece({
      instanceId: 'ulquiorra', templateId: 'dark-ulquiorra', ownerPlayerId: 'player-red',
      x: 0, y: 0, currentHp: 6, maxHp: 12, attack: 4, moveRange: 3,
    }) as any
    ulquiorra.name = '乌尔奇奥拉·西法'
    ulquiorra.rules = [
      rule('rule-ulquiorra-damage-dealt'),
      rule('rule-ulquiorra-damage-taken'),
      rule('rule-ulquiorra-resurreccion'),
    ]
    ulquiorra.skills = [
      { skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 },
    ]
    const enemy = makePiece({
      instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 1, y: 0, currentHp: 30, maxHp: 30,
    }) as any
    const state = makeState({ pieces: [ulquiorra, enemy] }) as any

    withRuleRuntime(new RuleRuntime({ rootSeed: 163, tick: 1 }), () => {
      dealDamage(ulquiorra, enemy, 1, 'true', state, 'hit-1')
      dealDamage(enemy, ulquiorra, 1, 'true', state, 'hit-2')
      dealDamage(ulquiorra, enemy, 1, 'true', state, 'hit-3')
    })

    expect(ulquiorra.currentHp).toBe(11)
    expect(ulquiorra.statusTags).toContainEqual(expect.objectContaining({
      type: 'ulquiorra-resurreccion-progress', intensity: 3,
    }))
    expect(ulquiorra.attack).toBe(4)
    expect(ulquiorra.skills).not.toContainEqual(expect.objectContaining({ skillId: 'ulquiorra-black-cero' }))

    globalTriggerSystem.checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' })
    expect(ulquiorra).toMatchObject({ attack: 5, moveRange: 4, currentHp: 11, maxHp: 12 })
    expect(ulquiorra.skills).toContainEqual(expect.objectContaining({ skillId: 'ulquiorra-black-cero' }))
    expect(ulquiorra.statusTags).toContainEqual(expect.objectContaining({
      type: 'resurreccion', name: '归刃',
    }))

    ulquiorra.currentHp = 5
    withRuleRuntime(new RuleRuntime({ rootSeed: 163, tick: 2 }), () => {
      dealDamage(ulquiorra, ulquiorra, 1, 'true', state, 'self-hit')
    })
    expect(ulquiorra.currentHp).toBe(6)
  })

  it('emits the first death lifecycle then revives Grimmjow once before terminal settlement', () => {
    const grimmjow = makePiece({
      instanceId: 'grimmjow', templateId: 'dark-grimmjow', ownerPlayerId: 'player-red',
      x: 1, y: 1, currentHp: 5, maxHp: 5, attack: 4, moveRange: 4,
    }) as any
    grimmjow.name = '葛力姆乔·贾卡杰克'
    grimmjow.rules = [rule('rule-grimmjow-resurreccion')]
    grimmjow.skills = [
      { skillId: 'grimmjow-gran-rey-cero', currentCooldown: 0, usesRemaining: -1 },
    ]
    expect(grimmjow.skills).not.toContainEqual(expect.objectContaining({ skillId: 'grimmjow-panther-claw' }))
    const enemy = makePiece({
      instanceId: 'killer', ownerPlayerId: 'player-blue', x: 2, y: 1, currentHp: 20, maxHp: 20,
    }) as any
    const state = makeState({ pieces: [grimmjow, enemy] }) as any

    withRuleRuntime(new RuleRuntime({ rootSeed: 164, tick: 1 }), () => {
      const first = dealDamage(enemy, grimmjow, 5, 'true', state, 'first-death')
      expect(first).toMatchObject({ isKilled: false, targetHp: 10 })
      expect(grimmjow).toMatchObject({ currentHp: 10, maxHp: 10, attack: 5, moveRange: 5 })
      expect(grimmjow.skills).toContainEqual(expect.objectContaining({ skillId: 'grimmjow-panther-claw' }))
      expect(grimmjow.skills).not.toContainEqual(expect.objectContaining({ skillId: 'grimmjow-gran-rey-cero' }))
      expect(grimmjow.statusTags).toContainEqual(expect.objectContaining({
        type: 'resurreccion', name: '归刃',
      }))
      expect(state.players[1].chargePoints).toBe(1)

      const second = dealDamage(enemy, grimmjow, 10, 'true', state, 'second-death')
      expect(second.isKilled).toBe(true)
    })
    expect(state.pieces.map((piece: any) => piece.instanceId)).not.toContain('grimmjow')
    expect(state.graveyard.map((piece: any) => piece.instanceId)).toContain('grimmjow')
  })

  it('resumes Kyoka Suigetsu pending selection against the replacement exactly once', () => {
    const aizen = makePiece({
      instanceId: 'aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 1, y: 1,
      currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.name = '蓝染惣右介'
    aizen.rules = [rule('rule-aizen-kyoka-rewrite'), rule('rule-aizen-kyoka-expire')]
    const original = makePiece({
      instanceId: 'secret-ally', ownerPlayerId: 'player-red', x: 2, y: 1, currentHp: 10, maxHp: 10,
    }) as any
    const replacement = makePiece({
      instanceId: 'replacement-enemy', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 1, y: 2, currentHp: 10, maxHp: 10,
    }) as any
    const enemy = makePiece({
      instanceId: 'enemy-caster', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 1,
      currentHp: 10, maxHp: 10,
    }) as any
    enemy.attack = 4
    enemy.skills = [{ skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [aizen, original, replacement, enemy], currentPlayerId: 'player-blue' }) as any
    state.players[1].actionPoints = 2
    state.skillsById['ulquiorra-cero'] = loadAllSkillsById()['ulquiorra-cero']
    aizen.statusTags = [
      { id: 'kyoka-public', type: 'aizen-kyoka-active', visible: false },
      { id: 'kyoka-secret', type: 'aizen-kyoka-secret', visible: false, targetPieceId: original.instanceId, opponentPlayerId: enemy.ownerPlayerId },
    ]

    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: enemy.instanceId, skillId: 'ulquiorra-cero',
    }, original.instanceId)
    const pending = runBattleAction(state, action, { rootSeed: 165 }).state as any
    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red' })
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: replacement.instanceId },
    ])
    expect(pending.players[1].actionPoints).toBe(2)

    const resolved = runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: replacement.instanceId,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any, { rootSeed: 165 }).state as any
    expect(resolved.actions.filter((entry: any) => entry.type === 'useBasicSkill' && entry.payload?.skillId === 'ulquiorra-cero')).toHaveLength(1)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId).currentHp).toBe(7)
    expect(resolved.players[1].actionPoints).toBe(1)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === aizen.instanceId).statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'aizen-kyoka-secret' }))
  })

  it('allows Kyoka Suigetsu to redirect the skill back to its caster', () => {
    const aizen = makePiece({
      instanceId: 'self-rewrite-aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red',
      x: 1, y: 1, currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.rules = [rule('rule-aizen-kyoka-rewrite'), rule('rule-aizen-kyoka-expire')]
    aizen.statusTags = [
      { id: 'self-rewrite-public', type: 'aizen-kyoka-active', visible: false },
      {
        id: 'self-rewrite-secret', type: 'aizen-kyoka-secret', visible: false,
        targetPieceId: 'self-rewrite-ally', opponentPlayerId: 'player-blue',
      },
    ]
    const original = makePiece({
      instanceId: 'self-rewrite-ally', ownerPlayerId: 'player-red', x: 2, y: 1,
      currentHp: 10, maxHp: 10,
    }) as any
    const enemyCaster = makePiece({
      instanceId: 'self-rewrite-caster', ownerPlayerId: 'player-blue', faction: 'blue',
      x: 3, y: 1, currentHp: 10, maxHp: 10, attack: 4,
    }) as any
    enemyCaster.skills = [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [aizen, original, enemyCaster], currentPlayerId: 'player-blue' }) as any
    state.players[1].actionPoints = 2
    state.skillsById.fireball = json('data/skills/fireball.json')

    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: enemyCaster.instanceId,
      skillId: 'fireball',
    }, original.instanceId)
    const pending = runBattleAction(state, action, { rootSeed: 172 }).state as any
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: enemyCaster.instanceId },
    ])

    const resolved = runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: enemyCaster.instanceId,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any, { rootSeed: 172 }).state as any
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === enemyCaster.instanceId).currentHp).toBe(4)
    expect(resolved.players[1].actionPoints).toBe(1)
  })

  it('ships Kyoka Suigetsu target rewriting in the tracked browser engine', () => {
    const browserEngine = loadBrowserEngine()
    browserEngine.globalTriggerSystem.clearRules()
    const aizen = makePiece({
      instanceId: 'browser-aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 1, y: 1,
      currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.rules = [
      browserEngine.loadRuleById('rule-aizen-kyoka-rewrite', true),
      browserEngine.loadRuleById('rule-aizen-kyoka-expire', true),
    ]
    aizen.skills = [{ skillId: 'aizen-kyoka-suiguetsu', currentCooldown: 0, usesRemaining: -1 }]
    const original = makePiece({
      instanceId: 'browser-secret', ownerPlayerId: 'player-red', x: 2, y: 1,
      currentHp: 10, maxHp: 10,
    }) as any
    const replacement = makePiece({
      instanceId: 'browser-replacement', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 2,
      currentHp: 10, maxHp: 10,
    }) as any
    const enemy = makePiece({
      instanceId: 'browser-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 1,
      currentHp: 10, maxHp: 10, attack: 4,
    }) as any
    enemy.skills = [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({
      pieces: [aizen, original, replacement, enemy], currentPlayerId: 'player-red',
    }) as any
    state.players[0].actionPoints = 2
    state.skillsById['aizen-kyoka-suiguetsu'] = json('data/skills/aizen-kyoka-suiguetsu.json')
    state.skillsById.fireball = json('data/skills/fireball.json')

    const kyokaAction = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: aizen.instanceId,
      skillId: 'aizen-kyoka-suiguetsu',
    }, original.instanceId)
    const armed = browserEngine.runBattleAction(state, kyokaAction, { rootSeed: 171 }).state as any
    const enemyTurnStart = browserEngine.runBattleAction(armed, {
      type: 'endTurn', playerId: 'player-red',
    } as any, { rootSeed: 171 }).state as any
    expect(enemyTurnStart.pieces.find((piece: any) => piece.instanceId === aizen.instanceId).statusTags)
      .toContainEqual(expect.objectContaining({
        type: 'aizen-kyoka-secret', targetPieceId: original.instanceId,
      }))
    const enemyTurn = browserEngine.runBattleAction(enemyTurnStart, {
      type: 'beginPhase',
    } as any, { rootSeed: 171 }).state as any
    enemyTurn.skillsById = state.skillsById

    const action = selectedAction(enemyTurn, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: enemy.instanceId,
      skillId: 'fireball',
    }, original.instanceId)
    const enemyApBefore = enemyTurn.players[1].actionPoints
    const pending = browserEngine.runBattleAction(enemyTurn, action, { rootSeed: 171 }).state as any

    expect(pending.pendingTargetSelection).toMatchObject({ playerId: 'player-red' })
    expect(pending.pendingTargetSelection.candidates).toEqual([
      { type: 'piece', pieceId: replacement.instanceId },
    ])
    expect(pending.players[1].actionPoints).toBe(enemyApBefore)
    expect(pending.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    const resolved = browserEngine.runBattleAction(pending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetPieceId: replacement.instanceId,
      selectionId: pending.pendingTargetSelection.selectionId,
      stateRevision: pending.pendingTargetSelection.stateRevision,
    } as any, { rootSeed: 171 }).state as any
    expect(resolved.pieces.find((piece: any) => piece.instanceId === original.instanceId).currentHp).toBe(10)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === replacement.instanceId).currentHp).toBe(4)
    expect(resolved.players[1].actionPoints).toBe(enemyApBefore - 1)
    browserEngine.globalTriggerSystem.clearRules()
  })

  it('casts Kyoka Suigetsu for one AP and records its secret target', () => {
    const aizen = makePiece({
      instanceId: 'kyoka-caster', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 1, y: 1,
      currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.skills = [{ skillId: 'aizen-kyoka-suiguetsu', currentCooldown: 0, usesRemaining: -1 }]
    const ally = makePiece({
      instanceId: 'kyoka-ally', ownerPlayerId: 'player-red', x: 2, y: 1,
    }) as any
    ally.name = '镜花水月秘密目标'
    const enemy = makePiece({
      instanceId: 'kyoka-opponent', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 1,
    }) as any
    const state = makeState({ pieces: [aizen, ally, enemy] }) as any
    state.players[0].actionPoints = 2
    state.skillsById['aizen-kyoka-suiguetsu'] = loadAllSkillsById()['aizen-kyoka-suiguetsu']
    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: aizen.instanceId, skillId: 'aizen-kyoka-suiguetsu',
    }, ally.instanceId)

    const resolved = runBattleAction(state, action, { rootSeed: 170 }).state as any
    expect(resolved.players[0].actionPoints).toBe(1)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === aizen.instanceId).statusTags)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'aizen-kyoka-active', visible: false }),
        expect.objectContaining({ type: 'aizen-kyoka-secret', visible: false, targetPieceId: ally.instanceId }),
      ]))
    const publicSkillLog = resolved.actions.find((entry: any) => (
      entry.type === 'useBasicSkill' && entry.payload?.skillId === 'aizen-kyoka-suiguetsu'
    ))?.payload?.message
    expect(publicSkillLog).toContain('镜花水月')
    expect(publicSkillLog).not.toContain(ally.name)
    expect(publicSkillLog).not.toContain(ally.instanceId)
  })

  it('lets the original skill resolve when Kyoka Suigetsu has no legal replacement, then expires at turn end', () => {
    const aizen = makePiece({
      instanceId: 'isolated-aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 0, y: 0,
      currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.rules = [rule('rule-aizen-kyoka-rewrite'), rule('rule-aizen-kyoka-expire')]
    const secret = makePiece({
      instanceId: 'isolated-secret', ownerPlayerId: 'player-red', x: 4, y: 0, currentHp: 10, maxHp: 10,
    }) as any
    const enemy = makePiece({
      instanceId: 'isolated-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 7, y: 0,
      currentHp: 10, maxHp: 10, attack: 4,
    }) as any
    enemy.skills = [{ skillId: 'ulquiorra-cero', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [aizen, secret, enemy], currentPlayerId: 'player-blue', width: 10 }) as any
    state.players[1].actionPoints = 2
    state.skillsById['ulquiorra-cero'] = loadAllSkillsById()['ulquiorra-cero']
    aizen.statusTags = [
      { id: 'kyoka-public', type: 'aizen-kyoka-active', visible: false },
      { id: 'kyoka-secret', type: 'aizen-kyoka-secret', visible: false, targetPieceId: secret.instanceId, opponentPlayerId: enemy.ownerPlayerId },
    ]

    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: enemy.instanceId, skillId: 'ulquiorra-cero',
    }, secret.instanceId)
    const resolved = runBattleAction(state, action, { rootSeed: 167 }).state as any
    expect(resolved.pendingTargetSelection).toBeUndefined()
    expect(resolved.pieces.find((piece: any) => piece.instanceId === secret.instanceId).currentHp).toBe(7)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === aizen.instanceId).statusTags)
      .toContainEqual(expect.objectContaining({ type: 'aizen-kyoka-secret' }))

    withRuleRuntime(new RuleRuntime({ rootSeed: 167, tick: 2 }), () => {
      globalTriggerSystem.checkTriggers(resolved, { type: 'endTurn', playerId: 'player-blue' })
    })
    expect(resolved.pieces.find((piece: any) => piece.instanceId === aizen.instanceId).statusTags)
      .not.toContainEqual(expect.objectContaining({ type: 'aizen-kyoka-secret' }))
  })

  it('settles Black Coffin twice and blocks the imprisoned piece movement', () => {
    const aizen = makePiece({
      instanceId: 'coffin-aizen', templateId: 'dark-aizen', ownerPlayerId: 'player-red', x: 0, y: 0,
      currentHp: 9, maxHp: 9, attack: 4,
    }) as any
    aizen.skills = [{ skillId: 'aizen-black-coffin', currentCooldown: 0, usesRemaining: -1 }]
    const enemy = makePiece({
      instanceId: 'coffin-target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 20, maxHp: 20, attack: 3, moveRange: 4,
    }) as any
    const state = makeState({ pieces: [aizen, enemy], currentPlayerId: 'player-red' }) as any
    state.players[0].actionPoints = 2
    state.players[0].chargePoints = 2
    state.skillsById['aizen-black-coffin'] = loadAllSkillsById()['aizen-black-coffin']
    const action = selectedAction(state, {
      type: 'useChargeSkill', playerId: 'player-red', pieceId: aizen.instanceId, skillId: 'aizen-black-coffin',
    }, enemy.instanceId)

    const cast = runBattleAction(state, action, { rootSeed: 168 }).state as any
    expect(cast.pieces.find((piece: any) => piece.instanceId === enemy.instanceId)).toMatchObject({ currentHp: 14, x: 2, y: 0 })
    expect(cast.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).statusTags)
      .toContainEqual(expect.objectContaining({ type: 'imprisoned', name: '禁锢', blocksForcedMovement: true }))
    expect(cast.players[0]).toMatchObject({ actionPoints: 0, chargePoints: 0 })

    cast.turn.currentPlayerId = 'player-blue'
    cast.players[1].actionPoints = 2
    const blockedMove = runBattleAction(cast, {
      type: 'move', playerId: 'player-blue', pieceId: enemy.instanceId, toX: 3, toY: 0,
    }, { rootSeed: 168 }).state as any
    expect(blockedMove.pieces.find((piece: any) => piece.instanceId === enemy.instanceId)).toMatchObject({ currentHp: 14, x: 2, y: 0 })
    expect(blockedMove.players[1].actionPoints).toBe(2)

    withRuleRuntime(new RuleRuntime({ rootSeed: 168, tick: 3 }), () => {
      globalTriggerSystem.checkTriggers(blockedMove, { type: 'endTurn', playerId: 'player-blue' })
    })
    expect(blockedMove.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBe(8)
    expect(blockedMove.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).statusTags)
      .not.toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^aizen-black-coffin-/) }))
  })

  it('rejects skill movement of a piece imprisoned by Black Coffin without changing state', () => {
    const prisoner = makePiece({
      instanceId: 'coffin-prisoner', ownerPlayerId: 'player-red', x: 2, y: 1,
      statusTags: [{ id: 'coffin-lock', type: 'imprisoned', name: '禁锢', blocksForcedMovement: true }],
    }) as any
    const mover = makePiece({
      instanceId: 'coffin-forcer', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1,
    }) as any
    mover.skills = [{ skillId: 'venom-host-transfer', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [prisoner, mover], currentPlayerId: 'player-blue' }) as any
    state.skillsById['venom-host-transfer'] = loadAllSkillsById()['venom-host-transfer']
    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-blue', pieceId: mover.instanceId, skillId: 'venom-host-transfer',
    }, prisoner.instanceId)
    const before = JSON.stringify(state)

    expect(() => runBattleAction(state, action, { rootSeed: 171 })).toThrow(/cannot be moved by a skill/)
    expect(JSON.stringify(state)).toBe(before)
  })

  it('does not settle an imprisoned status created by another source as Black Coffin damage', () => {
    const prisoner = makePiece({
      instanceId: 'other-prisoner', ownerPlayerId: 'player-blue', currentHp: 10, maxHp: 10,
      statusTags: [{
        id: 'future-imprisoned-source', type: 'imprisoned', name: '禁锢', sourceId: 'future-caster',
        delayedDamage: 99, blocksForcedMovement: true,
      }],
    })
    prisoner.rules = [rule('rule-aizen-black-coffin-end'), rule('rule-aizen-black-coffin-move')]
    const state = makeState({ pieces: [prisoner], currentPlayerId: 'player-blue' })

    withRuleRuntime(new RuleRuntime({ rootSeed: 173, tick: 1 }), () => {
      globalTriggerSystem.checkTriggers(state, { type: 'endTurn', playerId: 'player-blue' })
    })

    expect(prisoner.currentHp).toBe(10)
    expect(prisoner.statusTags).toContainEqual(expect.objectContaining({ id: 'future-imprisoned-source' }))
    expect(prisoner.rules).not.toContainEqual(expect.objectContaining({ id: 'rule-aizen-black-coffin-end' }))
  })

  it('allows Hunting Instinct to trigger repeatedly in the same turn', () => {
    const grimmjow = makePiece({
      instanceId: 'hunt-grimmjow', templateId: 'dark-grimmjow', ownerPlayerId: 'player-red', x: 0, y: 1,
      currentHp: 10, maxHp: 10, attack: 4, moveRange: 4,
    }) as any
    grimmjow.rules = [rule('rule-grimmjow-hunt-after-move'), rule('rule-grimmjow-hunt-after-skill')]
    const enemy = makePiece({
      instanceId: 'hunt-enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1,
      currentHp: 20, maxHp: 20, attack: 4, moveRange: 3,
    }) as any
    const secondEnemy = makePiece({
      instanceId: 'hunt-enemy-two', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 2,
      currentHp: 20, maxHp: 20, attack: 4, moveRange: 3,
    }) as any
    const state = makeState({ pieces: [grimmjow, enemy, secondEnemy], currentPlayerId: 'player-blue', width: 6, height: 4 }) as any
    state.players[1].actionPoints = 3

    const firstPending = runBattleAction(state, {
      type: 'move', playerId: 'player-blue', pieceId: enemy.instanceId, toX: 2, toY: 1,
    }, { rootSeed: 169 }).state as any
    expect(firstPending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', canCancel: true })
    const first = firstPending.pendingTargetSelection
    const firstResolved = runBattleAction(firstPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 1, targetY: 1,
      selectionId: first.selectionId, stateRevision: first.stateRevision,
    } as any, { rootSeed: 169 }).state as any
    expect(firstResolved.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBe(14)
    expect(firstResolved.pieces.find((piece: any) => piece.instanceId === grimmjow.instanceId)).toMatchObject({ currentHp: 8, x: 1, y: 1 })

    const secondPending = runBattleAction(firstResolved, {
      type: 'move', playerId: 'player-blue', pieceId: secondEnemy.instanceId, toX: 3, toY: 2,
    }, { rootSeed: 169 }).state as any
    expect(secondPending.pendingTargetSelection).toMatchObject({ playerId: 'player-red', canCancel: true })
    const second = secondPending.pendingTargetSelection
    const secondResolved = runBattleAction(secondPending, {
      type: 'pendingTargetSelect', playerId: 'player-red', targetX: 2, targetY: 2,
      selectionId: second.selectionId, stateRevision: second.stateRevision,
    } as any, { rootSeed: 169 }).state as any
    expect(secondResolved.pieces.find((piece: any) => piece.instanceId === secondEnemy.instanceId).currentHp).toBe(14)
    expect(secondResolved.pieces.find((piece: any) => piece.instanceId === grimmjow.instanceId)).toMatchObject({ currentHp: 6, x: 2, y: 2 })
  })

  it('settles Panther Claw as five independent hits and five self-damage instances', () => {
    const grimmjow = makePiece({
      instanceId: 'panther', templateId: 'dark-grimmjow', ownerPlayerId: 'player-red', x: 0, y: 0,
      currentHp: 10, maxHp: 10, attack: 5, moveRange: 5,
      statusTags: [{ id: 'panther-form', type: 'resurreccion', name: '归刃', visible: true }],
    }) as any
    const enemy = makePiece({
      instanceId: 'panther-target', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 0,
      currentHp: 30, maxHp: 30, attack: 4,
    }) as any
    grimmjow.skills = [{ skillId: 'grimmjow-panther-claw', currentCooldown: 0, usesRemaining: -1 }]
    const state = makeState({ pieces: [grimmjow, enemy] }) as any
    state.skillsById['grimmjow-panther-claw'] = loadAllSkillsById()['grimmjow-panther-claw']
    state.players[0].actionPoints = 2
    const action = selectedAction(state, {
      type: 'useBasicSkill', playerId: 'player-red', pieceId: grimmjow.instanceId,
      skillId: 'grimmjow-panther-claw',
    }, enemy.instanceId)

    const resolved = runBattleAction(state, action, { rootSeed: 166 }).state as any
    expect(resolved.pieces.find((piece: any) => piece.instanceId === enemy.instanceId).currentHp).toBe(15)
    expect(resolved.pieces.find((piece: any) => piece.instanceId === grimmjow.instanceId).currentHp).toBe(5)
    expect(resolved.actions.filter((entry: any) => entry.type === 'damage' && entry.payload?.skillId === 'grimmjow-panther-claw')).toHaveLength(5)
    expect(resolved.actions.filter((entry: any) => entry.type === 'damage' && entry.payload?.skillId === 'grimmjow-destruction-instinct')).toHaveLength(5)
  })
})
