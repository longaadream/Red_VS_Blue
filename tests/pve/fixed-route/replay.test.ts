import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { listLegalAIActions } from '@/lib/game/ai-environment'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { createFixedRouteSession, type FixedRouteSession, type FixedRouteSnapshot } from '@/lib/pve/fixed-route/session'

const HUMAN = 'adventure-human'
const ENEMY = 'adventure-enemy'
const profile = getServerGameProfileIdentityV1()

type ReplayStep = {
  kind: 'enter' | 'human' | 'enemy' | 'supply' | 'continue'
  revision: number
  action?: BattleAction
  phase: FixedRouteSnapshot['route']['phase']
  node: string
  enemyCoreHp: number
  partyHp: number
}

type ReplaySummary = {
  seed: number
  battles: number
  victories: number
  chapters: number
  steps: number
  finalPhase: FixedRouteSnapshot['route']['phase']
  finalRevision: number
  nativeTerminalResults: Array<BattleState['terminalResult']>
  transcript: ReplayStep[]
}

describe('fixed route native seeded replay', () => {
  it('plays all three chapters through the public session with legal native actions', async () => {
    const seed = 235
    const session = await createFixedRouteSession(profile, seed)
    const requestedMaxBattles = Number(process.env.FIXED_ROUTE_REPLAY_MAX_BATTLES ?? Number.POSITIVE_INFINITY)
    const summary = await replay(session, seed, Number.isFinite(requestedMaxBattles) ? requestedMaxBattles : Number.POSITIVE_INFINITY)

    if (Number.isFinite(requestedMaxBattles)) {
      expect(summary.battles).toBe(requestedMaxBattles)
      expect(summary.finalPhase).toBe('result')
      expect(summary.victories).toBe(requestedMaxBattles)
      return
    }

    expect(summary.finalPhase).toBe('won')
    expect(summary.chapters).toBe(3)
    expect(summary.battles).toBe(12)
    expect(summary.victories).toBe(12)
    expect(summary.nativeTerminalResults).toHaveLength(12)
    expect(summary.nativeTerminalResults.every(result => result?.winnerPlayerId === HUMAN || result?.winnerPlayerIds?.includes(HUMAN))).toBe(true)
    expect(summary.steps).toBeGreaterThan(0)
    expect(summary.transcript.some(step => step.kind === 'enemy')).toBe(true)
    if (process.env.FIXED_ROUTE_REPLAY_EVIDENCE === '1') {
      mkdirSync('output/pve-fixed-route', { recursive: true })
      writeFileSync('output/pve-fixed-route/native-replay.json', JSON.stringify(summary, null, 2) + '\n')
    }

    // Keep a compact deterministic artifact in the test output for QA triage.
    console.info('fixed-route replay', JSON.stringify({
      seed: summary.seed,
      battles: summary.battles,
      chapters: summary.chapters,
      steps: summary.steps,
      finalPhase: summary.finalPhase,
      finalRevision: summary.finalRevision,
      terminalResults: summary.nativeTerminalResults,
    }))
  // This acceptance replay enumerates native legal actions for 12 battles;
  // unlike the focused runtime tests, it can take several minutes on Windows.
  }, 600_000)
})

