import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { prepareAction } from '@/lib/game/targeting'
import { previewBattleAction } from '@/lib/game/skill-preview'
import type { SkillDefinition } from '@/lib/game/skills'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { asPieceInstance, makePiece, makeState } from '../helpers/minimal-state'

const SAMPLE_COUNT = 30

function canonicalSkill(id: string): SkillDefinition {
  return JSON.parse(readFileSync(`data/skills/${id}.json`, 'utf8')) as SkillDefinition
}

function fixtureState(skillId: string): BattleState {
  const source = asPieceInstance(makePiece({
    instanceId: 'source',
    templateId: 'test-source',
    name: 'Source',
    ownerPlayerId: 'player-red',
    faction: 'red',
    x: 0,
    y: 0,
    attack: 3,
    skills: [{ skillId, currentCooldown: 0, usesRemaining: -1 }],
  }))
  const target = asPieceInstance(makePiece({
    instanceId: 'target',
    templateId: 'test-target',
    name: 'Target',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    y: 0,
    currentHp: 12,
    maxHp: 16,
  }))
  const state = makeState({ pieces: [source, target] })
  state.pieces = [source, target]
  state.players.find(player => player.playerId === 'player-red')!.actionPoints = 10
  state.skillsById = { [skillId]: canonicalSkill(skillId) }
  return state
}

function pieceAction(state: BattleState, skillId: string, targetPieceId = 'target'): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'source',
    skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${prepared.kind}`)
  return {
    ...draft,
    targetPieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function cellAction(state: BattleState, skillId: string, targetX: number, targetY: number): BattleAction {
  const draft = {
    type: 'useBasicSkill' as const,
    playerId: 'player-red',
    pieceId: 'source',
    skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget') throw new Error(`expected needTarget, got ${prepared.kind}`)
  return {
    ...draft,
    targetX,
    targetY,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function attackCase(): { state: BattleState; action: BattleAction } {
  const state = fixtureState('venom-claw-rend')
  return { state, action: pieceAction(state, 'venom-claw-rend') }
}

function healCase(): { state: BattleState; action: BattleAction } {
  const state = fixtureState('light-of-the-light')
  const target = state.pieces.find(piece => piece.instanceId === 'target')!
  target.ownerPlayerId = 'player-red'
  target.faction = 'red'
  target.currentHp = 5
  return { state, action: pieceAction(state, 'light-of-the-light') }
}

function movementCase(): { state: BattleState; action: BattleAction } {
  const state = fixtureState('blink')
  return { state, action: cellAction(state, 'blink', 2, 0) }
}

function visiblePassiveCase(): { state: BattleState; action: BattleAction } {
  const state = fixtureState('venom-claw-rend')
  const target = state.pieces.find(piece => piece.instanceId === 'target')!
  target.statusTags = [{
    id: 'divine-shield',
    type: 'divine-shield',
    visible: true,
    currentDuration: -1,
    currentUses: -1,
    intensity: 1,
    stacks: 1,
    relatedRules: ['rule-divine-shield'],
  }]
  target.rules = [{ id: 'rule-divine-shield', public: true } as never]
  return { state, action: pieceAction(state, 'venom-claw-rend') }
}

function ignoredPendingCase(): { state: BattleState; action: BattleAction } {
  const state = fixtureState('venom-claw-rend')
  const target = state.pieces.find(piece => piece.instanceId === 'target')!
  target.statusTags = [{
    id: 'grimm-hunt-status',
    type: 'grimmjow-hunt',
    visible: true,
    relatedRules: ['rule-grimmjow-hunt-after-skill'],
  }]
  target.rules = [{ id: 'rule-grimmjow-hunt-after-skill', public: true } as never]
  return { state, action: pieceAction(state, 'venom-claw-rend') }
}

type BenchmarkCase = {
  name: string
  create: () => { state: BattleState; action: BattleAction }
}

type BenchmarkStats = BenchmarkCase & {
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(sorted.length * percentile))
  return sorted[rank - 1]
}

function runBenchmark(testCase: BenchmarkCase): BenchmarkStats {
  const durations: number[] = []
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const { state, action } = testCase.create()
    const before = structuredClone(state)
    const result = previewBattleAction(state, action, 'player-red')

    expect(result.status, `${testCase.name} sample ${sample + 1}`).toBe('ready')
    expect(state, `${testCase.name} sample ${sample + 1} input mutation`).toEqual(before)
    expect(Number.isFinite(result.durationMs), `${testCase.name} sample ${sample + 1} duration`).toBe(true)
    expect(result.durationMs, `${testCase.name} sample ${sample + 1} duration`).toBeGreaterThanOrEqual(0)
    durations.push(result.durationMs)
  }

  const stats = {
    ...testCase,
    samples: durations.length,
    p50Ms: nearestRank(durations, 0.5),
    p95Ms: nearestRank(durations, 0.95),
    maxMs: Math.max(...durations),
  }
  console.log(
    `[RED-224 Node skill-preview benchmark] ${stats.name}: `
    + `samples=${stats.samples} P50=${stats.p50Ms.toFixed(3)}ms `
    + `P95=${stats.p95Ms.toFixed(3)}ms max=${stats.maxMs.toFixed(3)}ms`,
  )
  return stats
}

describe('RED-224 Node skill-preview performance matrix', () => {
  it('runs 30 ready, non-mutating samples for each canonical preview class', () => {
    const cases: BenchmarkCase[] = [
      { name: 'attack', create: attackCase },
      { name: 'heal', create: healCase },
      { name: 'movement', create: movementCase },
      { name: 'visible-status-passive', create: visiblePassiveCase },
      { name: 'ignored-pending-reaction', create: ignoredPendingCase },
    ]
    const results = cases.map(runBenchmark)

    expect(results).toHaveLength(5)
    expect(results.every(result => result.samples === SAMPLE_COUNT)).toBe(true)
    expect(results.every(result => result.p50Ms >= 0 && result.p95Ms >= result.p50Ms && result.maxMs >= result.p95Ms)).toBe(true)
  })
})
