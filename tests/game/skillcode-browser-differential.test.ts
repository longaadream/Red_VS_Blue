/* eslint-disable @typescript-eslint/no-explicit-any -- audit fixtures intentionally cross the untyped browser VM boundary */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-trace'
import { mulberry32, setRng } from '@/lib/game/rng'
import { loadRuleById } from '@/lib/game/skills'
import { finalizePendingTargetSession } from '@/lib/game/targeting'
import { TriggerSystem, globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'
import {
  assertSkillCodeTraceParity,
  captureSkillCodeTraceEvidence,
  formatSkillCodeTraceEvidence,
  seedSkillCodeRuntime,
  type SkillCodeTraceEvidence,
} from '../helpers/skillcode-trace-bridge'

type Runtime = {
  applyBattleAction: typeof applyBattleAction
  checkTriggers: (state: any, context: any) => any
  hashBattleState: typeof hashBattleState
  loadRuleById: typeof loadRuleById
  mulberry32: typeof mulberry32
  reset: () => void
  setRng: typeof setRng
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
    hashBattleState: browser.hashBattleState,
    loadRuleById: browser.loadRuleById,
    mulberry32: browser.mulberry32,
    reset: () => browser.globalTriggerSystem.clearRules(),
    setRng: browser.setRng,
  }
}