async function replay(session: FixedRouteSession, seed: number, maxBattles = Number.POSITIVE_INFINITY): Promise<ReplaySummary> {
  let snapshot = session.snapshot()
  const transcript: ReplayStep[] = []
  const nativeTerminalResults: Array<BattleState['terminalResult']> = []
  let battles = 0
  let victories = 0
  let actionCount = 0
  const seenBattleIds = new Set<string>()
  const recordedTerminalBattleIds = new Set<string>()

  for (let guard = 0; guard < 20_000; guard += 1) {
    if (snapshot.route.phase === 'won') break
    if (snapshot.route.phase === 'lost') {
      throw new Error(`seed ${seed} lost at ${nodeLabel(snapshot)} after ${actionCount} actions`)
    }

    if (snapshot.route.phase === 'between') {
      const node = snapshot.route.nodes[snapshot.route.nodeIndex]
      if (!node) throw new Error(`seed ${seed} has no current node at ${snapshot.route.chapterIndex}:${snapshot.route.nodeIndex}`)
      if (node.type === 'battle' || node.type === 'boss') {
        const battleId = node.encounterId
        if (!battleId || seenBattleIds.has(battleId)) throw new Error(`duplicate battle node ${battleId ?? '<missing>'}`)
        seenBattleIds.add(battleId)
        battles += 1
        if (battles > maxBattles) {
          return finishSummary(snapshot, seed, battles - 1, victories, actionCount, nativeTerminalResults, transcript)
        }
        const beforeRevision = snapshot.revision
        snapshot = session.enter(beforeRevision)
        transcript.push(step('enter', beforeRevision, snapshot, undefined))
      } else {
        const beforeRevision = snapshot.revision
        snapshot = await session.continue(beforeRevision)
        transcript.push(step('continue', beforeRevision, snapshot, undefined))
      }
      continue
    }

    if (snapshot.route.phase === 'result') {
      if (snapshot.route.lastResult?.outcome !== 'victory') {
        const party = snapshot.state.pieces
          .filter(piece => piece.ownerPlayerId === HUMAN)
          .map(piece => ({ id: piece.instanceId, template: piece.templateId, hp: piece.currentHp, maxHp: piece.maxHp, x: piece.x, y: piece.y }))
        const recent = transcript.slice(-12).map(entry => ({
          kind: entry.kind,
          revision: entry.revision,
          action: entry.action?.type,
          skill: entry.action && 'skillId' in entry.action ? entry.action.skillId : undefined,
          card: entry.action && 'cardInstanceId' in entry.action ? entry.action.cardInstanceId : undefined,
          partyHp: entry.partyHp,
        }))
        throw new Error(`seed ${seed} reached ${snapshot.route.lastResult?.outcome ?? 'unknown'} at ${nodeLabel(snapshot)} party=${JSON.stringify(party)} recent=${JSON.stringify(recent)}`)
      }
      victories += 1
      recordTerminal(nativeTerminalResults, snapshot.state.terminalResult, currentEncounterId(snapshot), recordedTerminalBattleIds)
      if (battles >= maxBattles) return finishSummary(snapshot, seed, battles, victories, actionCount, nativeTerminalResults, transcript)
      const beforeRevision = snapshot.revision
      snapshot = await session.continue(beforeRevision)
      transcript.push(step('continue', beforeRevision, snapshot, undefined))
      continue
    }

    if (snapshot.route.phase !== 'battle') throw new Error(`unexpected fixed route phase ${snapshot.route.phase}`)

    const supplied = await resolvePublicChoices(session, snapshot, transcript)
    if (supplied) {
      snapshot = supplied
      actionCount += 1
      continue
    }

    if (snapshot.state.terminalResult) {
      recordTerminal(nativeTerminalResults, snapshot.state.terminalResult, currentEncounterId(snapshot), recordedTerminalBattleIds)
      throw new Error(`terminal battle remained in battle phase at ${nodeLabel(snapshot)}`)
    }

    const revision = snapshot.revision
    let next: FixedRouteSnapshot
    let action: BattleAction | undefined
    if (snapshot.inputOwner === ENEMY) {
      next = session.step(revision)
      transcript.push(step('enemy', revision, next, undefined))
    } else if (snapshot.inputOwner === HUMAN) {
      action = chooseLegalHumanAction(snapshot)
      next = session.human(action, revision)
      transcript.push(step('human', revision, next, action))
    } else {
      throw new Error(`unknown input owner ${snapshot.inputOwner} at ${nodeLabel(snapshot)}`)
    }
    actionCount += 1

    if (process.env.FIXED_ROUTE_REPLAY_TRACE === '1' && actionCount % 10 === 0) {
      process.stderr.write(`fixed-route progress seed=${seed} actions=${actionCount} node=${nodeLabel(next)} phase=${next.route.phase} owner=${next.inputOwner} action=${action?.type ?? 'enemy-step'} enemyCoreHp=${next.state.pieces.filter(piece => piece.ownerPlayerId === ENEMY && piece.isCore && piece.currentHp > 0).reduce((total, piece) => total + piece.currentHp, 0)} partyHp=${next.state.pieces.filter(piece => piece.ownerPlayerId === HUMAN && piece.currentHp > 0).reduce((total, piece) => total + piece.currentHp, 0)} reserves=${next.route.party.filter(piece => piece.ownerPlayerId === HUMAN && piece.currentHp > 0 && piece.x === null).map(piece => piece.instanceId).join(',') || '-'} deployPieces=${next.deployment?.pieces.map(piece => piece.instanceId).join(',') || '-'} deployCells=${next.deployment?.cells.length ?? 0} deployUsed=${next.deployment?.used ?? false}\n`)
    }

    if (next.state.terminalResult && next.route.phase === 'battle') {
      recordTerminal(nativeTerminalResults, next.state.terminalResult, currentEncounterId(next), recordedTerminalBattleIds)
    }
    snapshot = next
  }

  if (snapshot.route.phase !== 'won' && battles < maxBattles) {
    throw new Error(`seed ${seed} exceeded replay guard at ${nodeLabel(snapshot)} phase=${snapshot.route.phase}`)
  }
  return finishSummary(snapshot, seed, battles, victories, actionCount, nativeTerminalResults, transcript)
}

