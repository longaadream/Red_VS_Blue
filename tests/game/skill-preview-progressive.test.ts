import { describe, expect, it, vi } from 'vitest'

import { createInitialBattleForPlayers } from '@/lib/game/battle-setup'
import { runBattleAction, hashBattleState } from '@/lib/game/battle-runner'
import { toPublicBattleState } from '@/lib/game/deployment'
import type { PieceTemplate } from '@/lib/game/piece'
import { getPieceById } from '@/lib/game/piece-repository'
import { prepareAction } from '@/lib/game/targeting'
import { preparePublicSkillAction, previewBattleAction } from '@/lib/game/skill-preview'
import type { BattleAction, BattleState } from '@/lib/game/turn'

const PLAYERS = ['player-red', 'player-blue'] as const
const ROOT_SEED = 18_707
const CANONICAL_RED_IDS = ['uther', 'jaina', 'anduin', 'tracer', 'tyrande', 'turalyon', 'velen', 'blue-tirion-fordring']
const CANONICAL_BLUE_IDS = ['reaper', 'red-blackwidow', 'red-illidan', 'dark-ulquiorra', 'dark-grimmjow', 'guldan', 'dark-aizen', 'red-obito']
type BasicSkillAction = Extract<BattleAction, { type: 'useBasicSkill' }>

