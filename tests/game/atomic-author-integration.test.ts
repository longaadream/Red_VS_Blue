/* eslint-disable @typescript-eslint/no-explicit-any -- atomic author samples use JSON-shaped content fixtures. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { applyBattleAction, type BattleAction, type BattleState } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import { RANDOM_STREAM_NAMES, RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { clearRuleCache, clearSkillDefinitionCache, executeSkillFunction } from '@/lib/game/skills'
import { globalTriggerSystem, type TriggerRule } from '@/lib/game/triggers'
import { createFlowRuntime } from '@/lib/game/flow-runtime'
import { applyGameplayModuleGraph, compileGameplayModuleGraph, GAMEPLAY_MODULE_REGISTRY } from '@/lib/skill-graph/module-document'
import {
  buildAtomicFireballGraph,
  buildAtomicMinatoFlyingRaijinRuleGraph,
  buildAtomicNarutoShadowCloneGraph,
  buildAtomicRecallGraph,
  ATOMIC_RECALL_RECORD_SCHEMA,
} from '@/scripts/migrate-atomic-author-samples'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

type JsonRecord = Record<string, any>

const fixture = JSON.parse(readFileSync('tests/game/fixtures/RED-252-legacy-content.json', 'utf8')).entries as Record<string, JsonRecord>
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function generatedEntry(id: string, graph: any, field: 'code' | 'skillCode' = 'code'): JsonRecord {
  // The frozen fixture is intentionally graph-less legacy content.  Use the
  // production document as the migration input so an existing static
  // targeting declaration has its prior graph available for one-to-one
  // binding validation.  The fixture remains the source for legacy rules and
  // dependencies below; do not synthesize a graph into that fixture.
  if (!fixture[id]) throw new Error(`missing frozen fixture entry ${id}`)
  const filename = join('data', `${id}.json`)
  const source = JSON.parse(readFileSync(filename, 'utf8')) as JsonRecord
  const entries = source.gameplayModules?.entries
  const prior = entries && typeof entries === 'object' && !Array.isArray(entries)
    ? (entries as JsonRecord)[field]
    : undefined
  if (!prior || typeof prior !== 'object' || Array.isArray(prior) || !('graph' in prior)) {
    throw new Error(`production author sample ${id}.${field} is missing its prior graph entry`)
  }
  return applyGameplayModuleGraph(clone(source), graph, field) as JsonRecord
}

function writeJson(root: string, relative: string, value: unknown): void {
  const filename = join(root, 'data', relative)
  mkdirSync(dirname(filename), { recursive: true })
  writeFileSync(filename, JSON.stringify(value), 'utf8')
}

function withAtomicProfile<T>(callback: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'rvb-red252-atomic-integration-'))
  const documents: Array<[string, JsonRecord]> = [
    ['skills/fireball.json', generatedEntry('skills/fireball', buildAtomicFireballGraph())],
    ['skills/minato-rasengan.json', JSON.parse(readFileSync('data/skills/minato-rasengan.json', 'utf8'))],
    ['skills/naruto-shadow-clone.json', generatedEntry('skills/naruto-shadow-clone', buildAtomicNarutoShadowCloneGraph())],
    ['skills/recall.json', generatedEntry('skills/recall', buildAtomicRecallGraph('recall'))],
    ['skills/recall-move-trigger.json', generatedEntry('skills/recall-move-trigger', buildAtomicRecallGraph('recall-move-trigger'))],
    ['skills/recall-endturn-trigger.json', generatedEntry('skills/recall-endturn-trigger', buildAtomicRecallGraph('recall-endturn-trigger'))],
    ['skills/recall-skill-trigger.json', generatedEntry('skills/recall-skill-trigger', buildAtomicRecallGraph('recall-skill-trigger'))],
    ['rules/rule-naruto-clone-died.json', clone(fixture['rules/rule-naruto-clone-died'])],
    ['rules/rule-naruto-clone-immobile.json', clone(fixture['rules/rule-naruto-clone-immobile'])],
    ['rules/rule-naruto-clone-one-hit.json', clone(fixture['rules/rule-naruto-clone-one-hit'])],
    ['rules/rule-minato-flying-raijin-trigger.json', generatedEntry(
      'rules/rule-minato-flying-raijin-trigger', buildAtomicMinatoFlyingRaijinRuleGraph(), 'skillCode',
    )],
  ]
  for (const [relative, document] of documents) writeJson(root, relative, document)
  const previousRoot = process.env.RVB_PROFILE_ROOT
  process.env.RVB_PROFILE_ROOT = root
  clearRuleCache()
  clearSkillDefinitionCache()
  try {
    return callback()
  } finally {
    clearRuleCache()
    clearSkillDefinitionCache()
    if (previousRoot === undefined) delete process.env.RVB_PROFILE_ROOT
    else process.env.RVB_PROFILE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}

function createState(pieces: any[], width = 8, height = 8, currentPlayerId: 'player-red' | 'player-blue' = 'player-red'): BattleState {
  const state = makeState({ pieces, width, height, currentPlayerId, phase: 'action' })
  state.players[0].actionPoints = 5
  state.players[1].actionPoints = 5
  return state
}

const recallDeclaration = {
  schema: ATOMIC_RECALL_RECORD_SCHEMA,
  schemas: [ATOMIC_RECALL_RECORD_SCHEMA],
  keyField: 'pieceKey',
}

function readRecallItems(state: BattleState): any[] {
  const flow = createFlowRuntime(state, {}, 'triggerSkill', {})
  return flow.extension.mapItems('player-red', 'content', 'recall-records', recallDeclaration)
}

function rawRecallItemsForPiece(state: BattleState, pieceId: string): any[] {
  const records = (state.extensions as any)?.recallData
  if (!Array.isArray(records)) return []
  return records.filter((record: any) => record?.pieceId === pieceId)
}

type MinatoChoice = 'yes' | 'no' | 'cancel' | 'none'

function createMinatoScenario(options: {
  statusTags?: any[]
  attachRule?: boolean
  currentPlayerId?: 'player-red' | 'player-blue'
  minatoHp?: number
  markedOwnerPlayerId?: 'player-red' | 'player-blue'
} = {}): { state: BattleState; minato: any; marked: any } {
  const minato = makePiece({
    instanceId: 'minato', templateId: 'red-minato', name: '波风水门', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 1, currentHp: options.minatoHp ?? 30, maxHp: 30, attack: 8,
    skills: [{ skillId: 'minato-rasengan', currentCooldown: 0, usesRemaining: -1 }],
  }) as any
  minato.name = '波风水门'
  const marked = makePiece({
    instanceId: 'marked', templateId: 'blue-target', name: '标记者',
    ownerPlayerId: options.markedOwnerPlayerId ?? 'player-blue',
    faction: options.markedOwnerPlayerId === 'player-red' ? 'red' : 'blue',
    x: 2, y: 1, currentHp: 50, maxHp: 50,
    statusTags: clone(options.statusTags ?? [{
      id: 'mark-minato', type: 'flying-raijin-mark', name: '飞雷神', visible: true,
      currentDuration: 3, currentUses: -1, intensity: 1, stacks: 1, sourceId: 'minato',
    }]),
  }) as any
  marked.name = '标记者'
  const state = createState([minato, marked], 8, 8, options.currentPlayerId ?? 'player-red')
  state.players[0].actionPoints = 3
  state.players[1].actionPoints = 3
  state.skillsById['minato-rasengan'] = JSON.parse(readFileSync('data/skills/minato-rasengan.json', 'utf8')) as any
  if (options.attachRule !== false) {
    const rule = generatedEntry('rules/rule-minato-flying-raijin-trigger', buildAtomicMinatoFlyingRaijinRuleGraph(), 'skillCode')
    minato.rules = [{ ...rule, effect: undefined }]
  }
  return { state, minato, marked }
}

function minatoTargetedAction(state: BattleState, playerId = 'player-red', pieceId = 'minato', skillId = 'minato-rasengan', targetPieceId = 'marked'): BattleAction {
  const root: BattleAction = { type: 'useBasicSkill', playerId, pieceId, skillId }
  const prepared = prepareAction(state, root)
  if (prepared.kind !== 'needTarget') throw new Error(`Minato skill did not expose its target step: ${prepared.kind}`)
  return { ...root, targetPieceId, selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
}

function runMinatoChoice(initial: BattleState, action: BattleAction, choice: MinatoChoice, runtime: RuleRuntime): BattleState {
  return withRuleRuntime(runtime, () => {
    let state = applyBattleAction(initial, action)
    if (choice === 'none') return state
    const pending = state.pendingOptionSelection
    expect(pending).toBeDefined()
    if (!pending) throw new Error('Minato choice did not create a pending option')
    expect(pending.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'yes' }), expect.objectContaining({ value: 'no' }),
    ]))
    if (choice === 'cancel') {
      return applyBattleAction(state, {
        type: 'cancelPendingSelection', playerId: pending.playerId,
        selectionId: pending.selectionId, stateRevision: pending.stateRevision,
      })
    }
    state = applyBattleAction(state, {
      type: 'pendingOptionSelect', playerId: pending.playerId, selectedOption: choice,
      selectionId: pending.selectionId, stateRevision: pending.stateRevision,
    })
    return state
  })
}

function runAuthoritativeAction(
  initial: BattleState,
  rootAction: BattleAction,
  choose: (kind: 'option' | 'target', pending: any, pendingState: BattleState) => unknown,
): BattleState {
  return withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => {
    let state = initial
    let action = rootAction
    // The author target metadata now exposes eligible initial choices to the
    // same prepare/submit protocol as declarative skills. Obtain credentials
    // before the reducer; later rule-triggered choices still suspend below.
    if ((action.type === 'useBasicSkill' || action.type === 'useChargeSkill' || action.type === 'playCard') && action.selectionId === undefined) {
      const submitted = { ...action }
      let draft = { ...action }
      delete draft.targetPieceId
      delete draft.targetX
      delete draft.targetY
      delete draft.selectedOption
      for (let step = 0; step < 8; step += 1) {
        const prepared = prepareAction(state, draft)
        if (prepared.kind === 'ready') break
        if (prepared.kind === 'invalid') throw new Error(prepared.message ?? prepared.code)
        if (prepared.kind === 'needOption') {
          draft = { ...draft, selectedOption: submitted.selectedOption ?? choose('option', prepared, state),
            selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
        } else {
          const selected = submitted.targetPieceId ? { pieceId: submitted.targetPieceId }
            : submitted.targetX !== undefined ? { x: submitted.targetX, y: submitted.targetY }
            : choose('target', prepared, state) as any
          draft = { ...draft, ...(selected?.pieceId ? { targetPieceId: selected.pieceId } : { targetX: selected.x, targetY: selected.y }),
            selectionId: prepared.selectionId, stateRevision: prepared.stateRevision }
        }
        if (step === 7) throw new Error('initial target selection exceeded eight steps')
      }
      action = draft
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      state = applyBattleAction(state, action)
      if (state.pendingOptionSelection) {
        const pending = state.pendingOptionSelection
        action = {
          type: 'pendingOptionSelect',
          playerId: pending.playerId,
          selectedOption: choose('option', pending, state),
          selectionId: pending.selectionId,
          stateRevision: pending.stateRevision,
        }
        continue
      }
      if (state.pendingTargetSelection) {
        const pending = state.pendingTargetSelection
        const selected = choose('target', pending, state) as any
        action = {
          type: 'pendingTargetSelect',
          playerId: pending.playerId,
          ...(selected?.pieceId ? { targetPieceId: selected.pieceId } : { targetX: selected.x, targetY: selected.y }),
          selectionId: pending.selectionId,
          stateRevision: pending.stateRevision,
        }
        continue
      }
      return state
    }
    throw new Error('authoritative action did not resolve within eight continuation steps')
  })
}

function completeShadowCloneAction(initial: BattleState, option: 'summon' | 'teleport', target: { x: number; y: number }): BattleState {
  const root: BattleAction = {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'naruto', skillId: 'naruto-shadow-clone',
  }
  // Shadow Clone carries a static targeting.steps declaration.  The turn host
  // therefore requires both targeting credentials before entering the skill;
  // author.choice.* reuses those credentials instead of opening a second
  // suspendable session.  Keep the two preflight results observable here and
  // submit the final action through the real reducer.
  const first = prepareAction(initial, root)
  expect(first.kind).toBe('needOption')
  if (first.kind !== 'needOption') throw new Error('Shadow Clone did not expose its option step')
  expect(first.options).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: 'summon' }),
    expect.objectContaining({ value: 'teleport' }),
  ]))
  const chosen: BattleAction = {
    ...root,
    selectedOption: option,
    selectionId: first.selectionId,
    stateRevision: first.stateRevision,
  }
  const second = prepareAction(initial, chosen)
  expect(second.kind).toBe('needTarget')
  if (second.kind !== 'needTarget') throw new Error('Shadow Clone did not expose its target step')
  expect(second.targetType).toBe('cell')
  expect(second.candidates).toEqual(expect.arrayContaining([{ type: 'cell', x: target.x, y: target.y }]))
  return withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => applyBattleAction(initial, {
    ...chosen,
    targetX: target.x,
    targetY: target.y,
    selectionId: second.selectionId,
    stateRevision: second.stateRevision,
  }))
}

function restoreGlobalRules<T>(callback: () => T): T {
  const previous = [...globalTriggerSystem.getRules()]
  try {
    return callback()
  } finally {
    globalTriggerSystem.clearRules()
    globalTriggerSystem.addRules(previous)
  }
}

function runRecallActiveAndTrigger(triggerId: 'recall-move-trigger' | 'recall-endturn-trigger', dead = false, blocked = false, alliedAction = false): BattleState {
  const tracer = asPieceInstance(makePiece({
    instanceId: 'tracer', templateId: 'tracer', name: '追迹者', ownerPlayerId: 'player-red', faction: 'red',
    x: 2, y: 3, currentHp: 11, maxHp: 15,
    statusTags: [{ id: 'saved', type: 'saved', name: '已保存', visible: true, currentDuration: -1, currentUses: -1, intensity: 1, stacks: 2 }],
  })) as any
  tracer.shield = 7
  tracer.buffs = [{ id: 'saved-buff', stacks: 1 }]
  tracer.debuffs = [{ id: 'saved-debuff', currentDuration: 2 }]
  const actor = makePiece({
    instanceId: 'actor', templateId: 'actor', name: '行动者', ownerPlayerId: 'player-blue', faction: 'blue',
    x: 6, y: 6, currentHp: 20, maxHp: 20,
  }) as any
  actor.name = '行动者'
  const state = createState([tracer, actor])
  if (alliedAction) {
    // Different owners and raw piece colors, but one authoritative 2v2 team.
    state.players[0].teamId = 'red'
    state.players[1].teamId = 'red'
    state.players.push(
      { ...clone(state.players[0]), playerId: 'player-third', teamId: 'blue' },
      { ...clone(state.players[1]), playerId: 'player-fourth', teamId: 'blue' },
    )
  }
  const recall = generatedEntry('skills/recall', buildAtomicRecallGraph('recall')) as any
  const trigger = generatedEntry(`skills/${triggerId}`, buildAtomicRecallGraph(triggerId)) as any
  state.skillsById.recall = recall
  state.skillsById[triggerId] = trigger
  const activeContext: any = {
    piece: tracer, rulePiece: tracer, sourcePiece: tracer, playerId: tracer.ownerPlayerId,
    selectedOption: 1, skill: recall, battle: state, target: null, targetPosition: null, targets: [],
  }
  withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => executeSkillFunction(recall, activeContext, state))

  tracer.x = 5
  tracer.y = 6
  tracer.currentHp = dead ? 0 : 3
  tracer.shield = 1
  tracer.buffs = [{ id: 'now-buff', stacks: 1 }]
  tracer.debuffs = [{ id: 'now-debuff', currentDuration: 1 }]
  tracer.statusTags = [{ id: 'now', type: 'now', name: '当前', visible: true, currentDuration: -1, currentUses: -1, intensity: 1, stacks: 1 }]

  const blocker: TriggerRule = {
    id: 'test-recall-position-blocker', name: 'test blocker', description: 'Blocks Recall displacement for the integration scenario.', trigger: { type: 'beforePiecePositionChange' },
    effect: (_battle, context) => context.sourcePiece?.instanceId === 'tracer'
      ? { success: true, messages: ['blocked for integration test'], blocked: true }
      : { success: false, messages: [], blocked: false },
  }
  return restoreGlobalRules(() => {
    if (blocked) globalTriggerSystem.addRule(blocker)
    const triggerContext: any = {
      piece: tracer, rulePiece: tracer, sourcePiece: actor, playerId: actor.ownerPlayerId,
      triggerPlayerId: actor.ownerPlayerId, skill: trigger, battle: state, target: null, targetPosition: null, targets: [],
    }
    withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => executeSkillFunction(
      trigger, triggerContext, state, { context: triggerContext, surface: 'triggerSkill' },
    ))
    return state
  })
}

describe('RED-252 atomic author samples: real runtime behavior', () => {
  it('keeps Recall inactive for a different player in the same 2v2 team', () => {
    withAtomicProfile(() => {
      const state = runRecallActiveAndTrigger('recall-move-trigger', false, false, true)
      const tracer = state.pieces.find(piece => piece.instanceId === 'tracer')
      expect(tracer).toMatchObject({ x: 5, y: 6, currentHp: 3, shield: 1 })
      expect(tracer?.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'now' })]))
    })
  })

  it('restores Recall instance data even when displacement is blocked, and does not revive a dead piece', () => {
    withAtomicProfile(() => {
      const blocked = runRecallActiveAndTrigger('recall-move-trigger', false, true)
      const tracer = blocked.pieces.find(piece => piece.instanceId === 'tracer') as any
      expect(tracer).toMatchObject({ x: 5, y: 6, currentHp: 11, shield: 7 })
      expect(tracer.statusTags).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'saved', stacks: 2 })]))
      expect(tracer.buffs).toEqual([{ id: 'saved-buff', stacks: 1 }])
      // Recall still uses the legacy recallData root as its authoritative
      // storage.  Verify the public typed map projection and the original
      // storage, rather than requiring a particular flowState representation.
      expect(readRecallItems(blocked)).toEqual([])
      expect(rawRecallItemsForPiece(blocked, 'tracer')).toEqual([])

      const dead = runRecallActiveAndTrigger('recall-endturn-trigger', true, false)
      const deadTracer = dead.pieces.find(piece => piece.instanceId === 'tracer') as any
      expect(deadTracer).toBeDefined()
      expect(deadTracer.currentHp).toBe(0)
      expect(deadTracer.x).toBe(5)
      expect(deadTracer.y).toBe(6)
      expect(readRecallItems(dead)).toEqual([])
      expect(rawRecallItemsForPiece(dead, 'tracer')).toEqual([])
    })
  })

  it('executes atomic Fireball through real target preparation and submission, dealing damage and charging AP', () => {
    withAtomicProfile(() => {
      const caster = makePiece({
        instanceId: 'caster', templateId: 'caster', name: '施法者', ownerPlayerId: 'player-red', faction: 'red',
        x: 1, y: 1, currentHp: 20, maxHp: 20, attack: 10,
        skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      caster.name = '施法者'
      const target = makePiece({
        instanceId: 'target', templateId: 'target', name: '目标', ownerPlayerId: 'player-blue', faction: 'blue',
        x: 3, y: 1, currentHp: 40, maxHp: 40, defense: 0,
      }) as any
      target.name = '目标'
      const bystander = makePiece({
        instanceId: 'ally', templateId: 'ally', name: '友军', ownerPlayerId: 'player-red', faction: 'red',
        x: 2, y: 1, currentHp: 40, maxHp: 40,
      }) as any
      bystander.name = '友军'
      const state = createState([caster, target, bystander], 8, 8)
      state.players[0].actionPoints = 3
      state.skillsById.fireball = generatedEntry('skills/fireball', buildAtomicFireballGraph()) as any
      const action: BattleAction = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'fireball',
      }
      let sawTargetPrompt = false
      const next = runAuthoritativeAction(state, action, (kind, pending, pendingState) => {
        if (kind !== 'target') throw new Error(`unexpected option prompt: ${JSON.stringify(pending)}`)
        sawTargetPrompt = true
        expect(pendingState.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(3)
        expect(pending.targetType).toBe('piece')
        expect(pending.filter).toBe('enemy')
        expect(pending.candidates).toEqual([{ type: 'piece', pieceId: 'target' }])
        return { pieceId: 'target' }
      })
      expect(sawTargetPrompt).toBe(true)
      expect(next.pendingOptionSelection).toBeUndefined()
      expect(next.pendingTargetSelection).toBeUndefined()
      expect(next.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(2)
      expect(next.pieces.find(piece => piece.instanceId === 'target')?.currentHp).toBe(25)
    })
  })

  it('rejects atomic Fireball when its typed target candidate set is empty without consuming AP', () => {
    withAtomicProfile(() => {
      const caster = makePiece({
        instanceId: 'caster', templateId: 'caster', name: '施法者', ownerPlayerId: 'player-red', faction: 'red',
        x: 1, y: 1, currentHp: 20, maxHp: 20, attack: 10,
        skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      caster.name = '施法者'
      const ally = makePiece({
        instanceId: 'ally', templateId: 'ally', name: '友军', ownerPlayerId: 'player-red', faction: 'red',
        x: 3, y: 1, currentHp: 40, maxHp: 40,
      }) as any
      ally.name = '友军'
      const state = createState([caster, ally], 8, 8)
      state.players[0].actionPoints = 3
      state.skillsById.fireball = generatedEntry('skills/fireball', buildAtomicFireballGraph()) as any
      const action: BattleAction = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'caster', skillId: 'fireball',
      }
      expect(() => withRuleRuntime(new RuleRuntime({ rootSeed: 594 }), () => applyBattleAction(state, action))).toThrow()
      expect(state.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(3)
      expect(state.actions).toEqual([])
    })
  })

  it.each([
    ['summon', { x: 3, y: 1 }],
    ['teleport', { x: 3, y: 1 }],
  ] as const)('runs atomic Shadow Clone in %s mode through the turn host', (option, target) => {
    withAtomicProfile(() => {
      const naruto = makePiece({
        instanceId: 'naruto', templateId: 'red-naruto', name: '鸣人', ownerPlayerId: 'player-red', faction: 'red',
        x: 1, y: 1, currentHp: 20, maxHp: 20,
        skills: [{ skillId: 'naruto-shadow-clone', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      naruto.name = '鸣人'
      const state = createState([naruto], 7, 7)
      state.skillsById['naruto-shadow-clone'] = generatedEntry('skills/naruto-shadow-clone', buildAtomicNarutoShadowCloneGraph()) as any
      state.players[0].actionPoints = 3
      const next = completeShadowCloneAction(state, option, target)
      const clonePiece = next.pieces.find(piece => piece.instanceId.startsWith('naruto-clone-')) as any
      expect(next.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(2)
      expect(clonePiece).toBeDefined()
      if (option === 'summon') {
        expect(next.pieces.find(piece => piece.instanceId === 'naruto')).toMatchObject({ x: 1, y: 1 })
        expect(clonePiece).toMatchObject({ x: 3, y: 1 })
      } else {
        expect(next.pieces.find(piece => piece.instanceId === 'naruto')).toMatchObject({ x: 3, y: 1 })
        expect(clonePiece).toMatchObject({ x: 1, y: 1 })
      }
    })
  })

  it('preserves Flying Raijin mark ownership across a real rule choice and multiple sources', () => {
    withAtomicProfile(() => {
      const minato = makePiece({
        instanceId: 'minato', templateId: 'red-minato', name: '波风水门', ownerPlayerId: 'player-red', faction: 'red',
        x: 1, y: 1, currentHp: 30, maxHp: 30, attack: 8,
        skills: [{ skillId: 'minato-rasengan', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      minato.name = '波风水门'
      const marked = makePiece({
        instanceId: 'marked', templateId: 'blue-target', name: '标记者', ownerPlayerId: 'player-blue', faction: 'blue',
        x: 2, y: 1, currentHp: 50, maxHp: 50,
        statusTags: [
          { id: 'mark-minato', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 3, currentUses: -1, intensity: 1, stacks: 1, sourceId: 'minato' },
          { id: 'mark-other', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 7, currentUses: -1, intensity: 1, stacks: 5, sourceId: 'other-minato' },
        ],
      }) as any
      marked.name = '标记者'
      const state = createState([minato, marked], 8, 8)
      state.players[0].actionPoints = 3
      state.skillsById['minato-rasengan'] = JSON.parse(readFileSync('data/skills/minato-rasengan.json', 'utf8')) as any
      const rule = JSON.parse(readFileSync('data/rules/rule-minato-flying-raijin-trigger.json', 'utf8')) as any
      expect(rule.trigger.type).toBe('beforeSkillUse')
      minato.rules = [{ ...rule, effect: undefined }]
      const root: BattleAction = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'minato', skillId: 'minato-rasengan',
      }
      const prepared = prepareAction(state, root)
      expect(prepared.kind).toBe('needTarget')
      if (prepared.kind !== 'needTarget') throw new Error('Minato skill did not expose its target step')
      const action: BattleAction = {
        ...root, targetPieceId: 'marked', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision,
      }
      let sawOptionPrompt = false
      const next = runAuthoritativeAction(state, action, (kind, pending, pendingState) => {
        if (kind !== 'option') throw new Error(`unexpected target prompt: ${JSON.stringify(pending)}`)
        sawOptionPrompt = true
        expect(pendingState.players.find(player => player.playerId === 'player-red')?.actionPoints).toBe(3)
        expect(pending.options).toEqual(expect.arrayContaining([
          expect.objectContaining({ value: 'yes' }), expect.objectContaining({ value: 'no' }),
        ]))
        return 'yes'
      })
      expect(sawOptionPrompt).toBe(true)
      const nextMinato = next.pieces.find(piece => piece.instanceId === 'minato') as any
      const nextMarked = next.pieces.find(piece => piece.instanceId === 'marked') as any
      expect(nextMinato.x === 1 && nextMinato.y === 1).toBe(false)
      expect(nextMarked.currentHp).toBeLessThan(50)
      // The atomic trigger grants +1, and the base Rasengan grants its own +1.
      expect(nextMinato.attack).toBe(10)
      expect(nextMarked.statusTags).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'flying-raijin-mark', sourceId: 'minato', stacks: 1, currentDuration: -1 }),
        expect.objectContaining({ type: 'flying-raijin-mark', sourceId: 'other-minato', stacks: 5, currentDuration: 7 }),
      ]))
    })
  })

  it('does not consume the skill RNG stream for decline, cancellation, or a no-trigger baseline', () => {
    withAtomicProfile(() => {
      const declined = createMinatoScenario()
      const declinedRuntime = new RuleRuntime({ rootSeed: 594 })
      runMinatoChoice(declined.state, minatoTargetedAction(declined.state), 'no', declinedRuntime)

      const cancelled = createMinatoScenario()
      const cancelledRuntime = new RuleRuntime({ rootSeed: 594 })
      runMinatoChoice(cancelled.state, minatoTargetedAction(cancelled.state), 'cancel', cancelledRuntime)

      const noTrigger = createMinatoScenario({ attachRule: false })
      const noTriggerRuntime = new RuleRuntime({ rootSeed: 594 })
      runMinatoChoice(noTrigger.state, minatoTargetedAction(noTrigger.state), 'none', noTriggerRuntime)

      const stream = RANDOM_STREAM_NAMES.skillEffect
      expect(declinedRuntime.getCursor(stream)).toBe(0)
      expect(cancelledRuntime.getCursor(stream)).toBe(0)
      expect(noTriggerRuntime.getCursor(stream)).toBe(0)
      expect(declinedRuntime.getCursor(stream)).toBe(noTriggerRuntime.getCursor(stream))
      expect(cancelledRuntime.getCursor(stream)).toBe(noTriggerRuntime.getCursor(stream))
    })
  })

  it('updates only the first matching own-source mark with legacy zero fallback and duration reset', () => {
    withAtomicProfile(() => {
      const minato = makePiece({
        instanceId: 'minato', templateId: 'red-minato', name: '波风水门', ownerPlayerId: 'player-red', faction: 'red',
        x: 1, y: 1, currentHp: 30, maxHp: 30, attack: 8,
      }) as any
      minato.name = '波风水门'
      const marked = makePiece({
        instanceId: 'marked', templateId: 'red-ally', name: '友军标记者', ownerPlayerId: 'player-red', faction: 'red',
        x: 2, y: 1, currentHp: 50, maxHp: 50,
        statusTags: [
          { id: 'mark-minato-trigger', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 3, currentUses: -1, intensity: 1, stacks: 1, sourceId: 'minato' },
        ],
      }) as any
      marked.name = '友军标记者'
      const attacker = makePiece({
        instanceId: 'attacker', templateId: 'blue-attacker', name: '敌方施法者', ownerPlayerId: 'player-blue', faction: 'blue',
        x: 4, y: 1, currentHp: 30, maxHp: 30, attack: 10,
        statusTags: [
          { id: 'mark-minato-first', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 4, currentUses: -1, intensity: 1, stacks: 0, sourceId: 'minato' },
          { id: 'mark-minato-second', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 6, currentUses: -1, intensity: 1, stacks: 7, sourceId: 'minato' },
          { id: 'mark-other', type: 'flying-raijin-mark', name: '飞雷神', visible: true, currentDuration: 9, currentUses: -1, intensity: 1, stacks: 5, sourceId: 'other-minato' },
        ],
        skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      attacker.name = '敌方施法者'
      const state = createState([minato, marked, attacker], 8, 8, 'player-blue')
      state.players[1].actionPoints = 3
      state.skillsById.fireball = generatedEntry('skills/fireball', buildAtomicFireballGraph()) as any
      const rule = generatedEntry('rules/rule-minato-flying-raijin-trigger', buildAtomicMinatoFlyingRaijinRuleGraph(), 'skillCode')
      minato.rules = [{ ...rule, effect: undefined }]
      const root: BattleAction = {
        type: 'useBasicSkill', playerId: 'player-blue', pieceId: 'attacker', skillId: 'fireball', targetPieceId: 'marked',
      }
      let sawOptionPrompt = false
      const next = runAuthoritativeAction(state, root, (kind, pending) => {
        if (kind === 'option') {
          sawOptionPrompt = true
          expect(pending.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: 'yes' }), expect.objectContaining({ value: 'no' }),
          ]))
          return 'yes'
        }
        return { pieceId: 'marked' }
      })
      expect(sawOptionPrompt).toBe(true)
      const nextAttacker = next.pieces.find(piece => piece.instanceId === 'attacker') as any
      expect(nextAttacker.statusTags).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'mark-minato-first', sourceId: 'minato', stacks: 2, currentDuration: -1 }),
        expect.objectContaining({ id: 'mark-minato-second', sourceId: 'minato', stacks: 7, currentDuration: 6 }),
        expect.objectContaining({ id: 'mark-other', sourceId: 'other-minato', stacks: 5, currentDuration: 9 }),
      ]))
      const nextMarked = next.pieces.find(piece => piece.instanceId === 'marked') as any
      expect(nextMarked.statusTags).toEqual([])
    })
  })

  it('does not offer Flying Raijin for a negative-stack own-source mark', () => {
    withAtomicProfile(() => {
      const scenario = createMinatoScenario({ statusTags: [{
        id: 'mark-minato-negative', type: 'flying-raijin-mark', name: '飞雷神', visible: true,
        currentDuration: 4, currentUses: -1, intensity: 1, stacks: -1, sourceId: 'minato',
      }] })
      const runtime = new RuleRuntime({ rootSeed: 594 })
      const next = runMinatoChoice(scenario.state, minatoTargetedAction(scenario.state), 'none', runtime)
      expect(next.pendingOptionSelection).toBeUndefined()
      expect(next.pendingTargetSelection).toBeUndefined()
      expect((next.pieces.find(piece => piece.instanceId === 'minato') as any).x).toBe(1)
      expect((next.pieces.find(piece => piece.instanceId === 'minato') as any).y).toBe(1)
      expect(runtime.getCursor(RANDOM_STREAM_NAMES.skillEffect)).toBe(0)
    })
  })

  it.each([
    ['minato', 'zero-hp'], ['marked', 'zero-hp'], ['source', 'zero-hp'],
    ['minato', 'removed'], ['marked', 'removed'], ['source', 'removed'],
  ] as const)('skips Flying Raijin for an invalid %s (%s) while independent player effects continue', (invalidRole, invalidState) => {
    const scenario = createMinatoScenario({ markedOwnerPlayerId: invalidRole === 'source' ? 'player-red' : 'player-blue' })
    const source = asPieceInstance(makePiece({ instanceId: 'event-source', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 1, currentHp: 20, maxHp: 20 }))
    scenario.state.pieces.push(source)
    const invalid = invalidRole === 'source' ? source : scenario[invalidRole]
    if (invalidState === 'zero-hp') invalid.currentHp = 0
    else scenario.state.pieces = scenario.state.pieces.filter(piece => piece.instanceId !== invalid.instanceId)

    const baseGraph = buildAtomicMinatoFlyingRaijinRuleGraph()
    // This player operation is independent of the invalid piece. It must run
    // even when a relation query makes its dependent branch invalid.
    const graph: typeof baseGraph = { ...baseGraph, body: [
      ...baseGraph.body.slice(0, -1),
      { kind: 'call', id: 'independent-owner', module: 'ref.player', version: '1' },
      {
        kind: 'call', id: 'independent-player-effect', module: 'extension.declare-player', version: '1',
        inputs: { owner: { kind: 'output', node: 'independent-owner', port: 'player' }, value: { kind: 'literal', value: 1 } },
        parameters: { namespace: 'guard-regression', name: 'continued', valueType: 'number' },
      },
      ...baseGraph.body.slice(-1),
    ] }
    const context = { type: 'beforeSkillUse', ruleId: 'rule-minato-flying-raijin-trigger', rulePiece: scenario.minato,
      sourcePiece: source, targetPiece: scenario.marked, playerId: 'player-red', skillId: 'fireball' }
    const flow = createFlowRuntime(scenario.state, context, 'rule', {})
    const runtime = new RuleRuntime({ rootSeed: 594 })
    const code = compileGameplayModuleGraph(graph, GAMEPLAY_MODULE_REGISTRY).code
    const result = withRuleRuntime(runtime, () => Function('context', 'flow', 'battle', code)(context, flow, scenario.state))
    expect(result).toEqual({ success: false })
    expect(flow.extension.readValue('player', 'player-red', 'guard-regression', 'continued', '', 'number', [])).toBe(1)
    expect(scenario.state.pendingOptionSelection).toBeUndefined()
    expect(scenario.minato.x).toBe(1)
    expect(scenario.minato.y).toBe(1)
    expect(scenario.minato.attack).toBe(8)
    expect(runtime.getCursor(RANDOM_STREAM_NAMES.skillEffect)).toBe(0)
  })

  it('still triggers the marked-enemy branch after the action source dies in an earlier host trigger', () => {
    withAtomicProfile(() => {
      const scenario = createMinatoScenario()
      const attacker = makePiece({
        instanceId: 'attacker', templateId: 'red-attacker', name: '施法者', ownerPlayerId: 'player-red', faction: 'red',
        x: 4, y: 1, currentHp: 30, maxHp: 30, attack: 10,
        skills: [{ skillId: 'fireball', currentCooldown: 0, usesRemaining: -1 }],
      }) as any
      attacker.name = '施法者'
      scenario.state.pieces.push(attacker)
      scenario.state.skillsById.fireball = generatedEntry('skills/fireball', buildAtomicFireballGraph()) as any
      const killSource: TriggerRule = {
        id: 'test-kill-source-before-minato', name: 'test kill source', description: 'Kills the action source before the Flying Raijin rule runs.',
        priority: 1000, trigger: { type: 'beforeSkillUse' },
        effect: (_battle, context) => {
          if (context.sourcePiece?.instanceId !== 'attacker') return { success: false, messages: [], blocked: false }
          context.sourcePiece.currentHp = 0
          return { success: false, messages: [], blocked: false }
        },
      }
      const root: BattleAction = {
        type: 'useBasicSkill', playerId: 'player-red', pieceId: 'attacker', skillId: 'fireball', targetPieceId: 'marked',
      }
      return restoreGlobalRules(() => {
        globalTriggerSystem.addRule(killSource)
        let sawOptionPrompt = false
        const next = runAuthoritativeAction(scenario.state, root, (kind, pending) => {
          if (kind === 'option') {
            sawOptionPrompt = true
            expect(pending.options).toEqual(expect.arrayContaining([
              expect.objectContaining({ value: 'yes' }), expect.objectContaining({ value: 'no' }),
            ]))
            return 'yes'
          }
          return { pieceId: 'marked' }
        })
        expect(sawOptionPrompt).toBe(true)
        expect(next.pieces.find(piece => piece.instanceId === 'attacker')?.currentHp).toBe(0)
        expect(next.pieces.find(piece => piece.instanceId === 'marked')?.currentHp).toBeLessThan(50)
        const nextMinato = next.pieces.find(piece => piece.instanceId === 'minato') as any
        expect(nextMinato.x === 1 && nextMinato.y === 1).toBe(false)
        return next
      })
    })
  })
})
