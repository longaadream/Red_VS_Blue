import { afterEach, describe, expect, it } from 'vitest'

import { hashBattleState } from '@/lib/game/battle-runner'
import {
  assertContentGraphParity,
  executeBattleActionForContentGraphParity,
  runContentGraphParity,
  type ContentGraphParityOptions,
} from './helpers/content-graph-parity'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { prepareAction } from '@/lib/game/targeting'
import { makePiece, makeState } from '../helpers/minimal-state'
import { safeCloneBattleState } from '@/lib/game/turn'

const SEED = 0x2520_001
const SKILL_ID = 'red252-parity-fixture'

type FixtureContent = {
  code: string
  fingerprint: string
}

const DAMAGE_CODE = (damage: string, message: string) => `
function executeSkill(context) {
  var target = selectTarget({ type: 'piece', range: 1, filter: 'enemy' });
  if (!target || target.needsTargetSelection) return target;
  var roll = Math.floor(Math.random() * 2);
  context.battle.extensions.parityRoll = roll;
  var result = dealDamage(context.piece, target, ${damage} + roll, 'true', context.battle, context.skill.id);
  return { success: true, message: '${message} ' + result.damage };
}`

const PENDING_CODE = (canCancel: boolean) => `
function executeSkill() {
  return {
    success: true,
    message: 'pending fixture',
    pendingTargetSelection: {
      playerId: 'player-red',
      targetType: 'cell',
      range: 1,
      filter: 'all',
      canCancel: ${canCancel}
    }
  };
}`

const RNG_CODE = (reads: number) => `
function executeSkill() {
  ${Array.from({ length: reads }, () => 'flow.query.random([0, 1]);').join('\n  ')}
  return { success: true, message: 'rng fixture' };
}`

function content(code: string, fingerprint = code): FixtureContent {
  return { code, fingerprint }
}

function makeFixtureState(definition: FixtureContent, pending = false): BattleState {
  const caster = makePiece({
    instanceId: 'parity-caster',
    name: 'Parity caster',
    x: 0,
    y: 0,
    attack: 4,
    actionPoints: 5,
    skills: [{ skillId: SKILL_ID, currentCooldown: 0, usesRemaining: -1 }],
  })
  const target = makePiece({
    instanceId: 'parity-target',
    name: 'Parity target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: 20,
    maxHp: 20,
  })
  const state = makeState({
    pieces: [caster, target],
    currentPlayerId: 'player-red',
    phase: 'action',
    width: 4,
    height: 3,
  })
  state.players[0].actionPoints = 5
  state.skillsById[SKILL_ID] = {
    id: SKILL_ID,
    name: 'RED-252 parity fixture',
    description: 'A real SkillCode fixture used by the differential harness.',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: pending ? 'self' : 'single',
    requiresTarget: !pending,
    code: definition.code,
  }
  return state
}

function makeAction(state: BattleState, withTarget = true): BattleAction {
  const draft: BattleAction = {
    type: 'useBasicSkill',
    playerId: 'player-red',
    pieceId: 'parity-caster',
    skillId: SKILL_ID,
    ...(withTarget ? { targetPieceId: 'parity-target' } : {}),
  }
  if (!withTarget) return draft
  const preparation = prepareAction(state, {
    type: draft.type,
    playerId: draft.playerId,
    pieceId: draft.pieceId,
    skillId: draft.skillId,
  })
  if (preparation.kind !== 'needTarget') {
    throw new Error(`Expected target preparation, received ${preparation.kind}`)
  }
  return {
    ...draft,
    selectionId: preparation.selectionId,
    stateRevision: preparation.stateRevision,
  }
}

function parityOptions(
  legacy: FixtureContent,
  graph: FixtureContent,
  action: BattleAction,
  pending = false,
): ContentGraphParityOptions<FixtureContent, FixtureContent> {
  return {
    seed: SEED,
    actions: [action],
    initialState: () => makeFixtureState(legacy, pending),
    viewers: ['player-red', 'player-blue', undefined],
    legacy: {
      name: 'legacy-skillcode',
      content: legacy,
      createInitialState: value => makeFixtureState(value, pending),
      execute: input => executeBattleActionForContentGraphParity(input),
    },
    graph: {
      name: 'graph-skillcode',
      content: graph,
      createInitialState: value => makeFixtureState(value, pending),
      execute: input => executeBattleActionForContentGraphParity(input),
    },
  }
}

