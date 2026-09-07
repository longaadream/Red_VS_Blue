/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic authority graphs test search independently of rules. */
import { describe, expect, it } from 'vitest'
import { planShortSearchAction, selectShortSearchCandidates } from '@/lib/game/ai-short-search'
import type { AIEnvironment, AIObservation, CandidateAction } from '@/lib/game/ai-types'
import { makePiece, makeState } from '../helpers/minimal-state'

const candidate = (id: string, kind: CandidateAction['kind'] = 'basic-skill', actor = 'red') => ({
  id, kind, protocolVersion: 1,
  action: kind === 'end-turn' ? { type: 'endTurn', playerId: 'player-red' }
    : { type: 'useBasicSkill', playerId: 'player-red', pieceId: actor, skillId: id },
}) as CandidateAction

function graph(options: { rejected?: boolean; blocked?: boolean; foreign?: boolean; delay?: () => void } = {}) {
  const state = makeState({ pieces: [makePiece({ instanceId: 'red' }),
    makePiece({ instanceId: 'blue', ownerPlayerId: 'player-blue', faction: 'blue' })] })
  const stage = (s: typeof state) => Number(s.extensions?.stage ?? 0)
  const end = candidate('end', 'end-turn')
  const observe = (s: typeof state): AIObservation => ({ ...s, playerId: 'player-red', protocolVersion: 1,
    stateRevision: stage(s), players: s.players as any, pieces: s.pieces as any, graveyard: [],
  }) as AIObservation
  const environment: AIEnvironment = {
    protocolVersion: 1,
    capabilities: { protocolVersion: 1, supportedActionTypes: [], unsupportedActionTypes: [] },
    observe, stateKey: s => JSON.stringify(s), isTerminal: s => !!s.terminalResult,
    listLegalActions: s => stage(s) === 0 ? [end, candidate('setup', 'move'), candidate('small')]
      : stage(s) === 1 ? [end, candidate('finish', 'basic-skill', 'second-actor')] : [end],
    simulate: (s, input) => {
      options.delay?.()
      const c = input as CandidateAction
      const next = structuredClone(s)
      const result: any = { protocolVersion: 1, accepted: true, state: next,
        stateHash: '', transitionHash: '', trace: { actionLog: [], stateChanges: [] } }
      if (c.id === 'setup') {
        if (options.rejected) return { ...result, accepted: false, error: { code: 'REJECTED' } }
        if (options.blocked) return { ...result, trace: { ...result.trace, blocked: true } }
        next.extensions!.stage = 1
        next.pieces[0].currentHp -= 10
        if (options.foreign) (next as any).pendingTargetSelection = { playerId: 'player-blue' }
      } else if (c.id === 'finish') {
        next.extensions!.stage = 2
        next.pieces[1].currentHp = 0
        ;(next as any).terminalResult = { status: 'finished', winnerPlayerId: 'player-red' }
      } else if (c.id === 'small') { next.extensions!.stage = 3; next.pieces[1].currentHp -= 5 }
      else { next.turn.currentPlayerId = 'player-blue'; next.turn.phase = 'action' }
      return result
    },
  }
  const evaluate = (o: AIObservation) => o.pieces[0].currentHp - o.pieces[1].currentHp
  return { state, environment, evaluate }
}
const deterministic = { turnTimeMs: 0, decisionTimeMs: 0, deploymentTimeMs: 0 }