function recordTerminal(
  results: Array<BattleState['terminalResult']>,
  result: BattleState['terminalResult'] | undefined,
  encounterId: string | undefined,
  recordedEncounterIds: Set<string>,
): void {
  if (!result) return
  if (encounterId && recordedEncounterIds.has(encounterId)) return
  if (encounterId) recordedEncounterIds.add(encounterId)
  results.push(result)
}

function finishSummary(
  snapshot: FixedRouteSnapshot,
  seed: number,
  battles: number,
  victories: number,
  steps: number,
  nativeTerminalResults: Array<BattleState['terminalResult']>,
  transcript: ReplayStep[],
): ReplaySummary {
  return {
    seed,
    battles,
    victories,
    chapters: snapshot.route.chapterCount,
    steps,
    finalPhase: snapshot.route.phase,
    finalRevision: snapshot.revision,
    nativeTerminalResults,
    transcript,
  }
}

async function resolvePublicChoices(
  session: FixedRouteSession,
  snapshot: FixedRouteSnapshot,
  transcript: ReplayStep[],
): Promise<FixedRouteSnapshot | undefined> {
  const progress = snapshot.world.cardProgress as {
    reward?: { relicIds: string[]; cardIds: string[] }
    rewards?: Record<string, { relicIds: string[]; cardIds: string[] }>
    players?: Record<string, { overflow: Array<{ instanceId: string }> }>
  } | null | undefined
  const player = progress?.players?.[snapshot.humanPlayerId]
  const overflow = player?.overflow?.[0]
  if (overflow) {
    const discarded = snapshot.route.cards[0]?.instanceId ?? overflow.instanceId
    const beforeRevision = snapshot.revision
    const next = session.supply('discard', discarded, beforeRevision)
    transcript.push(step('supply', beforeRevision, next, undefined))
    return next
  }

  const reward = progress?.rewards?.[snapshot.humanPlayerId] ?? progress?.reward
  if (!reward) return undefined
  // The seeded route offers one relic and later cards. Prefer the pure damage
  // Star Lantern and Light Spark cards; Blood Ledger/Blood Curse trades party
  // HP for damage and is a poor choice for a three-chapter carried party.
  const relicChoice = reward.relicIds.find(id => id === 'star-lantern') ?? reward.relicIds[0]
  const cardChoice = reward.cardIds.find(id => id === 'pve-light-spark')
    ?? reward.cardIds.find(id => id === 'pve-skirmish-calibrate')
    ?? reward.cardIds[0]
  const operation = relicChoice ? 'relic' : cardChoice ? 'cards' : undefined
  const choice = relicChoice ?? cardChoice
  if (!operation || !choice) return undefined
  const beforeRevision = snapshot.revision
  const next = session.supply(operation, choice, beforeRevision)
  transcript.push(step('supply', beforeRevision, next, undefined))
  return next
}