function projectRuntimeState(state: BattleState): BattleState {
  const projected = safeCloneBattleState(state)
  Reflect.deleteProperty(projected, 'skillsById')
  return projected
}

afterEach(() => globalTriggerSystem.clearRules())

describe('RED-252 content graph behavior parity harness', () => {
  it('passes identical source through the real engine and captures every parity channel', async () => {
    const source = content(DAMAGE_CODE('2', 'parity strike'))
    const sourceState = makeFixtureState(source)
    const action = makeAction(sourceState)
    const report = await assertContentGraphParity(parityOptions(source, source, action))

    expect(report.equal).toBe(true)
    expect(report.steps).toHaveLength(1)
    const step = report.steps[0]
    expect(step.legacy.stateHash).toBe(step.graph.stateHash)
    expect(step.legacy.random).toEqual(step.graph.random)
    expect(step.legacy.actionLog).toEqual(step.graph.actionLog)
    expect(step.legacy.presentationEvents).toEqual(step.graph.presentationEvents)
    expect(step.legacy.pending).toEqual(step.graph.pending)
    expect(step.legacy.viewerProjections).toEqual(step.graph.viewerProjections)
    expect(step.legacy.presentationEvents?.some(event => (event as { kind?: string }).kind === 'damage')).toBe(true)
  })

  it('reports a real damage/state and presentation mismatch', async () => {
    const legacy = content(DAMAGE_CODE('2', 'parity strike'))
    const graph = content(DAMAGE_CODE('3', 'parity strike'))
    const action = makeAction(makeFixtureState(legacy))
    const report = await runContentGraphParity(parityOptions(legacy, graph, action))
    const categories = report.steps[0].differences.map(difference => difference.category)

    expect(report.equal).toBe(false)
    expect(categories).toContain('state')
    expect(categories).toContain('stateHash')
    expect(categories).toContain('presentationEvents')
    expect(report.content.difference?.category).toBe('content')
    await expect(assertContentGraphParity(parityOptions(legacy, graph, action)))
      .rejects.toThrow(/RED-252.*parity mismatch/i)
  })

  it('reports an action log mismatch even when state effects remain equal', async () => {
    const legacy = content(DAMAGE_CODE('2', 'legacy message'))
    const graph = content(DAMAGE_CODE('2', 'graph message'))
    const action = makeAction(makeFixtureState(legacy))
    const report = await runContentGraphParity(parityOptions(legacy, graph, action))

    expect(report.steps[0].differences.map(difference => difference.category)).toContain('actionLog')
    expect((report.steps[0].legacy.state as BattleState).pieces)
      .toEqual((report.steps[0].graph.state as BattleState).pieces)
  })

  it('reports a pending session mismatch without normalizing cancellation semantics', async () => {
    const legacy = content(PENDING_CODE(true))
    const graph = content(PENDING_CODE(false))
    const legacyState = makeFixtureState(legacy, true)
    const action = makeAction(legacyState, false)
    const report = await runContentGraphParity(parityOptions(legacy, graph, action, true))
    const pendingDifference = report.steps[0].differences.find(difference => difference.category === 'pending')

    expect(pendingDifference).toBeDefined()
    expect(pendingDifference?.path).toContain('target.canCancel')
    expect(report.steps[0].legacy.pending).not.toEqual(report.steps[0].graph.pending)
    expect(report.steps[0].differences.map(difference => difference.category)).toContain('viewer:player-red')
  })

  it('reports random stream cursor consumption from the real SkillCode runtime', async () => {
    const legacy = content(RNG_CODE(1))
    const graph = content(RNG_CODE(2))
    const action = makeAction(makeFixtureState(legacy, true), false)
    const options = parityOptions(legacy, graph, action, true)
    const report = await runContentGraphParity({
      ...options,
      projectState: state => projectRuntimeState(state),
      projectStateHash: state => hashBattleState(projectRuntimeState(state)),
    })
    const differences = report.steps[0].differences

    expect(differences.map(difference => difference.category)).toContain('random')
    expect(report.steps[0].legacy.random).not.toEqual(report.steps[0].graph.random)
  })
})