describe('short-search bounded planning', () => {
  it('scores public deployment alternatives beyond the ordinary root shortlist', () => {
    const f = graph()
    const legal = Array.from({ length: 48 }, (_, i) => ({
      ...candidate(`deploy-${String(i).padStart(2, '0')}`, 'reserve-deployment'),
      action: { type: 'deployReservePiece', playerId: 'player-red', pieceId: 'reserve',
        expectedDeploymentRevision: 1, toX: i, toY: 0 },
    } as CandidateAction))
    const baseSimulate = f.environment.simulate
    f.environment.listLegalActions = s => s.extensions?.stage ? [candidate('end', 'end-turn')] : legal
    f.environment.simulate = (s, input, context) => {
      const c = input as CandidateAction
      const result = baseSimulate(s, candidate('small'), context)
      if (result.accepted) {
        result.state.pieces[1].currentHp = c.id === 'deploy-30' ? 1 : 90
        result.state.extensions!.deploymentChoice = c.id
      }
      return result
    }
    const decision = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(decision.nextAction?.id).toBe('deploy-30')
    expect(decision.trace.filter(t => t.depth === 0 && t.reason === 'evaluated')).toHaveLength(48)
    expect(decision.sequence).toHaveLength(1)
    const capped = planShortSearchAction(f.state, 'player-red', 1, { ...f,
      config: { ...deterministic, deploymentNodesPerDecision: 10 } })
    expect(capped.nodes).toBe(10)
    expect(capped.trace.filter(t => t.reason === 'candidate-limit')).toHaveLength(38)
    const cumulative = planShortSearchAction(f.state, 'player-red', 1, { ...f,
      config: { ...deterministic, nodesPerTurn: 50 }, continuation: decision.continuation })
    expect(cumulative.nodes).toBe(2)
    expect(cumulative.stopReason).toBe('node-budget')
    let clock = 0
    const timedSimulate = f.environment.simulate
    f.environment.simulate = (...args) => { clock += 100; return timedSimulate(...args) }
    const timed = planShortSearchAction(f.state, 'player-red', 1, { ...f, now: () => clock,
      config: { turnTimeMs: 300, deploymentTimeMs: 1000 } })
    expect(timed.nodes).toBe(3)
    expect(timed.continuation.elapsedMs).toBe(300)
    expect(timed.stopReason).toBe('time-budget')
    const deploymentTimed = planShortSearchAction(f.state, 'player-red', 1, { ...f, now: () => clock,
      config: { turnTimeMs: 1000, decisionTimeMs: 900, deploymentTimeMs: 200 } })
    expect(deploymentTimed.nodes).toBe(2)
    expect(deploymentTimed.elapsedMs).toBe(200)
  })

  it('keeps a losing setup and finds a cross-actor win which depth-one greed misses', () => {
    const f = graph()
    const before = JSON.stringify(f.state)
    const greedy = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: { ...deterministic, depth: 1 } })
    const search = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(greedy.nextAction?.id).toBe('small')
    expect(search.sequence.map(c => c.id)).toEqual(['setup', 'finish'])
    expect(JSON.stringify(f.state)).toBe(before)
    const again = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(again.trace).toEqual(search.trace)
  })

  it.each(['blocked', 'rejected'] as const)('does not extend %s candidates', mode => {
    const f = graph({ [mode]: true })
    const result = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(result.nextAction?.id).toBe('small')
    expect(result.trace.find(t => t.candidateId === 'setup')?.reason).toBe(mode)
  })

  it('does not guess an opposing pending response or search through it', () => {
    const f = graph({ foreign: true })
    const result = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(result.trace.some(t => t.candidateId === 'finish')).toBe(false)
    const paused = f.environment.simulate(f.state, candidate('setup', 'move')).state
    expect(planShortSearchAction(paused, 'player-red', 1, { ...f }).stopReason).toBe('other-player')
  })

  it('discards an exact self-loop without expanding it or consuming the whole budget', () => {
    const f = graph()
    const simulate = f.environment.simulate
    f.environment.simulate = (s, input, context) => {
      const result = simulate(s, input, context)
      return (input as CandidateAction).id === 'setup' && result.accepted
        ? { ...result, state: structuredClone(s) } : result
    }
    const decision = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(decision.trace.find(t => t.candidateId === 'setup')?.reason).toBe('duplicate')
    expect(decision.trace.some(t => t.candidateId === 'finish')).toBe(false)
    expect(decision.nextAction?.id).toBe('small')
    expect(decision.nodes).toBeLessThan(10)
  })

  it('accounts for time and nodes across replans and resets only on a new turn', () => {
    let clock = 0
    const f = graph({ delay: () => { clock += 100 } })
    const options = { ...f, now: () => clock, config: { decisionTimeMs: 0, turnTimeMs: 200 } }
    const first = planShortSearchAction(f.state, 'player-red', 1, options)
    expect(first.nodes).toBe(2)
    expect(first.stopReason).toBe('time-budget')
    const second = planShortSearchAction(f.state, 'player-red', 1, { ...options, continuation: first.continuation })
    expect(second.nodes).toBe(0)
    expect(second.nextAction?.kind).toBe('end-turn')
    expect(second.continuation.elapsedMs).toBe(200)
    const newTurn = structuredClone(f.state)
    newTurn.turn.turnNumber++
    expect(planShortSearchAction(newTurn, 'player-red', 1, { ...options, continuation: first.continuation }).nodes).toBe(2)
  })

  it('reports indivisible simulation overruns instead of claiming a hard deadline', () => {
    let clock = 0
    const f = graph({ delay: () => { clock += 300 } })
    const result = planShortSearchAction(f.state, 'player-red', 1, { ...f, now: () => clock,
      config: { turnTimeMs: 200, decisionTimeMs: 0 } })
    expect(result.elapsedMs).toBe(300)
    expect(result.overTurnBudget).toBe(true)
  })

  it('enforces cumulative node and authority-accepted action budgets', () => {
    const f = graph()
    const first = planShortSearchAction(f.state, 'player-red', 1, { ...f,
      config: { ...deterministic, nodesPerTurn: 2 } })
    const next = planShortSearchAction(f.state, 'player-red', 1, { ...f,
      config: { ...deterministic, nodesPerTurn: 2 }, continuation: first.continuation })
    expect(next.nodes).toBe(0)
    expect(next.stopReason).toBe('node-budget')
    expect(planShortSearchAction(f.state, 'player-red', 1, { ...f, actionsTakenThisTurn: 7 }).stopReason).toBe('action-budget')
  })

  it('preserves move and actor alternatives when one actor has many skills', () => {
    const f = graph()
    const legal = [...Array.from({ length: 50 }, (_, i) => candidate(`spell-${i}`)),
      candidate('step', 'move', 'other'), candidate('end', 'end-turn')]
    // Width is deliberately small; later skill IDs must not hide the only movement family.
    const selected = selectShortSearchCandidates(legal, f.environment.observe(f.state, 'player-red'), 5)
    expect(selected.some(c => c.id === 'step')).toBe(true)
  })

  it('throws on invalid configuration and non-finite scoring', () => {
    const f = graph()
    expect(() => planShortSearchAction(f.state, 'player-red', 1, { ...f, config: { depth: 0 } })).toThrow()
    expect(() => planShortSearchAction(f.state, 'player-red', 1, { ...f, evaluate: () => NaN })).toThrow()
  })

  it('keeps low-score movement in the beam even among six higher-score spell families', () => {
    const f = graph()
    const baseList = f.environment.listLegalActions
    const baseSimulate = f.environment.simulate
    f.environment.listLegalActions = (s, p) => s.extensions?.stage ? baseList(s, p)
      : [candidate('end', 'end-turn'), candidate('setup', 'move'), ...Array.from({ length: 6 }, (_, i) => candidate(`bait-${i}`))]
    f.environment.simulate = (s, input, context) => {
      const c = input as CandidateAction
      return baseSimulate(s, c.id.startsWith('bait-') ? { ...c, id: 'small' } : c, context)
    }
    expect(planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic }).nextAction?.id).toBe('setup')
  })

  it('does not inspect random fallback deployment outcomes', () => {
    const f = graph()
    f.environment.listLegalActions = () => [{ ...candidate('reserve', 'reserve-deployment'), action: {
      type: 'deployReservePiece', playerId: 'player-red', pieceId: 'reserve', expectedDeploymentRevision: 1,
    } }]
    f.environment.simulate = () => { throw new Error('Hidden random landing must not be sampled') }
    const decision = planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic })
    expect(decision.stopReason).toBe('random-boundary')
    expect(decision.nodes).toBe(0)
    expect(decision.nextAction?.id).toBe('reserve')
  })

  it('reserves movement even when basic skills, charge skills and cards all score higher', () => {
    const f = graph()
    const baseList = f.environment.listLegalActions
    const baseSimulate = f.environment.simulate
    f.environment.listLegalActions = (s, p) => s.extensions?.stage ? baseList(s, p)
      : [candidate('end', 'end-turn'), candidate('setup', 'move'),
        ...(['basic-skill', 'charge-skill', 'card'] as const).flatMap(kind => [candidate(`bait-${kind}-a`, kind), candidate(`bait-${kind}-b`, kind)])]
    f.environment.simulate = (s, input, context) => {
      const c = input as CandidateAction
      return baseSimulate(s, c.id.startsWith('bait-') ? { ...c, id: 'small' } : c, context)
    }
    expect(planShortSearchAction(f.state, 'player-red', 1, { ...f, config: deterministic }).nextAction?.id).toBe('setup')
  })
})