function chooseLegalHumanAction(snapshot: FixedRouteSnapshot): BattleAction {
  if (snapshot.state.turn.phase === 'start' || snapshot.state.turn.phase === 'end') {
    return { type: 'beginPhase' }
  }

  const reserve = snapshot.deployment?.pieces.find(piece => piece.currentHp > 0)
  const deploymentCell = snapshot.deployment?.cells[0]
  if (reserve && deploymentCell && !snapshot.deployment?.used) {
    return {
      type: 'deployReservePiece',
      playerId: snapshot.humanPlayerId,
      expectedDeploymentRevision: snapshot.deployment.revision,
      pieceId: reserve.instanceId,
      toX: deploymentCell.x,
      toY: deploymentCell.y,
    }
  }

  const candidates = listLegalAIActions(snapshot.state, snapshot.humanPlayerId)
  if (candidates.length === 0) throw new Error(`no legal human action at ${nodeLabel(snapshot)}`)
  const enemies = snapshot.state.pieces.filter(piece => piece.ownerPlayerId === snapshot.aiPlayerId && piece.currentHp > 0)
  const livingAllies = snapshot.state.pieces.filter(piece => piece.ownerPlayerId === snapshot.humanPlayerId && piece.currentHp > 0)
  const weakestAlly = livingAllies.reduce((weakest, piece) => !weakest || piece.currentHp / piece.maxHp < weakest.currentHp / weakest.maxHp ? piece : weakest, undefined as typeof livingAllies[number] | undefined)

  return [...candidates]
    .sort((left, right) => actionScore(right.action, snapshot, enemies, weakestAlly) - actionScore(left.action, snapshot, enemies, weakestAlly)
      || left.id.localeCompare(right.id))
    .map(candidate => candidate.action)[0]!
}

