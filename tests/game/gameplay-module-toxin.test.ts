/* eslint-disable @typescript-eslint/no-explicit-any -- frozen host fixtures retain legacy JSON-shaped state. */
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyGameplayModuleGraph,
  assertGameplayModuleDocument,
  compileGameplayModuleGraph,
} from '@/lib/skill-graph/module-document'
import { GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-registry'
import {
  buildToxinRuleGraph,
  buildToxinSkillGraph,
} from '@/scripts/migrate-semantic-toxin'
import { migrateAtomicAuthorGraph } from '@/scripts/migrate-atomic-author-modules'
import {
  executeSkillFunction,
  loadAllSkillsById,
  loadRuleById,
  type SkillDefinition,
} from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { runBattleAction } from '@/lib/game/battle-runner'
import { globalTriggerSystem, TriggerSystem } from '@/lib/game/triggers'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { recordBattlePresentation, recordedBattlePresentation } from '@/lib/game/battle-presentation-recording'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, any>
const productionSkill = JSON.parse(readFileSync('data/skills/blackwidow-lethal-toxin.json', 'utf8')) as SkillDefinition & { gameplayModules: any }
const productionRule = JSON.parse(readFileSync('data/rules/rule-blackwidow-toxin-player.json', 'utf8')) as Record<string, any>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function comparableState(state: any): any {
  const value = clone(state)
  delete value.skillsById
  return value
}

function skillState(targetPosition: { x: number; y: number } | null, setup?: (state: any, caster: any) => void): { battle: any; caster: any } {
  const caster = makePiece({
    instanceId: 'widow',
    templateId: 'red-blackwidow',
    name: '黑寡妇',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 1,
    y: 1,
  }) as any
  caster.name = '黑寡妇'
  const battle = makeState({ pieces: [caster], width: 8, height: 8 }) as any
  battle.skillsById[productionSkill.id] = productionSkill
  battle.players[0].actionPoints = 3
  setup?.(battle, caster)
  return { battle, caster }
}

function runSkill(definition: SkillDefinition, targetPosition: { x: number; y: number } | null, setup?: (state: any, caster: any) => void): any {
  const { battle, caster } = skillState(targetPosition, setup)
  const runtime = new RuleRuntime({ rootSeed: 594 })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(594000000000)
  try {
    const result = withRuleRuntime(runtime, () => recordBattlePresentation(
      battle,
      () => executeSkillFunction(definition, {
        piece: caster,
        playerId: caster.ownerPlayerId,
        battle,
        skill: definition,
        target: null,
        targetPosition,
        targets: [],
      } as any, battle),
      () => battle,
    ))
    return {
      result: clone(result),
      state: comparableState(battle),
      presentation: clone(recordedBattlePresentation(battle)),
      random: runtime.snapshot(),
    }
  } finally {
    clock.mockRestore()
  }
}

function ruleFixture(options: {
  sourceAlive?: boolean
  moverHp?: number
  toxins?: Array<{ id: string; x: number; y: number; intensity?: number; sourceId?: string }>
} = {}): { state: any; mover: any; caster: any } {
  const caster = asPieceInstance(makePiece({
    instanceId: 'widow',
    templateId: 'red-blackwidow',
    name: '黑寡妇',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 2,
    y: 1,
    currentHp: options.sourceAlive === false ? 0 : 10,
  }))
  const mover = asPieceInstance(makePiece({
    instanceId: 'mover',
    templateId: 'blue-footman',
    name: '敌军',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: options.toxins?.[0]?.x ?? 1,
    y: options.toxins?.[0]?.y ?? 0,
    currentHp: options.moverHp ?? 10,
    maxHp: Math.max(10, options.moverHp ?? 10),
  }))
  const state = makeState({ pieces: [mover, ...(options.sourceAlive === false ? [] : [caster])], width: 8, height: 8 }) as any
  if (options.sourceAlive === false) state.graveyard = [caster]
  const toxins: Array<{ id: string; x: number; y: number; intensity?: number; sourceId?: string }> = options.toxins ?? [{ id: 'trap', x: Number(mover.x ?? 0), y: Number(mover.y ?? 0) }]
  state.players[0].statusTags = toxins.map(toxin => ({
    id: toxin.id,
    type: 'lethal-toxin',
    name: '致命毒素',
    currentDuration: -1,
    intensity: toxin.intensity ?? 4,
    value: toxin.x,
    extraValue: toxin.y,
    sourceId: toxin.sourceId ?? 'widow',
  }))
  state.players[0].rules = [loadRuleById('rule-blackwidow-toxin-player', true)]
  state.extensions = {
    tileEffects: toxins.map(toxin => ({
      id: toxin.id,
      sourceId: toxin.id,
      tileType: 'lethal-toxin',
      x: toxin.x,
      y: toxin.y,
      ownerPlayerId: 'player-red',
    })),
  }
  return { state, mover, caster }
}

function triggerToxin(state: any, mover: any): any {
  return new TriggerSystem().checkTriggers(state, {
    type: 'afterPiecePositionChange',
    playerId: 'player-blue',
    sourcePiece: mover,
  })
}

function pendingState(): any {
  const caster = makePiece({
    instanceId: 'widow',
    templateId: 'red-blackwidow',
    name: '黑寡妇',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 1,
    y: 1,
    skills: [{ skillId: 'blackwidow-lethal-toxin', currentCooldown: 0, usesRemaining: -1 }],
  }) as any
  caster.name = '黑寡妇'
  const state = makeState({ pieces: [caster], currentPlayerId: 'player-red', width: 8, height: 8 }) as any
  state.skillsById = loadAllSkillsById()
  state.players[0].actionPoints = 3
  return state
}

describe('Black Widow lethal toxin gameplay modules', () => {
  afterEach(() => {
    globalTriggerSystem.clearRules()
    vi.restoreAllMocks()
  })

  it('registers both closed graphs and synchronizes the production source', () => {
    const skillGraph = migrateAtomicAuthorGraph(buildToxinSkillGraph())
    const ruleGraph = migrateAtomicAuthorGraph(buildToxinRuleGraph())
    expect(compileGameplayModuleGraph(skillGraph, GAMEPLAY_MODULE_REGISTRY).code).toContain('function executeSkill')
    expect(compileGameplayModuleGraph(ruleGraph, GAMEPLAY_MODULE_REGISTRY).code.length).toBeGreaterThan(0)
    expect(skillGraph.body.filter(statement => statement.kind === 'call').map(statement => statement.module)).toEqual(expect.arrayContaining([
      'choice.target-cell', 'spatial.cell-walkable-safe', 'spatial.cell-unoccupied',
      'status.apply-player-record', 'rule.apply-player', 'tile.add-source-effect', 'effect.displace-one',
    ]))
    // Delayed damage now uses its captured player directly. It must not
    // reintroduce the retired living-caster/player-fallback composite.
    expect(JSON.stringify(ruleGraph)).toContain('"module":"effect.damage"')
    expect(JSON.stringify(ruleGraph)).not.toContain('"module":"effect.damage-with-player-fallback"')
    expect(JSON.stringify(skillGraph)).not.toContain('executeSkill')
    expect(JSON.stringify(ruleGraph)).not.toContain('executeSkill')
    assertGameplayModuleDocument(productionSkill)
    assertGameplayModuleDocument(productionRule)
    // Incremental migration can preserve different internal node ids than a
    // rebuilt legacy factory. Validate the exact shipped graph and its source;
    // behavior below still compares every observable placement channel.
    const shippedSkill = productionSkill.gameplayModules.entries.code.graph
    const shippedRule = productionRule.gameplayModules.entries.skillCode.graph
    expect(migrateAtomicAuthorGraph(shippedSkill)).toEqual(shippedSkill)
    expect(migrateAtomicAuthorGraph(shippedRule)).toEqual(shippedRule)
    expect(productionSkill.code).toBe(applyGameplayModuleGraph(fixture['skills/blackwidow-lethal-toxin'], shippedSkill).code)
    expect(productionRule.skillCode).toBe(applyGameplayModuleGraph(fixture['rules/rule-blackwidow-toxin-player'], shippedRule, 'skillCode').skillCode)
  })

  it('preserves successful placement state, presentation and fixed-seed channels', () => {
    const legacy = runSkill(fixture['skills/blackwidow-lethal-toxin'], { x: 2, y: 1 })
    const semantic = runSkill(productionSkill, { x: 2, y: 1 })
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '黑寡妇放置致命毒素并移动到(2,1)' })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'widow')).toMatchObject({ x: 2, y: 1 })
    const toxinId = semantic.state.players[0].statusTags[0].id
    expect(toxinId).toMatch(/^lethal-toxin-/)
    expect(semantic.state.players[0].statusTags).toContainEqual(expect.objectContaining({
      id: toxinId, type: 'lethal-toxin', value: 1, extraValue: 1, sourceId: 'widow', intensity: 4,
    }))
    expect(semantic.state.players[0].rules).toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(semantic.state.extensions.tileEffects).toContainEqual(expect.objectContaining({
      id: toxinId, sourceId: toxinId, tileType: 'lethal-toxin', x: 1, y: 1,
    }))
    expect(semantic.state.actions).toContainEqual(expect.objectContaining({ type: 'positionChanged' }))
  })

  it.each([
    ['occupied', { x: 2, y: 1 }, (state: any) => {
      state.pieces.push(makePiece({ instanceId: 'occupant', ownerPlayerId: 'player-blue', faction: 'blue', x: 2, y: 1 }))
    }],
    ['unwalkable', { x: 2, y: 1 }, (state: any) => {
      state.map.tiles.find((tile: any) => tile.x === 2 && tile.y === 1).props.walkable = false
    }],
  ] as const)('rejects %s target before creating toxin state', (_name, target, setup) => {
    const legacy = runSkill(fixture['skills/blackwidow-lethal-toxin'], target, setup)
    const semantic = runSkill(productionSkill, target, setup)
    expect(semantic).toEqual(legacy)
    expect(semantic.result.success).toBe(false)
    expect(semantic.state.players[0].statusTags).toBeUndefined()
    expect(semantic.state.players[0].rules).toEqual([])
    expect(semantic.state.extensions?.tileEffects).toBeUndefined()
  })

  it('retains placed toxin state when the authoritative displacement is blocked', () => {
    const block = { id: 'test-displacement-block', name: '阻挡', description: '', trigger: { type: 'beforePiecePositionChange' as const }, effect: () => ({ success: true, blocked: true, message: '测试阻挡' }) }
    globalTriggerSystem.addRule(block)
    const legacy = runSkill(fixture['skills/blackwidow-lethal-toxin'], { x: 2, y: 1 })
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRule(block)
    const semantic = runSkill(productionSkill, { x: 2, y: 1 })
    expect(semantic).toEqual(legacy)
    expect(semantic.result).toEqual({ success: true, message: '位移被阻挡，本次位移效果取消' })
    expect(semantic.state.pieces.find((piece: any) => piece.instanceId === 'widow')).toMatchObject({ x: 1, y: 1 })
    expect(semantic.state.players[0].statusTags).toHaveLength(1)
    expect(semantic.state.players[0].rules).toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(semantic.state.extensions.tileEffects).toHaveLength(1)
  })

  it('exposes the real target-selection protocol and cancellation without side effects', () => {
    const state = pendingState()
    const draft: any = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'widow', skillId: 'blackwidow-lethal-toxin' }
    const pending = prepareAction(state, draft)
    expect(pending).toMatchObject({ kind: 'needTarget', targetType: 'cell', range: 5, filter: 'all', canCancel: true })
    if (pending.kind !== 'needTarget') throw new Error('expected toxin target selection')
    state.players[0].statusTags = []
    state.pendingTargetSelection = finalizePendingTargetSession(state, {
      playerId: 'player-red', ownerPlayerId: 'player-red',
      source: { type: 'skill', id: draft.skillId, pieceId: draft.pieceId },
      targetType: 'cell', filter: 'all', range: 5,
      steps: [{ type: 'cell', filter: 'all', range: 5 }],
    } as any, 0)
    const session = state.pendingTargetSelection!
    const cancelled = runBattleAction(state, {
      type: 'cancelPendingSelection', playerId: 'player-red', selectionId: session.selectionId, stateRevision: session.stateRevision,
    } as any, { rootSeed: 594 })
    expect(cancelled.state.pendingTargetSelection).toBeUndefined()
    expect(cancelled.state.pieces.find((piece: any) => piece.instanceId === 'widow')).toMatchObject({ x: 1, y: 1 })
    expect(cancelled.state.players[0].actionPoints).toBe(3)
    expect(cancelled.state.players[0].statusTags).toEqual([])
    expect(cancelled.state.players[0].rules).toEqual([])
  })

  it('resolves a real host target selection with the same state and log shape', () => {
    const state = pendingState()
    const draft: any = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'widow', skillId: 'blackwidow-lethal-toxin' }
    const pending = prepareAction(state, draft)
    if (pending.kind !== 'needTarget') throw new Error('expected toxin target selection')
    const result = runBattleAction(state, {
      ...draft, targetX: 2, targetY: 1, selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    } as any, { rootSeed: 594 })
    expect(result.state.pendingTargetSelection).toBeUndefined()
    expect(result.state.pieces.find((piece: any) => piece.instanceId === 'widow')).toMatchObject({ x: 2, y: 1 })
    expect(result.state.players[0].actionPoints).toBe(2)
    expect(result.state.players[0].statusTags).toContainEqual(expect.objectContaining({ type: 'lethal-toxin', value: 1, extraValue: 1 }))
    expect(result.state.actions?.at(-1)?.payload).toMatchObject({ message: '黑寡妇使用了致命毒素，目标位置是(2, 1)，黑寡妇放置致命毒素并移动到(2,1)' })
  })

  it('triggers true damage, consumes only the matching toxin, and removes the rule last', () => {
    const { state, mover } = ruleFixture({ toxins: [
      { id: 'trap-a', x: 1, y: 0 },
      { id: 'trap-b', x: 3, y: 0 },
    ] })
    const first = withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => triggerToxin(state, mover))
    expect(first.success).toBe(true)
    expect(mover.currentHp).toBe(6)
    expect(state.players[0].statusTags).toEqual([expect.objectContaining({ id: 'trap-b', value: 3, extraValue: 0 })])
    expect(state.players[0].rules).toContainEqual(expect.objectContaining({ id: 'rule-blackwidow-toxin-player' }))
    expect(state.extensions.tileEffects).toEqual([expect.objectContaining({ sourceId: 'trap-b', x: 3, y: 0 })])
    expect(state.actions).toContainEqual(expect.objectContaining({ type: 'damage', payload: expect.objectContaining({ damageType: 'true', sourceId: 'player-red', damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' }, targetId: 'mover', finalDamage: 4 }) }))
    mover.x = 3
    const second = withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => triggerToxin(state, mover))
    expect(second.success).toBe(true)
    expect(mover.currentHp).toBe(2)
    expect(state.players[0].statusTags).toEqual([])
    expect(state.players[0].rules).toEqual([])
    expect(state.extensions.tileEffects).toEqual([])
  })

  it('uses the owner player as source after the caster leaves and preserves lethal cleanup', () => {
    const { state, mover } = ruleFixture({ sourceAlive: false, moverHp: 4 })
    withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => triggerToxin(state, mover))
    expect(mover.currentHp).toBe(0)
    expect(state.graveyard).toContainEqual(expect.objectContaining({ instanceId: 'mover' }))
    expect(state.players[0].statusTags).toEqual([])
    expect(state.players[0].rules).toEqual([])
    expect(state.extensions.tileEffects).toEqual([])
    expect(state.actions).toContainEqual(expect.objectContaining({
      type: 'damage',
      payload: expect.objectContaining({ sourceId: 'player-red', targetId: 'mover', damageSource: { kind: 'player', sourceId: 'player-red', playerId: 'player-red' }, finalDamage: 4 }),
    }))
  })
})
