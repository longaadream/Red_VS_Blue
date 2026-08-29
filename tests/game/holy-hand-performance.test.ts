/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored skills expose dynamic runtime fields. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hashStable } from '@/lib/game/battle-runner'
import { loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { applyBattleAction } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

const priorRules = [...globalTriggerSystem.getRules()]
const WARMUP_RUNS = 5
const SAMPLE_RUNS = 25

beforeAll(() => globalTriggerSystem.clearRules())
afterAll(() => {
  globalTriggerSystem.clearRules()
  globalTriggerSystem.addRules(priorRules)
})

function loadSkill(id: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'data', 'skills', `${id}.json`), 'utf8'))
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  const percentile = (quantile: number) => sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  ] ?? 0
  const round = (value: number) => Math.round(value * 1_000) / 1_000
  return {
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1) ?? 0),
  }
}

function sampleHotAction(run: () => unknown) {
  for (let index = 0; index < WARMUP_RUNS; index += 1) run()
  return summarize(Array.from({ length: SAMPLE_RUNS }, () => {
    const startedAt = performance.now()
    run()
    return performance.now() - startedAt
  }))
}

describe('RED-121 synchronous interaction performance', () => {
  it('keeps Muru pending resume and the holy trio turn start below 100ms p95', () => {
    const lament = loadSkill('muru-lament')
    const liadrin = makePiece({
      instanceId: 'perf-liadrin',
      templateId: 'liadrin',
      ownerPlayerId: 'player-red',
      x: 0,
      y: 0,
    }) as any
    liadrin.skills = [{ skillId: lament.id, currentCooldown: 0, usesRemaining: -1 }]
    liadrin.rules = [loadRuleById('rule-blood-echo', true)!]

    const velen = makePiece({
      instanceId: 'perf-velen',
      templateId: 'velen',
      ownerPlayerId: 'player-red',
      x: 1,
      y: 0,
    }) as any
    velen.rules = [
      loadRuleById('rule-velen-delayed-effects', true)!,
      loadRuleById('rule-velen-death-cleanup', true)!,
    ]

    const turalyon = makePiece({
      instanceId: 'perf-turalyon',
      templateId: 'turalyon',
      ownerPlayerId: 'player-red',
      x: 2,
      y: 0,
    }) as any
    turalyon.rules = [loadRuleById('rule-turalyon-lightforged-march', true)!]

    const enemy = makePiece({
      instanceId: 'perf-enemy',
      ownerPlayerId: 'player-blue',
      faction: 'blue',
      x: 4,
      y: 0,
      currentHp: 30,
      maxHp: 30,
    }) as any

    const state = makeState({
      pieces: [liadrin, velen, turalyon, enemy],
      currentPlayerId: 'player-red',
      phase: 'action',
      turnNumber: 2,
    }) as any
    state.skillsById[lament.id] = lament
    state.players[0].actionPoints = 3
    state.players[0].chargePoints = 3
    state.players[0].hand = ['holy-smite', 'holy-heal', 'holy-charge'].map((cardId, index) => ({
      cardId,
      instanceId: `perf-holy-${index}`,
      ownerPlayerId: 'player-red',
    }))

    const pending = applyBattleAction(state, {
      type: 'useChargeSkill',
      playerId: 'player-red',
      pieceId: liadrin.instanceId,
      skillId: lament.id,
    } as any) as any
    const selectedOption = pending.pendingOptionSelection.options.map((option: any) => option.value)
    const resumeAction = {
      type: 'pendingOptionSelect',
      playerId: 'player-red',
      selectedOption,
      selectionId: pending.pendingOptionSelection.selectionId,
      stateRevision: pending.pendingOptionSelection.stateRevision,
    } as any
    const pendingHash = hashStable(pending)
    const resumeTiming = sampleHotAction(() => applyBattleAction(pending, resumeAction))
    expect(hashStable(pending)).toBe(pendingHash)

    const turnStartState = JSON.parse(JSON.stringify(state)) as any
    turnStartState.turn.phase = 'start'
    turnStartState.gameStartFired = true
    turnStartState.players[0].hand[0].contentState = {
      velenHolyProphecy: {
        sourcePieceId: velen.instanceId,
        createdTurnNumber: 1,
      },
    }
    const turnStartHash = hashStable(turnStartState)
    const turnStartTiming = sampleHotAction(() => applyBattleAction(turnStartState, {
      type: 'beginPhase',
    } as any))
    expect(hashStable(turnStartState)).toBe(turnStartHash)

    console.info(`RED121_SYNC_PERF ${JSON.stringify({ resumeTiming, turnStartTiming })}`)
    expect(resumeTiming.p95).toBeLessThanOrEqual(100)
    expect(turnStartTiming.p95).toBeLessThanOrEqual(100)
  })
})