function roster(prefix: string, faction: 'good' | 'evil'): PieceTemplate[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-preview-${index + 1}`,
    name: `${prefix} preview ${index + 1}`,
    faction,
    rarity: 'common' as const,
    stats: { maxHp: 12, attack: 4, defense: 0, moveRange: 3 },
    skills: [
      { skillId: 'blink', level: 1 },
      { skillId: 'fireball', level: 1 },
    ],
  }))
}

async function createProgressiveBattle(): Promise<BattleState> {
  const red = roster('red', 'good')
  const blue = roster('blue', 'evil')
  const battle = await createInitialBattleForPlayers(
    [...PLAYERS],
    [...red, ...blue],
    [
      { playerId: PLAYERS[0], pieces: red, faction: 'red', alignment: 'light' },
      { playerId: PLAYERS[1], pieces: blue, faction: 'blue', alignment: 'dark' },
    ],
    'large-hole-arena',
    {
      firstPlayerId: PLAYERS[0],
      rootSeed: ROOT_SEED,
      deploymentEnabled: true,
      deploymentStartedAt: 1_750_000_000_000,
    },
  )
  if (!battle) throw new Error('Expected progressive battle')
  return battle
}

async function createCanonicalBattle(): Promise<BattleState> {
  const red = CANONICAL_RED_IDS.map(id => getPieceById(id))
  const blue = CANONICAL_BLUE_IDS.map(id => getPieceById(id))
  if (red.some(piece => !piece) || blue.some(piece => !piece)) throw new Error('Missing canonical tutorial roster template')
  const battle = await createInitialBattleForPlayers(
    [...PLAYERS],
    [],
    [
      { playerId: PLAYERS[0], pieces: red as PieceTemplate[], faction: 'red', alignment: 'light' },
      { playerId: PLAYERS[1], pieces: blue as PieceTemplate[], faction: 'blue', alignment: 'dark' },
    ],
    'large-hole-arena',
    {
      firstPlayerId: PLAYERS[0],
      rootSeed: ROOT_SEED,
      deploymentEnabled: true,
      deploymentStartedAt: 1_750_000_000_000,
    },
  )
  if (!battle) throw new Error('Expected canonical progressive battle')
  return battle
}

function skillAction(state: BattleState, skillId: string, sourceTemplateId?: string): BasicSkillAction {
  const source = state.pieces.find(piece => piece.ownerPlayerId === PLAYERS[0]
    && (!sourceTemplateId || piece.templateId === sourceTemplateId)
    && piece.skills.some(skill => skill.skillId === skillId))
  if (!source) throw new Error('Expected a red vanguard')
  const draft: BasicSkillAction = {
    type: 'useBasicSkill',
    playerId: PLAYERS[0],
    pieceId: source.instanceId,
    skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget' || !prepared.rangeCells?.length) {
    throw new Error(`Expected grid target preparation, got ${JSON.stringify({
      kind: prepared.kind,
      message: 'message' in prepared ? prepared.message : undefined,
      phase: state.turn.phase,
      currentPlayerId: state.turn.currentPlayerId,
      player: state.players.find(player => player.playerId === PLAYERS[0]),
      source,
      deployment: state.deployment,
    })}`)
  }
  const target = prepared.rangeCells[0]
  return {
    ...draft,
    targetX: target.x,
    targetY: target.y,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function blinkAction(state: BattleState): BasicSkillAction {
  return skillAction(state, 'blink')
}

function pieceTargetSkillAction(state: BattleState, skillId: string, sourceTemplateId: string): BasicSkillAction {
  const source = state.pieces.find(piece => piece.ownerPlayerId === PLAYERS[0]
    && piece.templateId === sourceTemplateId
    && piece.skills.some(skill => skill.skillId === skillId))
  if (!source) throw new Error(`Expected ${sourceTemplateId} on the board`)
  const draft: BasicSkillAction = {
    type: 'useBasicSkill', playerId: PLAYERS[0], pieceId: source.instanceId, skillId,
  }
  const prepared = prepareAction(state, draft)
  if (prepared.kind !== 'needTarget' || prepared.candidates.length === 0) {
    throw new Error(`Expected piece target preparation for ${skillId}, got ${prepared.kind}`)
  }
  const target = prepared.candidates[0]
  if (target.type !== 'piece') throw new Error(`Expected a piece target for ${skillId}`)
  return {
    ...draft,
    targetPieceId: target.pieceId,
    selectionId: prepared.selectionId,
    stateRevision: prepared.stateRevision,
  }
}

function deployFirstOffer(state: BattleState): BattleState {
  const deployment = state.deployment
  if (!deployment?.offerPieceIds?.[0] || !deployment.legalPositions?.[0]) {
    throw new Error('Expected an active progressive deployment offer')
  }
  return runBattleAction(state, {
    type: 'deployReservePiece',
    playerId: PLAYERS[0],
    expectedDeploymentRevision: deployment.revision,
    pieceId: deployment.offerPieceIds[0],
    toX: deployment.legalPositions[0].x,
    toY: deployment.legalPositions[0].y,
    clientActionId: 'red231-deploy-first-offer',
  }, { rootSeed: ROOT_SEED }).state
}

function withClientSkillCatalog(state: BattleState, catalog: BattleState['skillsById']): BattleState {
  return { ...state, skillsById: structuredClone(catalog) }
}

async function deployUntilTemplate(initial: BattleState, templateId: string): Promise<BattleState> {
  let state = initial
  for (let turn = 0; turn < 24; turn += 1) {
    if (state.pieces.some(piece => piece.templateId === templateId && piece.x !== null && piece.y !== null)) return state
    const deployment = state.deployment
    if (deployment?.status === 'awaiting-reserve-deploy') {
      const activePlayerId = deployment.activePlayerId ?? state.turn.currentPlayerId
      const reserve = Object.values(deployment.reserves ?? {}).flat()
      const preferred = activePlayerId === PLAYERS[0]
        ? deployment.offerPieceIds?.find(pieceId => reserve.find(piece => piece.instanceId === pieceId)?.templateId === templateId)
        : undefined
      const pieceId = preferred ?? deployment.offerPieceIds?.[0]
      const position = deployment.legalPositions?.[0]
      if (!pieceId || !position) throw new Error('Expected a progressive deployment offer')
      state = runBattleAction(state, {
        type: 'deployReservePiece',
        playerId: activePlayerId,
        expectedDeploymentRevision: deployment.revision,
        pieceId,
        toX: position.x,
        toY: position.y,
        clientActionId: `red231-deploy-${templateId}-${turn}`,
      }, { rootSeed: ROOT_SEED }).state
      continue
    }
    if (state.turn.phase === 'action') {
      state = runBattleAction(state, {
        type: 'endTurn',
        playerId: state.turn.currentPlayerId,
        clientActionId: `red231-end-${templateId}-${turn}`,
      }, { rootSeed: ROOT_SEED }).state
      continue
    }
    if (state.turn.phase === 'end') {
      state = runBattleAction(state, { type: 'beginPhase' }, { rootSeed: ROOT_SEED }).state
      continue
    }
    throw new Error(`Cannot advance canonical deployment from ${state.turn.phase}`)
  }
  throw new Error(`Could not deploy canonical ${templateId}`)
}

function withoutDuration<T>(value: T): T {
  const copy = structuredClone(value) as T & { durationMs?: number }
  delete copy.durationMs
  return copy
}

describe('RED-231 progressive deployment skill preview', () => {
  it('previews a legal skill after real reserve deployment without changing authority', async () => {
    const initial = await createProgressiveBattle()
    expect(initial.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'awaiting-reserve-deploy',
    })

    const deployed = deployFirstOffer(initial)
    expect(deployed.deployment).toMatchObject({
      mode: 'progressive-reserve-v1',
      status: 'turn-ready',
    })
    expect(deployed.turn.phase).toBe('action')
    expect(deployed.turn.currentPlayerId).toBe(PLAYERS[0])

    const clientDeployed = withClientSkillCatalog(deployed, initial.skillsById)
    const initialPublic = toPublicBattleState(withClientSkillCatalog(initial, initial.skillsById), PLAYERS[0])
    const publicState = toPublicBattleState(clientDeployed, PLAYERS[0])
    const action = blinkAction(publicState)
    expect(previewBattleAction(initialPublic, action, PLAYERS[0]).status).toBe('unavailable')
    const beforeHash = hashBattleState(clientDeployed)
    const beforeCursors = structuredClone(clientDeployed.extensions?.debugBattle?.authority?.runtimeCursors)
    const publicBefore = JSON.stringify(publicState)
    const preview = previewBattleAction(publicState, action, PLAYERS[0])

    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') return

    const actual = runBattleAction(structuredClone(clientDeployed), action, { rootSeed: ROOT_SEED }).state
    const previewSource = preview.snapshot.pieces.find(piece => piece.instanceId === action.pieceId)
    const actualSource = actual.pieces.find(piece => piece.instanceId === action.pieceId)
    expect(previewSource).toMatchObject({ x: actualSource?.x, y: actualSource?.y })
    expect(preview.snapshot.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
      .toBe(actual.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
    expect(hashBattleState(clientDeployed)).toBe(beforeHash)
    expect(clientDeployed.extensions?.debugBattle?.authority?.runtimeCursors).toEqual(beforeCursors)
    expect(JSON.stringify(publicState)).toBe(publicBefore)

    const completeState = withClientSkillCatalog({
      ...clientDeployed,
      deployment: {
        ...clientDeployed.deployment!,
        status: 'complete',
        reserves: { 'player-red': [], 'player-blue': [] },
        reserveCounts: { 'player-red': 0, 'player-blue': 0 },
      },
    }, initial.skillsById)
    const completePublic = toPublicBattleState(completeState, PLAYERS[0])
    expect(previewBattleAction(completePublic, blinkAction(completePublic), PLAYERS[0]).status).toBe('ready')
  })

  it('does not let hidden reserve replacement affect a public ready preview', async () => {
    const initial = await createProgressiveBattle()
    const deployed = withClientSkillCatalog(deployFirstOffer(initial), initial.skillsById)
    const firstPublic = toPublicBattleState(deployed, PLAYERS[0])
    const first = previewBattleAction(firstPublic, blinkAction(firstPublic), PLAYERS[0])

    const hiddenVariant = structuredClone(deployed)
    for (const reserve of Object.values(hiddenVariant.deployment?.reserves ?? {})) {
      for (const piece of reserve) {
        piece.name = 'hidden replacement'
        piece.currentHp = 1
        piece.attack = 99
        piece.skills = []
      }
    }
    const secondPublic = toPublicBattleState(hiddenVariant, PLAYERS[0])
    const second = previewBattleAction(secondPublic, blinkAction(secondPublic), PLAYERS[0])

    expect(first.status).toBe('ready')
    expect(withoutDuration(second)).toEqual(withoutDuration(first))
    if (second.status === 'ready') {
      expect(second.snapshot).not.toHaveProperty('deployment')
      expect(JSON.stringify(second.snapshot)).not.toContain('hidden replacement')
    }
  })

  it.each([
    ['legacy awaiting locks', (state: BattleState) => ({
      ...state,
      deployment: { ...state.deployment!, mode: 'legacy-reroll-v1' as const, status: 'awaiting-locks' as const },
    })],
    ['progressive start phase', (state: BattleState) => ({
      ...state,
      turn: { ...state.turn, phase: 'start' as const },
    })],
    ['progressive end phase', (state: BattleState) => ({
      ...state,
      turn: { ...state.turn, phase: 'end' as const },
    })],
  ])('keeps %s unavailable', async (_label, mutate) => {
    const initial = await createProgressiveBattle()
    const deployed = withClientSkillCatalog(deployFirstOffer(initial), initial.skillsById)
    const action = blinkAction(toPublicBattleState(deployed, PLAYERS[0]))
    const state = mutate(deployed)
    const publicState = toPublicBattleState(state, PLAYERS[0])
    expect(previewBattleAction(publicState, action, PLAYERS[0]).status)
      .toBe('unavailable')
  })

  it('works with the canonical 8-vs-8 tutorial roster and a real holy skill', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const initial = await createCanonicalBattle()
      const deployed = withClientSkillCatalog(
        await deployUntilTemplate(initial, 'anduin'),
        initial.skillsById,
      )
      const allPieces = [
        ...deployed.pieces,
        ...Object.values(deployed.deployment?.reserves ?? {}).flat(),
      ]
      expect(allPieces.filter(piece => piece.ownerPlayerId === PLAYERS[0])).toHaveLength(8)
      expect(allPieces.filter(piece => piece.ownerPlayerId === PLAYERS[1])).toHaveLength(8)
      expect(deployed.pieces.find(piece => piece.templateId === 'anduin')).toMatchObject({ currentHp: 12 })

      const publicState = toPublicBattleState(deployed, PLAYERS[0])
      const action = pieceTargetSkillAction(publicState, 'light-of-the-light', 'anduin')
      const beforeHash = hashBattleState(deployed)
      const publicBefore = JSON.stringify(publicState)
      const preview = previewBattleAction(publicState, action, PLAYERS[0])
      expect(preview.status).toBe('ready')
      if (preview.status !== 'ready') return

      const actual = runBattleAction(deployed, action, { rootSeed: ROOT_SEED }).state
      expect(preview.snapshot.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
        .toBe(actual.players.find(player => player.playerId === PLAYERS[0])?.actionPoints)
      expect(preview.snapshot.pieces.find(piece => piece.templateId === 'anduin')?.currentHp)
        .toBe(actual.pieces.find(piece => piece.templateId === 'anduin')?.currentHp)
      expect(hashBattleState(deployed)).toBe(beforeHash)
      expect(JSON.stringify(publicState)).toBe(publicBefore)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('returns public target input for Jaina frostbolt instead of falling back to authority state', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const initial = await createCanonicalBattle()
      const deployed = withClientSkillCatalog(
        await deployUntilTemplate(initial, 'jaina'),
        initial.skillsById,
      )
      const publicState = toPublicBattleState(deployed, PLAYERS[0])
      const source = publicState.pieces.find(piece => piece.templateId === 'jaina')
      if (!source) throw new Error('Expected Jaina on the canonical board')
      const preparation = preparePublicSkillAction(publicState, {
        type: 'useBasicSkill',
        playerId: PLAYERS[0],
        pieceId: source.instanceId,
        skillId: 'frostbolt',
      }, PLAYERS[0])

      expect(preparation.status).toBe('needs-input')
      if (preparation.status !== 'needs-input') return
      expect(preparation.preparation).toMatchObject({
        kind: 'needTarget',
        source: { type: 'skill', id: 'frostbolt', pieceId: source.instanceId },
      })
    } finally {
      logSpy.mockRestore()
    }
  })
})
