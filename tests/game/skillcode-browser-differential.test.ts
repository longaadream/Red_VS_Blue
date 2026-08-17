/* eslint-disable @typescript-eslint/no-explicit-any -- audit fixtures intentionally cross the untyped browser VM boundary */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { runBattleAction } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { TriggerSystem, globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

type Runtime = {
  applyBattleAction: typeof applyBattleAction
  checkTriggers: (state: any, context: any) => any
  loadRuleById: typeof loadRuleById
  runBattleAction: typeof runBattleAction
  reset: () => void
}

type SurfaceEvidence = {
  surface: string
  trace: unknown[]
  outcome: Record<string, unknown>
  stateHash: string
}

function loadBrowserRuntime(): Runtime {
  const bundlePath = resolve(process.cwd(), 'data/pages/js/game-engine.js')
  const bundleSource = readFileSync(bundlePath, 'utf8')
  const context: Record<string, unknown> = {
    Buffer,
    clearTimeout,
    console: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
    process,
    require: createRequire(import.meta.url),
    setTimeout,
  }

  runInNewContext(bundleSource, context, { filename: bundlePath })
  const browser = context.GameEngine as any
  return {
    applyBattleAction: browser.applyBattleAction,
    checkTriggers: browser.globalTriggerSystem.checkTriggers.bind(browser.globalTriggerSystem),
    loadRuleById: browser.loadRuleById,
    runBattleAction: browser.runBattleAction,
    reset: () => browser.globalTriggerSystem.clearRules(),
  }
}

function loadNodeRuntime(): Runtime {
  const triggerSystem = new TriggerSystem()
  return {
    applyBattleAction,
    checkTriggers: triggerSystem.checkTriggers.bind(triggerSystem),
    loadRuleById,
    runBattleAction,
    reset: () => {
      triggerSystem.clearRules()
      globalTriggerSystem.clearRules()
    },
  }
}

function normalizeEventChain(result: any): unknown[] {
  return (result.eventChain ?? []).map((entry: any) => ({
    depth: entry.depth,
    eventId: entry.eventId,
    parentEventId: entry.parentEventId,
    type: entry.type,
  }))
}

function executeRuleSkillCode(runtime: Runtime): SurfaceEvidence {
  const piece = makePiece({ instanceId: 'rage-owner' }) as any
  piece.statusTags = [{ id: 'rage', type: 'rage-stance' }]
  const rule = runtime.loadRuleById('rule-watcher-rage-dealt', true)
  if (!rule) throw new Error('rule-watcher-rage-dealt did not load')
  piece.rules = [rule]
  const state = makeState({ pieces: [piece] }) as any
  const context: any = { type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: piece, damage: 3 }
  const result = runtime.checkTriggers(state, context)

  return {
    surface: 'ruleSkillCode',
    trace: normalizeEventChain(result),
    outcome: { blocked: result.blocked, damage: context.damage, success: result.success },
    stateHash: hashBattleState(state),
  }
}

function executeRuleTriggerSkill(runtime: Runtime): SurfaceEvidence {
  const piece = makePiece({ instanceId: 'blessing-owner' }) as any
  piece.statusTags = [{ id: 'divine-blessing-buff', type: 'divine-blessing-buff', intensity: 4 }]
  const rule = runtime.loadRuleById('rule-divine-blessing', true)
  if (!rule) throw new Error('rule-divine-blessing did not load')
  piece.rules = [rule]
  const state = makeState({ pieces: [piece] }) as any
  const context: any = {
    type: 'beforeDamageDealt',
    playerId: 'player-red',
    sourcePiece: piece,
    piece,
    damage: 3,
  }
  const result = runtime.checkTriggers(state, context)

  return {
    surface: 'ruleTriggerSkill',
    trace: normalizeEventChain(result),
    outcome: {
      blocked: result.blocked,
      damage: context.damage,
      statusTags: piece.statusTags,
      success: result.success,
    },
    stateHash: hashBattleState(state),
  }
}

function executeSkillCode(runtime: Runtime): SurfaceEvidence {
  const piece = makePiece({ instanceId: 'skill-caster', ownerPlayerId: 'player-red' }) as any
  piece.skills = [{ skillId: 'matrix-skill', currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' }) as any
  state.extensions.runtimeTrace = []
  state.skillsById['matrix-skill'] = {
    id: 'matrix-skill',
    name: 'matrix skill',
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code: "function executeSkill(context) { context.battle.extensions.runtimeTrace.push({ surface: 'skillCode', source: context.piece.instanceId }); return { success: true, message: 'skill-ok' }; }",
  }

  const next = runtime.applyBattleAction(state, {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: piece.instanceId,
    skillId: 'matrix-skill',
  } as any) as any

  return {
    surface: 'skillCode',
    trace: next.extensions.runtimeTrace,
    outcome: { actionType: next.actions.at(-1)?.type, successMessage: next.actions.at(-1)?.payload?.message },
    stateHash: hashBattleState(next),
  }
}

function rejectShishioPassiveActiveUse(runtime: Runtime): SurfaceEvidence {
  const passive = JSON.parse(readFileSync(
    resolve(process.cwd(), 'data/skills/shishio-combustion-passive.json'),
    'utf8',
  ))
  const piece = makePiece({
    instanceId: 'shishio',
    templateId: 'red-shishio',
    ownerPlayerId: 'player-red',
    currentHp: 7,
    maxHp: 7,
  }) as any
  piece.skills = [{ skillId: passive.id, currentCooldown: 0, usesRemaining: -1 }]
  const state = makeState({ pieces: [piece], currentPlayerId: 'player-red', phase: 'action' }) as any
  state.skillsById[passive.id] = passive
  const player = state.players.find((entry: any) => entry.playerId === 'player-red')
  const beforeHash = hashBattleState(state)
  let rejection = ''

  try {
    runtime.runBattleAction(state, {
      type: 'useBasicSkill',
      playerId: 'player-red',
      pieceId: piece.instanceId,
      skillId: passive.id,
      clientActionId: 'red-76-browser-differential',
    } as any, { rootSeed: 7601 })
  } catch (error) {
    rejection = String((error as any)?.message ?? error)
  }

  const stateHash = hashBattleState(state)
  return {
    surface: 'skillCode:shishio-combustion-passive',
    trace: [],
    outcome: {
      actionPoints: player.actionPoints,
      currentHp: piece.currentHp,
      currentCooldown: piece.skills[0].currentCooldown,
      inputUnchanged: stateHash === beforeHash,
      rejection,
    },
    stateHash,
  }
}

function executeCardCode(runtime: Runtime): SurfaceEvidence {
  const state = makeState({ currentPlayerId: 'player-red', phase: 'action' }) as any
  const player = state.players.find((entry: any) => entry.playerId === 'player-red')
  player.hand = [{ cardId: 'matrix-card', instanceId: 'matrix-card-instance', actionPointCost: 0 }]
  player.discardPile = []
  state.extensions.runtimeTrace = []
  state.customCards = {
    'matrix-card': {
      id: 'matrix-card',
      name: 'matrix card',
      description: '',
      type: 'active',
      actionPointCost: 0,
      code: "function executeCard(context) { context.battle.extensions.runtimeTrace.push({ surface: 'cardCode', playerId: context.playerId }); return { success: true, message: 'card-ok' }; }",
    },
  }

  const next = runtime.applyBattleAction(state, {
    type: 'playCard',
    playerId: 'player-red',
    cardInstanceId: 'matrix-card-instance',
  } as any) as any
  const nextPlayer = next.players.find((entry: any) => entry.playerId === 'player-red')

  return {
    surface: 'cardCode',
    trace: next.extensions.runtimeTrace,
    outcome: { discardPile: nextPlayer.discardPile, handSize: nextPlayer.hand.length },
    stateHash: hashBattleState(next),
  }
}

function executeAttachedEffectCode(runtime: Runtime): SurfaceEvidence {
  const piece = makePiece({ instanceId: 'effect-owner' }) as any
  piece.attachedEffects = [{
    instanceId: 'matrix-effect',
    definitionId: 'matrix-effect',
    ownerId: piece.instanceId,
    data: {},
    triggers: [{
      on: 'matrix-attached',
      filterCode: 'function(ctx, battle, self) { return self.ownerId === "effect-owner" && ctx.playerId === "player-red"; }',
      effectCode: "function(ctx, battle) { battle.extensions.runtimeTrace.push({ surface: 'attachedEffectCode', playerId: ctx.playerId }); return { success: true, message: 'effect-ok' }; }",
    }],
  }]
  const state = makeState({ pieces: [piece] }) as any
  state.extensions.runtimeTrace = []
  const result = runtime.checkTriggers(state, { type: 'matrix-attached', playerId: 'player-red' })

  return {
    surface: 'attachedEffectCode',
    trace: [...normalizeEventChain(result), ...state.extensions.runtimeTrace],
    outcome: { blocked: result.blocked, messages: result.messages, success: result.success },
    stateHash: hashBattleState(state),
  }
}

function executePendingEffectCode(runtime: Runtime): SurfaceEvidence {
  const state = makeState({ currentPlayerId: 'player-blue', phase: 'action' }) as any
  state.extensions.runtimeTrace = []
  state.pendingTargetSelection = finalizePendingTargetSession(state, {
    playerId: 'player-blue',
    title: 'matrix pending',
    targetType: 'cell',
    filter: 'all',
    effectCode: "function(ctx) { ctx.battle.extensions.runtimeTrace.push({ surface: 'pendingEffectCode', target: [ctx.targetX, ctx.targetY] }); return { success: true, message: 'pending-ok' }; }",
  }, 0)

  const next = runtime.applyBattleAction(state, {
    type: 'pendingTargetSelect',
    playerId: 'player-blue',
    targetX: 2,
    targetY: 1,
    selectionId: state.pendingTargetSelection.selectionId,
    stateRevision: state.pendingTargetSelection.stateRevision,
  } as any) as any

  return {
    surface: 'pendingEffectCode',
    trace: next.extensions.runtimeTrace,
    outcome: {
      message: next.actions.at(-1)?.payload?.message,
      pendingCleared: next.pendingTargetSelection === undefined,
    },
    stateHash: hashBattleState(next),
  }
}

const SURFACES = [
  executeRuleSkillCode,
  executeRuleTriggerSkill,
  executeSkillCode,
  executeCardCode,
  executeAttachedEffectCode,
  executePendingEffectCode,
]

describe('RED-45 skillCode Node/browser differential matrix', () => {
  it.each(SURFACES.map(execute => [execute.name, execute] as const))(
    '%s produces the same ordered trace, outcome, and final state hash',
    (_name, execute) => {
      const node = loadNodeRuntime()
      const browser = loadBrowserRuntime()
      node.reset()
      browser.reset()
      try {
        const nodeEvidence = execute(node)
        const browserEvidence = execute(browser)
        expect(browserEvidence).toEqual(nodeEvidence)
      } finally {
        node.reset()
        browser.reset()
      }
    },
  )
})

describe('RED-76 Shishio passive Node/browser differential', () => {
  it('rejects the same fixed-seed active attempt with the same final hash', () => {
    const node = loadNodeRuntime()
    const browser = loadBrowserRuntime()
    node.reset()
    browser.reset()
    try {
      const nodeEvidence = rejectShishioPassiveActiveUse(node)
      const browserEvidence = rejectShishioPassiveActiveUse(browser)
      expect(nodeEvidence.outcome).toMatchObject({
        inputUnchanged: true,
        rejection: expect.stringMatching(/^技能施放失败 \[seed=7601 /),
      })
      expect(browserEvidence).toEqual(nodeEvidence)
    } finally {
      node.reset()
      browser.reset()
    }
  })
})