function loadNodeRuntime(): Runtime {
  const triggerSystem = new TriggerSystem()
  return {
    applyBattleAction,
    checkTriggers: triggerSystem.checkTriggers.bind(triggerSystem),
    hashBattleState,
    loadRuleById,
    mulberry32,
    reset: () => {
      triggerSystem.clearRules()
      globalTriggerSystem.clearRules()
    },
    setRng,
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

const SURFACE_SEEDS = {
  ruleSkillCode: 0x750001,
  ruleTriggerSkill: 0x750002,
  skillCode: 0x750003,
  cardCode: 0x750004,
  pendingEffectCode: 0x750006,
} as const

function captureSurfaceEvidence(
  runtime: Runtime,
  fixture: string,
  surface: keyof typeof SURFACE_SEEDS,
  command: Record<string, unknown>,
  state: any,
  trace: unknown[],
  outcome: Record<string, unknown>,
): SkillCodeTraceEvidence {
  const seed = SURFACE_SEEDS[surface]
  return captureSkillCodeTraceEvidence({
    fixture, surface, seed, command, state, trace, outcome,
    stateHash: runtime.hashBattleState(state),
  })
}

function executeRuleSkillCode(runtime: Runtime): SkillCodeTraceEvidence {
  seedSkillCodeRuntime(runtime, SURFACE_SEEDS.ruleSkillCode)
  const piece = makePiece({ instanceId: 'rage-owner' }) as any
  piece.statusTags = [{ id: 'rage', type: 'rage-stance' }]
  const rule = runtime.loadRuleById('rule-watcher-rage-dealt', true)
  if (!rule) throw new Error('rule-watcher-rage-dealt did not load')
  piece.rules = [rule]
  const state = makeState({ pieces: [piece] }) as any
  const context: any = { type: 'beforeDamageDealt', playerId: 'player-red', sourcePiece: piece, damage: 3 }
  const result = runtime.checkTriggers(state, context)

  return captureSurfaceEvidence(
    runtime,
    'rule-skill-code',
    'ruleSkillCode',
    { type: 'dispatchTrigger', eventType: context.type, playerId: context.playerId, sourcePieceId: piece.instanceId, damage: 3 },
    state,
    normalizeEventChain(result),
    { blocked: result.blocked, damage: context.damage, success: result.success },
  )
}

function executeRuleTriggerSkill(runtime: Runtime): SkillCodeTraceEvidence {
  seedSkillCodeRuntime(runtime, SURFACE_SEEDS.ruleTriggerSkill)
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

  return captureSurfaceEvidence(
    runtime,
    'rule-trigger-skill',
    'ruleTriggerSkill',
    { type: 'dispatchTrigger', eventType: context.type, playerId: context.playerId, sourcePieceId: piece.instanceId, damage: 3 },
    state,
    normalizeEventChain(result),
    {
      blocked: result.blocked,
      damage: context.damage,
      statusTags: piece.statusTags,
      success: result.success,
    },
  )
}

function executeSkillCode(runtime: Runtime): SkillCodeTraceEvidence {
  seedSkillCodeRuntime(runtime, SURFACE_SEEDS.skillCode)
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

  const command = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: piece.instanceId,
    skillId: 'matrix-skill',
  }
  const next = runtime.applyBattleAction(state, command as any) as any

  return captureSurfaceEvidence(
    runtime,
    'piece-skill-code',
    'skillCode',
    command,
    next,
    next.extensions.runtimeTrace,
    { actionType: next.actions.at(-1)?.type, successMessage: next.actions.at(-1)?.payload?.message },
  )
}

function executeCardCode(runtime: Runtime): SkillCodeTraceEvidence {
  seedSkillCodeRuntime(runtime, SURFACE_SEEDS.cardCode)
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

  const command = {
    type: 'playCard',
    playerId: 'player-red',
    cardInstanceId: 'matrix-card-instance',
  }
  const next = runtime.applyBattleAction(state, command as any) as any
  const nextPlayer = next.players.find((entry: any) => entry.playerId === 'player-red')

  return captureSurfaceEvidence(
    runtime,
    'active-card-code',
    'cardCode',
    command,
    next,
    next.extensions.runtimeTrace,
    { discardPile: nextPlayer.discardPile, handSize: nextPlayer.hand.length },
  )
}

function executePendingEffectCode(runtime: Runtime): SkillCodeTraceEvidence {
  seedSkillCodeRuntime(runtime, SURFACE_SEEDS.pendingEffectCode)
  const state = makeState({ currentPlayerId: 'player-blue', phase: 'action' }) as any
  state.extensions.runtimeTrace = []
  state.pendingTargetSelection = finalizePendingTargetSession(state, {
    playerId: 'player-blue',
    title: 'matrix pending',
    targetType: 'cell',
    filter: 'all',
    effectCode: "function(ctx) { ctx.battle.extensions.runtimeTrace.push({ surface: 'pendingEffectCode', target: [ctx.targetX, ctx.targetY] }); return { success: true, message: 'pending-ok' }; }",
  }, 0)

  const command = {
    type: 'pendingTargetSelect',
    playerId: 'player-blue',
    targetX: 2,
    targetY: 1,
    selectionId: state.pendingTargetSelection.selectionId,
    stateRevision: state.pendingTargetSelection.stateRevision,
  }
  const next = runtime.applyBattleAction(state, command as any) as any

  return captureSurfaceEvidence(
    runtime,
    'pending-serialized-effect-code',
    'pendingEffectCode',
    command,
    next,
    next.extensions.runtimeTrace,
    {
      message: next.actions.at(-1)?.payload?.message,
      pendingCleared: next.pendingTargetSelection === undefined,
    },
  )
}

const SURFACES = [
  ['rule-skill-code', executeRuleSkillCode],
  ['rule-trigger-skill', executeRuleTriggerSkill],
  ['piece-skill-code', executeSkillCode],
  ['active-card-code', executeCardCode],
  ['pending-serialized-effect-code', executePendingEffectCode],
] as const

describe('RED-75 skillCode Node/browser trace differential matrix', () => {
  it.each(SURFACES)(
    '%s compares fixed seed, command, ordered trace, action log, outcome, and final state hash',
    (fixture, execute) => {
      const node = loadNodeRuntime()
      const browser = loadBrowserRuntime()
      node.reset()
      browser.reset()
      try {
        const nodeEvidence = execute(node)
        const browserEvidence = execute(browser)
        expect(nodeEvidence.fixture).toBe(fixture)
        assertSkillCodeTraceParity(nodeEvidence, browserEvidence)
        if (process.env.RED75_TRACE_REPORT === '1') {
          console.info(`[RED-75 evidence] ${formatSkillCodeTraceEvidence(nodeEvidence)}`)
        }
      } finally {
        node.reset()
        browser.reset()
      }
    },
  )

  it('reports the first differing path, fixture inputs, and reproduction commands', () => {
    const node: SkillCodeTraceEvidence = {
      fixture: 'diagnostic-fixture',
      surface: 'skillCode',
      seed: 0x7500ff,
      command: { type: 'useBasicSkill', skillId: 'matrix-skill' },
      trace: [{ stage: 'node' }],
      actionLog: [],
      outcome: {},
      stateHash: 'same-hash',
    }
    const browser: SkillCodeTraceEvidence = {
      ...node,
      trace: [{ stage: 'browser' }],
    }

    expect(() => assertSkillCodeTraceParity(node, browser)).toThrowError(
      /fixture: diagnostic-fixture[\s\S]*seed: 0x007500ff[\s\S]*first difference: trace\[0\]\.stage[\s\S]*npm\.cmd run build:game-engine[\s\S]*-t "diagnostic-fixture"/,
    )
  })
})
