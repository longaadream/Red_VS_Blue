import { aiEnvironmentV1 } from './ai-environment'
import { hashStable, stableJson } from './battle-trace'
import { chooseAiTurnGoal, evaluateAiTransition } from './ai-evaluator'
import { resolveAiPlannerConfig } from './ai-profiles'
import type { AIEnvironment, AiPlannerConfig, AiPlannerTraceEntry, AiTurnGoal, AiTurnPlan, CandidateAction } from './ai-types'
import type { BattleState } from './turn'

type Node = { state: BattleState; actions: CandidateAction[]; score: number }
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const actionKey = (action: CandidateAction) => stableJson(action.action)

/** Generic, isolated beam planner. It never submits actions; callers must re-run it after every authority result. */
export function planAiTurn(state: BattleState, playerId: string, rootSeed: number, options: {
  config?: Partial<Omit<AiPlannerConfig, 'version' | 'weights'>> & { weights?: Record<string, number> }
  previousGoal?: AiTurnGoal
  environment?: AIEnvironment
} = {}): AiTurnPlan {
  const environment = options.environment || aiEnvironmentV1
  const config = resolveAiPlannerConfig(options.config)
  const goal = chooseAiTurnGoal(state, playerId, options.previousGoal)
  const traces: AiPlannerTraceEntry[] = []
  const initialKey = environment.stateKey(state, { kind: 'full' })
  const seen = new Set([initialKey])
  let duplicates = 0
  let nodesVisited = 0
  let beam: Node[] = [{ state, actions: [], score: 0 }]
  let best: Node | undefined

  for (let depth = 0; depth < config.maxActions && beam.length && nodesVisited < config.nodeBudget; depth += 1) {
    const next: Node[] = []
    for (const node of beam) {
      const legal = environment.listLegalActions(node.state, playerId)
      const ordered = legal.slice().sort((a, b) => compareText(actionKey(a), actionKey(b)))
      const endTurn = ordered.filter(item => item.kind === 'end-turn')
      const searchable = ordered.filter(item => item.kind !== 'end-turn')
      const selected = searchable.slice(0, config.candidateLimit).concat(endTurn)
      for (const skipped of searchable.slice(config.candidateLimit)) {
        traces.push({ candidateId: skipped.id, action: skipped.action, score: { total: 0, components: {} }, pruned: 'candidate-limit' })
      }
      for (const candidate of selected) {
        if (nodesVisited >= config.nodeBudget) break
        nodesVisited += 1
        const transition = environment.simulate(node.state, candidate, { rootSeed })
        if (!transition.accepted) {
          traces.push({ candidateId: candidate.id, action: candidate.action, score: { total: 0, components: {} }, rejected: transition.error.code })
          continue
        }
        const score = evaluateAiTransition(node.state, transition.state, playerId, goal, config, candidate.kind === 'end-turn')
        const key = environment.stateKey(transition.state, { kind: 'full' })
        if (seen.has(key) && candidate.kind !== 'end-turn') {
          duplicates += 1
          traces.push({ candidateId: candidate.id, action: candidate.action, score, pruned: 'duplicate-state' })
          continue
        }
        seen.add(key)
        traces.push({ candidateId: candidate.id, action: candidate.action, score })
        const child = { state: transition.state, actions: [...node.actions, candidate], score: node.score + score.total }
        next.push(child)
        if (!best || child.score > best.score || (child.score === best.score && compareText(stableJson(child.actions.map(action => action.action)), stableJson(best.actions.map(action => action.action))) < 0)) best = child
      }
    }
    beam = next.sort((a, b) => b.score - a.score || compareText(stableJson(a.actions.map(action => action.action)), stableJson(b.actions.map(action => action.action)))).slice(0, config.beamWidth)
    if (best?.actions.at(-1)?.kind === 'end-turn') break
  }

  const fallback = environment.listLegalActions(state, playerId).find(action => action.kind === 'end-turn')
  const actions = best?.actions.length ? best.actions : fallback ? [fallback] : []
  if (!actions.length) throw new Error(`AI planner has no legal endTurn fallback for player ${playerId}`)
  return { configVersion: config.version, goal, actions, nextAction: actions[0], nodesVisited, stateDuplicates: duplicates, trace: traces }
}

/** Replanning boundary for authoritative callers: pass the newly returned state, never a queued action list. */
export function planNextAiAction(state: BattleState, playerId: string, rootSeed: number, previousGoal?: AiTurnGoal): AiTurnPlan {
  return planAiTurn(state, playerId, rootSeed, { previousGoal })
}

export function aiPlanTraceHash(plan: AiTurnPlan): string {
  return hashStable({ goal: plan.goal, actions: plan.actions.map(action => action.action), nodesVisited: plan.nodesVisited, stateDuplicates: plan.stateDuplicates, trace: plan.trace })
}