function actionScore(
  action: BattleAction,
  snapshot: FixedRouteSnapshot,
  enemies: BattleState['pieces'],
  weakestAlly: BattleState['pieces'][number] | undefined,
): number {
  if (action.type === 'useBasicSkill' || action.type === 'useChargeSkill') {
    const actor = snapshot.state.pieces.find(piece => piece.instanceId === action.pieceId)
    const targetsEnemy = [action.targetPieceId, ...(action.extraTargets ?? []).map(target => target.pieceId)]
      .some(id => id && enemies.some(enemy => enemy.instanceId === id))
    const targetsWeakAlly = [action.targetPieceId, ...(action.extraTargets ?? []).map(target => target.pieceId)]
      .some(id => id && weakestAlly?.instanceId === id)
    if (action.skillId === 'recall' && actor?.templateId === 'tracer') {
      const selectedOption = (action as BattleAction & { selectedOption?: unknown }).selectedOption
      // A one-action trigger restores Tracer immediately after the next enemy
      // action, keeping the captain alive without touching native HP state.
      if (actor.currentHp >= actor.maxHp * .85) return 240
      // Let the enemy round resolve before restoring when Tracer is not at
      // immediate risk of lethal damage. A one-action trigger is reserved for
      // the last few hit points so the first enemy cannot finish her first.
      const preferredOption = actor.currentHp <= 2 ? 1 : 10
      return selectedOption === preferredOption ? 1_280 : 1_120
    }
    if (action.skillId === 'sleep-dart' && actor?.templateId === 'ana') {
      const enemyCoreHp = enemies.filter(piece => piece.isCore).reduce((total, piece) => total + piece.currentHp, 0)
      return isSleepDartLineHit(action, actor, enemies) ? enemyCoreHp <= 3 ? 520 : 1_160 : 320
    }
    const isHealingGrenade = action.skillId === 'biotic-grenade'
    const needsHealing = weakestAlly !== undefined && weakestAlly.currentHp < weakestAlly.maxHp * .75
    if (isHealingGrenade && action.targetX !== undefined && action.targetY !== undefined) {
      const healing = snapshot.state.pieces
        .filter(piece => piece.ownerPlayerId === snapshot.humanPlayerId && piece.currentHp > 0 && piece.x !== null && piece.y !== null
          && piece.x >= action.targetX! && piece.x < action.targetX! + 2
          && piece.y >= action.targetY! && piece.y < action.targetY! + 2)
        .reduce((total, piece) => total + Math.max(0, piece.maxHp - piece.currentHp), 0)
      const coveredEnemies = enemies.filter(piece => piece.x !== null && piece.y !== null
        && piece.x >= action.targetX! && piece.x < action.targetX! + 2
        && piece.y >= action.targetY! && piece.y < action.targetY! + 2).length
      return (needsHealing ? 1_250 : coveredEnemies > 0 ? 1_050 : 340) + healing * 100 + coveredEnemies * 10
    }
    return (isHealingGrenade && needsHealing ? 1_250 : targetsEnemy ? 1_000 : 300)
      + (targetsWeakAlly && weakestAlly && weakestAlly.currentHp < weakestAlly.maxHp * .6 ? 150 : 0)
  }
  if (action.type === 'playCard') {
    const targetsEnemy = [action.targetPieceId, ...(action.extraTargets ?? []).map(target => target.pieceId)]
      .some(id => id && enemies.some(enemy => enemy.instanceId === id))
    const card = snapshot.route.cards.find(item => item.instanceId === action.cardInstanceId)
    if (card?.cardId === 'pve-blood-curse' && snapshot.state.pieces
      .filter(piece => piece.ownerPlayerId === snapshot.humanPlayerId && piece.currentHp > 0)
      .some(piece => piece.currentHp <= 1)) return 40
    if (card?.cardId === 'pve-skirmish-cover') return targetsEnemy ? 1_120 : 250
    if (card?.cardId === 'pve-skirmish-calibrate') return targetsEnemy ? 1_060 : 250
    if (card?.cardId === 'pve-light-spark') return targetsEnemy ? 1_040 : 250
    return targetsEnemy ? 950 : 250
  }
  if (action.type === 'deployReservePiece') return 850
  if (action.type === 'move') {
    const actor = snapshot.state.pieces.find(piece => piece.instanceId === action.pieceId)
    if (!actor || actor.x === null || actor.y === null) return 100
    const before = Math.min(...enemies.filter(enemy => enemy.x !== null && enemy.y !== null).map(enemy => Math.abs(actor.x! - enemy.x!) + Math.abs(actor.y! - enemy.y!)))
    const after = Math.min(...enemies.filter(enemy => enemy.x !== null && enemy.y !== null).map(enemy => Math.abs(action.toX - enemy.x!) + Math.abs(action.toY - enemy.y!)))
    const allies = snapshot.state.pieces.filter(piece => piece.ownerPlayerId === snapshot.humanPlayerId
      && piece.currentHp > 0 && piece.instanceId !== actor.instanceId && piece.x !== null && piece.y !== null)
    const allyDistance = allies.length === 0 ? 0 : Math.min(...allies.map(ally => Math.abs(action.toX - ally.x!) + Math.abs(action.toY - ally.y!)))
    const nearestEnemyAfter = enemies.length === 0 ? 99 : Math.min(...enemies
      .filter(enemy => enemy.x !== null && enemy.y !== null)
      .map(enemy => Math.abs(action.toX - enemy.x!) + Math.abs(action.toY - enemy.y!)))
    const nearestEnemyChebyshev = enemies.length === 0 ? 99 : Math.min(...enemies
      .filter(enemy => enemy.x !== null && enemy.y !== null)
      .map(enemy => Math.max(Math.abs(action.toX - enemy.x!), Math.abs(action.toY - enemy.y!))))
    const nearbyEnemyCount = enemies.filter(enemy => enemy.x !== null && enemy.y !== null
      && Math.max(Math.abs(action.toX - enemy.x!), Math.abs(action.toY - enemy.y!)) <= 2).length
    const plannedAttackCells = snapshot.world.plans
      .filter(plan => plan.kind === 'attack')
      .flatMap(plan => plan.cells)
    const forecastRisk = plannedAttackCells.some(cell => cell.x === action.toX && cell.y === action.toY) ? 480 : 0
    if (actor.templateId === 'ana') {
      // Keep Ana behind the captain and within grenade range while enemies
      // approach. Moving toward the nearest enemy makes the support piece die
      // before its cooldowns can stabilize the carried party.
      return 520 - allyDistance * 55 + nearestEnemyAfter * 18 + nearestEnemyChebyshev * 20 - forecastRisk
    }
    // Tracer can kite and still trigger her passive from nearby positions;
    // discourage moves that leave Ana outside practical healing range.
    const pulseDistanceBonus = nearestEnemyChebyshev === 2 ? 260 : nearestEnemyChebyshev === 1 ? -220 : 0
    const crowdPenalty = Math.max(0, nearbyEnemyCount - 1) * 160
    return 500 + (before - after) * 20 + pulseDistanceBonus - crowdPenalty
      - Math.max(0, allyDistance - 4) * 70 - forecastRisk
  }
  if (action.type === 'endTurn') return 0
  return 600
}

function isSleepDartLineHit(
  action: Extract<BattleAction, { type: 'useBasicSkill' | 'useChargeSkill' }>,
  actor: BattleState['pieces'][number],
  enemies: BattleState['pieces'],
): boolean {
  if (action.targetX === undefined || action.targetY === undefined || actor.x === null || actor.y === null) return false
  const dx = action.targetX - actor.x
  const dy = action.targetY - actor.y
  if (dx !== 0 && dy !== 0) return false
  const directionX = Math.sign(dx)
  const directionY = Math.sign(dy)
  if (directionX === 0 && directionY === 0) return false
  const distance = Math.max(Math.abs(dx), Math.abs(dy))
  for (let index = 1; index <= distance; index += 1) {
    const piece = enemies.find(enemy => enemy.x === actor.x! + directionX * index && enemy.y === actor.y! + directionY * index)
    if (piece) return !piece.statusTags?.some(tag => tag.type === 'sleep')
  }
  return false
}

function step(
  kind: ReplayStep['kind'],
  revision: number,
  snapshot: FixedRouteSnapshot,
  action: BattleAction | undefined,
): ReplayStep {
  const enemies = snapshot.state.pieces.filter(piece => piece.ownerPlayerId === snapshot.aiPlayerId && piece.currentHp > 0)
  const allies = snapshot.state.pieces.filter(piece => piece.ownerPlayerId === snapshot.humanPlayerId && piece.currentHp > 0)
  return {
    kind,
    revision,
    ...(action ? { action } : {}),
    phase: snapshot.route.phase,
    node: nodeLabel(snapshot),
    enemyCoreHp: enemies.filter(piece => piece.isCore).reduce((total, piece) => total + piece.currentHp, 0),
    partyHp: allies.reduce((total, piece) => total + piece.currentHp, 0),
  }
}

function nodeLabel(snapshot: FixedRouteSnapshot): string {
  return `${snapshot.route.chapterIndex + 1}:${snapshot.route.nodeIndex}:${snapshot.route.nodes[snapshot.route.nodeIndex]?.id ?? '<missing>'}`
}

function currentEncounterId(snapshot: FixedRouteSnapshot): string | undefined {
  return snapshot.route.nodes[snapshot.route.nodeIndex]?.encounterId
}
