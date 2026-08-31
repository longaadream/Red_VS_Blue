import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDataRoot } from '@/lib/app-paths'
import { aiEnvironmentV1, listLegalAIActions } from '@/lib/game/ai-environment'
import { runBattleAction, type BattleActionResult } from '@/lib/game/battle-runner'
import { hashStable, stableJson, type BattleActionTrace } from '@/lib/game/battle-trace'
import type { PieceInstance, PieceStatusTag } from '@/lib/game/piece'
import { loadRuleById, type SkillDefinition } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem, type TriggerContext, type TriggerRule } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'

const ROOT_SEED = 0x8b0139
const BASE_SHA = '6e6ae8dd88928dc285c0cbb7a5be7e3c121ae9a2'
type Engine = 'base' | 'current'
type Run = 'authority' | 'peer'
type SkillAction = Extract<BattleAction, { type: 'useBasicSkill' }> & { clientActionId: string }
type CardAction = Extract<BattleAction, { type: 'playCard' }> & { clientActionId: string }
type EvidencePiece = PieceInstance & {
  displayMaxHp?: number
  displayCurrentHp?: number
  displayAttack?: number
  displayDefense?: number
  displayMoveRange?: number
  displayStatusTags?: PieceStatusTag[]
  masterPieceId?: string
  noKillCharge?: boolean
}
type Meta = {
  effectChainId: string | null
  effectBatchId: string | null
  parentEffectBatchId: string | null
  effectBatchKind: string | null
  effectDepth: number | null
  effectEnqueueSequence: number | null
}
type ReapEvent = Meta & {
  stage: 'afterPieceKilled' | 'onPieceDied' | 'beforeHealTaken'
  victimOnBoard: boolean
  victimInGraveyard: boolean
  redCharge: number | null
}
type SummonEvent = Meta & {
  stage: 'before' | 'after'
  sourceId: string | null
  sourceOnBoard: boolean
  extensionPresent: boolean
  anchorHp: number | null
  anchorAttack: number | null
  x: number | null
  y: number | null
}

const requestedEngine = process.env.RED139_EVIDENCE_ENGINE
if (requestedEngine && requestedEngine !== 'base' && requestedEngine !== 'current') {
  throw new Error(`Unsupported RED139_EVIDENCE_ENGINE: ${requestedEngine}`)
}
const engine: Engine = requestedEngine === 'base' ? 'base' : 'current'
const reportEnabled = process.env.RED139_EVIDENCE_REPORT === '1'
const evidenceCases: Record<string, unknown> = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function makeFixturePiece(
  overrides: Parameters<typeof makePiece>[0],
  extras: Partial<EvidencePiece> = {},
): ReturnType<typeof makePiece> {
  return Object.assign(makePiece(overrides), {
    name: 'RED-139 evidence piece',
    buffs: [],
    debuffs: [],
    ruleTags: [],
    ...extras,
  })
}

function loadProfileJson<T>(directory: 'skills' | 'cards' | 'rules', id: string): T {
  return JSON.parse(readFileSync(resolve(getDataRoot(), directory, `${id}.json`), 'utf8')) as T
}

function requiredRule(id: string): TriggerRule {
  const rule = loadRuleById(id, true)
  if (!rule) throw new Error(`Missing RED-139 evidence rule: ${id}`)
  return rule
}

function eventRule(
  id: string,
  type: string,
  effect: (battle: BattleState, context: TriggerContext) => void,
): TriggerRule {
  return {
    id, name: id, description: '', trigger: { type },
    effect: (battle, context: TriggerContext) => {
      effect(battle, context)
      return { success: true }
    },
  }
}

function meta(context: TriggerContext): Meta {
  return {
    effectChainId: context.effectChainId ?? null,
    effectBatchId: context.effectBatchId ?? null,
    parentEffectBatchId: context.parentEffectBatchId ?? null,
    effectBatchKind: context.effectBatchKind ?? null,
    effectDepth: context.effectDepth ?? null,
    effectEnqueueSequence: context.effectEnqueueSequence ?? null,
  }
}

function traceOf(result: BattleActionResult): BattleActionTrace {
  if (!result.trace) throw new Error('RED-139 evidence action produced no trace')
  return result.trace
}

function actionMessages(state: BattleState) {
  return (state.actions ?? []).map(action => ({
    type: action.type,
    playerId: action.playerId,
    turn: action.turn,
    message: typeof action.payload?.message === 'string' ? action.payload.message : null,
  }))
}

function ruleIds(piece: EvidencePiece): string[] {
  return (piece.rules as unknown[])
    .map(rule => isRecord(rule) && typeof rule.id === 'string' ? rule.id : null)
    .filter((id): id is string => id !== null)
    .sort()
}

function hasExtension(state: BattleState, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.extensions ?? {}, key)
}

function piece(state: BattleState, instanceId: string): EvidencePiece {
  const found = state.pieces.find(candidate => candidate.instanceId === instanceId)
  if (!found) throw new Error(`Missing RED-139 evidence piece: ${instanceId}`)
  return found as EvidencePiece
}

function player(state: BattleState, playerId: string) {
  const found = state.players.find(candidate => candidate.playerId === playerId)
  if (!found) throw new Error(`Missing RED-139 evidence player: ${playerId}`)
  return found
}

function runnerEvidence(authority: BattleActionResult, peer: BattleActionResult) {
  const trace = traceOf(authority)
  const peerTrace = traceOf(peer)
  const traceHash = hashStable(trace)
  const peerTraceHash = hashStable(peerTrace)
  expect(peer.stateHash).toBe(authority.stateHash)
  expect(peer.actionHash).toBe(authority.actionHash)
  expect(peerTraceHash).toBe(traceHash)
  return {
    preStateHash: trace.preStateHash,
    stateHash: authority.stateHash,
    actionHash: authority.actionHash,
    traceHash,
    peerStateHashEqual: true,
    peerActionHashEqual: true,
    peerTraceHashEqual: true,
    randomStreams: trace.randomStreams,
  }
}

function makeReapState(): BattleState {
  const skillId = 'red139-evidence-reap-hit'
  const reaper = makeFixturePiece({
    instanceId: 'reaper', templateId: 'red139-reaper', ownerPlayerId: 'player-red',
    faction: 'red', x: 0, y: 0, currentHp: 4, maxHp: 10, attack: 6,
  }, {
    name: '刈命者',
    skills: [{ skillId, level: 1, currentCooldown: 0, usesRemaining: -1 }],
    rules: [requiredRule('rule-reap')],
  })
  const victim = makeFixturePiece({
    instanceId: 'reap-victim', templateId: 'red139-reap-victim', ownerPlayerId: 'player-blue',
    faction: 'blue', x: 1, y: 0, currentHp: 5, maxHp: 5,
  }, { name: '牺牲者' })
  const state = makeState({ pieces: [reaper, victim], turnNumber: 7 })
  player(state, 'player-red').actionPoints = 10
  state.skillsById[skillId] = {
    id: skillId,
    name: 'RED-139 Reap evidence hit',
    description: '',
    kind: 'active',
    type: 'normal',
    cooldownTurns: 0,
    maxCharges: 0,
    powerMultiplier: 1,
    actionPointCost: 0,
    range: 'self',
    requiresTarget: false,
    code: "function executeSkill(context) { var victim = context.battle.pieces.find(function(piece) { return piece.instanceId === 'reap-victim'; }); if (!victim) return { success: false, message: 'missing evidence victim' }; dealDamage(context.piece, victim, 6, 'true', context.battle, 'red139-reap-lethal'); return { success: true, message: 'RED-139 Reap evidence hit' }; }",
  }
  return state
}

function reapAction(): SkillAction {
  return {
    type: 'useBasicSkill', playerId: 'player-red', pieceId: 'reaper',
    skillId: 'red139-evidence-reap-hit', clientActionId: 'red139-evidence-reap',
  }
}

function makeNarutoState(): BattleState {
  const sentinelBefore = makeFixturePiece({
    instanceId: 'sentinel-before', ownerPlayerId: 'player-blue', faction: 'blue', x: 5, y: 4,
  })
  const naruto = makeFixturePiece({
    instanceId: 'naruto', templateId: 'red-naruto', ownerPlayerId: 'player-red', faction: 'red',
    x: 1, y: 1, currentHp: 67, maxHp: 123, attack: 11, moveRange: 5,
  }, {
    name: '鸣人',
    defense: 4,
    skills: [
      { skillId: 'naruto-shadow-clone', level: 1, currentCooldown: 0, usesRemaining: -1 },
      { skillId: 'display-only-skill', level: 2, currentCooldown: 1, usesRemaining: 3 },
    ],
    statusTags: [
      { id: 'visible-tag', type: 'visible-fixture', name: 'Visible', visible: true, intensity: 2 },
      { id: 'hidden-tag', type: 'hidden-fixture', name: 'Hidden', visible: false, intensity: 9 },
    ],
  })
  const sentinelAfter = makeFixturePiece({
    instanceId: 'sentinel-after', ownerPlayerId: 'player-blue', faction: 'blue', x: 4, y: 4,
  })
  const state = makeState({ pieces: [sentinelBefore, naruto, sentinelAfter], width: 6, height: 5 })
  player(state, 'player-red').actionPoints = 10
  state.skillsById['naruto-shadow-clone'] = loadProfileJson<SkillDefinition>('skills', 'naruto-shadow-clone')
  return state
}

function narutoProjection(state: BattleState) {
  const clone = state.pieces.find(candidate => candidate.instanceId.startsWith('naruto-clone-')) as EvidencePiece | undefined
  if (!clone) throw new Error('Missing RED-139 Naruto clone')
  const casterIndex = state.pieces.findIndex(candidate => candidate.instanceId === 'naruto')
  const cloneIndex = state.pieces.findIndex(candidate => candidate.instanceId === clone.instanceId)
  return {
    instanceId: clone.instanceId,
    templateId: clone.templateId,
    name: clone.name,
    ownerPlayerId: clone.ownerPlayerId,
    faction: clone.faction,
    x: clone.x,
    y: clone.y,
    maxHp: clone.maxHp,
    currentHp: clone.currentHp,
    displayMaxHp: clone.displayMaxHp ?? null,
    displayCurrentHp: clone.displayCurrentHp ?? null,
    displayAttack: clone.displayAttack ?? null,
    displayDefense: clone.displayDefense ?? null,
    displayMoveRange: clone.displayMoveRange ?? null,
    displaySkills: clone.displaySkills ?? [],
    cloneSkillCooldown: clone.displaySkills?.find(skill => skill.skillId === 'naruto-shadow-clone')?.currentCooldown ?? null,
    displayStatusTags: clone.displayStatusTags ?? [],
    attack: clone.attack,
    defense: clone.defense,
    moveRange: clone.moveRange,
    masterPieceId: clone.masterPieceId ?? null,
    noKillCharge: clone.noKillCharge ?? false,
    rules: ruleIds(clone),
    statusTags: clone.statusTags,
    casterIndex,
    cloneIndex,
    relativeIndex: cloneIndex - casterIndex,
  }
}

function makeDemonState(stored: boolean): { action: CardAction; state: BattleState } {
  const anchor = makeFixturePiece({
    instanceId: 'demon-anchor', templateId: 'red-anchor', ownerPlayerId: 'player-red', faction: 'red',
    x: 0, y: 0, currentHp: 20, maxHp: 20, attack: 3,
  }, { name: '献祭者' })
  const state = makeState({ pieces: [anchor], turnNumber: 7 })
  const red = player(state, 'player-red')
  red.hand = [{
    cardId: 'demon-summon-5', instanceId: 'demon-card-5',
    ownerPlayerId: 'player-red', actionPointCost: 3,
  }]
  red.discardPile = []
  red.actionPoints = 3
  if (stored) {
    const extensions = state.extensions as Record<string, unknown>
    extensions.kiljaedanPiece = {
      instanceId: 'kiljaedan-hidden',
      templateId: 'kiljaedan',
      name: '基尔加丹',
      ownerPlayerId: 'player-red',
      faction: 'red',
      currentHp: 1,
      maxHp: 17,
      attack: 4,
      defense: 3,
      moveRange: 4,
      x: 0,
      y: 0,
      skills: [{ skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 }],
      displaySkills: [{ skillId: 'kiljaedan-fel-fire', level: 1, currentCooldown: 0 }],
      buffs: [],
      debuffs: [],
      ruleTags: [],
      rules: [],
      statusTags: [{ id: 'stored-status', type: 'stored-status', visible: true }],
    } satisfies EvidencePiece
  }
  const clientActionId = stored ? 'red139-evidence-demon-restore' : 'red139-evidence-demon-create'
  const query = {
    type: 'playCard', playerId: 'player-red', cardInstanceId: 'demon-card-5', clientActionId,
  } as CardAction
  const prepared = prepareAction(state, query)
  if (prepared.kind !== 'needTarget') {
    throw new Error(`Expected demon target preparation, received ${prepared.kind}`)
  }
  return {
    state,
    action: {
      ...query,
      selectionId: prepared.selectionId,
      stateRevision: prepared.stateRevision,
      targetPieceId: anchor.instanceId,
      targetX: anchor.x ?? undefined,
      targetY: anchor.y ?? undefined,
      extraTargets: [{ x: 2, y: 2 }],
    },
  }
}

function kiljaedanProjection(state: BattleState) {
  const found = state.pieces.find(candidate => candidate.templateId === 'kiljaedan') as EvidencePiece | undefined
  if (!found) throw new Error('Missing RED-139 Kiljaedan')
  const red = player(state, 'player-red')
  const anchor = piece(state, 'demon-anchor')
  return {
    instanceId: found.instanceId,
    templateId: found.templateId,
    name: found.name,
    ownerPlayerId: found.ownerPlayerId,
    faction: found.faction,
    x: found.x,
    y: found.y,
    currentHp: found.currentHp,
    maxHp: found.maxHp,
    attack: found.attack,
    defense: found.defense,
    moveRange: found.moveRange,
    skills: found.skills.map(skill => skill.skillId),
    statusTags: found.statusTags,
    rules: ruleIds(found),
    anchorHp: anchor.currentHp,
    anchorAttack: anchor.attack,
    extensionPresent: hasExtension(state, 'kiljaedanPiece'),
    actionPoints: red.actionPoints,
    hand: red.hand.map(card => card.instanceId),
    discardPile: [...red.discardPile],
  }
}

function summonEvent(
  stage: 'before' | 'after',
  battle: BattleState,
  context: TriggerContext,
  extensionKey: string,
): SummonEvent {
  const source = context.sourcePiece as EvidencePiece | undefined
  const anchor = battle.pieces.find(candidate => candidate.instanceId === 'demon-anchor')
  return {
    stage,
    sourceId: source?.instanceId ?? null,
    sourceOnBoard: !!source && battle.pieces.some(candidate => candidate.instanceId === source.instanceId),
    extensionPresent: hasExtension(battle, extensionKey),
    anchorHp: anchor?.currentHp ?? null,
    anchorAttack: anchor?.attack ?? null,
    x: source?.x ?? null,
    y: source?.y ?? null,
    ...meta(context),
  }
}

function assertSummonEvents(
  events: SummonEvent[],
  demon: boolean,
  extensionPresentBefore = false,
): void {
  if (engine === 'base') {
    expect(events).toEqual([])
    return
  }
  expect(events.map(event => event.stage)).toEqual(['before', 'after'])
  expect(events.map(event => event.effectBatchKind)).toEqual(['summon', 'summon'])
  expect(events.map(event => event.sourceOnBoard)).toEqual([false, true])
  if (demon) {
    expect(events.map(event => ({
      stage: event.stage,
      anchorHp: event.anchorHp,
      anchorAttack: event.anchorAttack,
      extensionPresent: event.extensionPresent,
    }))).toEqual([
      { stage: 'before', anchorHp: 14, anchorAttack: 4, extensionPresent: extensionPresentBefore },
      { stage: 'after', anchorHp: 14, anchorAttack: 4, extensionPresent: false },
    ])
  }
}

function runDemonEvidence(name: 'demonRestore' | 'demonCreate', stored: boolean): void {
  const fixture = makeDemonState(stored)
  const peerState = structuredClone(fixture.state)
  let run: Run = 'authority'
  const events: Record<Run, SummonEvent[]> = { authority: [], peer: [] }
  globalTriggerSystem.addRules([
    eventRule(`${name}-before`, 'beforePieceSummoned', (battle, context) => {
      if (context.sourcePiece?.templateId === 'kiljaedan') {
        events[run].push(summonEvent('before', battle, context, 'kiljaedanPiece'))
      }
    }),
    eventRule(`${name}-after`, 'afterPieceSummoned', (battle, context) => {
      if (context.sourcePiece?.templateId === 'kiljaedan') {
        events[run].push(summonEvent('after', battle, context, 'kiljaedanPiece'))
      }
    }),
  ])
  const authority = runBattleAction(fixture.state, fixture.action, { rootSeed: ROOT_SEED })
  run = 'peer'
  const peer = runBattleAction(peerState, fixture.action, { rootSeed: ROOT_SEED })
  expect(events.peer).toEqual(events.authority)
  assertSummonEvents(events.authority, true, stored)
  const final = kiljaedanProjection(authority.state)
  expect(kiljaedanProjection(peer.state)).toEqual(final)
  expect(final).toMatchObject({
    x: 2, y: 2, currentHp: 17, maxHp: 17, anchorHp: 14, anchorAttack: 4,
    extensionPresent: false, actionPoints: 0, hand: [], discardPile: ['demon-summon-5'],
  })
  if (stored) {
    expect(final.instanceId).toBe('kiljaedan-hidden')
    expect(final.statusTags).toEqual([{ id: 'stored-status', type: 'stored-status', visible: true }])
  } else {
    expect(final.instanceId).toMatch(/^kiljaedan-player-red-/)
    expect(final.skills).toEqual([
      'kiljaedan-demonic-pact', 'kiljaedan-fel-fire', 'kiljaedan-soul-drain',
    ])
  }
  const messages = actionMessages(authority.state)
  evidenceCases[name] = {
    ...runnerEvidence(authority, peer),
    events: events.authority,
    recorderHash: hashStable(events.authority),
    final,
    actionMessages: messages,
    actionMessagesHash: hashStable(messages),
  }
}

describe('RED-139 old/new hash evidence', () => {
  beforeEach(() => globalTriggerSystem.clearRules())
  afterEach(() => globalTriggerSystem.clearRules())

  it('records Reap timing, message, trace, and state hashes', () => {
    const firstState = makeReapState()
    const peerState = makeReapState()
    let run: Run = 'authority'
    const events: Record<Run, ReapEvent[]> = { authority: [], peer: [] }
    const record = (
      stage: ReapEvent['stage'], battle: BattleState, context: TriggerContext,
    ) => {
      events[run].push({
        stage,
        victimOnBoard: battle.pieces.some(candidate => candidate.instanceId === 'reap-victim'),
        victimInGraveyard: battle.graveyard.some(candidate => candidate.instanceId === 'reap-victim'),
        redCharge: battle.players.find(candidate => candidate.playerId === 'player-red')?.chargePoints ?? null,
        ...meta(context),
      })
    }
    globalTriggerSystem.addRules([
      eventRule('red139-evidence-reap-killed', 'afterPieceKilled', (battle, context) => {
        if (context.targetPiece?.instanceId === 'reap-victim') record('afterPieceKilled', battle, context)
      }),
      eventRule('red139-evidence-reap-died', 'onPieceDied', (battle, context) => {
        if (context.sourcePiece?.instanceId === 'reap-victim') record('onPieceDied', battle, context)
      }),
      eventRule('red139-evidence-reap-heal', 'beforeHealTaken', (battle, context) => {
        if (context.targetPiece?.instanceId === 'reaper') record('beforeHealTaken', battle, context)
      }),
    ])
    const action = reapAction()
    const authority = runBattleAction(firstState, action, { rootSeed: ROOT_SEED })
    run = 'peer'
    const peer = runBattleAction(peerState, action, { rootSeed: ROOT_SEED })
    expect(events.peer).toEqual(events.authority)
    const finalReaper = piece(authority.state, 'reaper')
    const messages = actionMessages(authority.state)
    const triggerMessages = messages
      .filter(entry => entry.type === 'triggerEffect' && entry.message)
      .map(entry => entry.message)
    const final = {
      reaperHp: finalReaper.currentHp,
      victimOnBoard: authority.state.pieces.some(candidate => candidate.instanceId === 'reap-victim'),
      victimInGraveyard: authority.state.graveyard.some(candidate => candidate.instanceId === 'reap-victim'),
      redCharge: player(authority.state, 'player-red').chargePoints,
      triggerMessages,
    }
    evidenceCases.reap = {
      ...runnerEvidence(authority, peer),
      events: events.authority,
      recorderHash: hashStable(events.authority),
      final,
      actionMessages: messages,
      actionMessagesHash: hashStable(messages),
    }
    expect(final).toMatchObject({
      reaperHp: 7, victimOnBoard: false, victimInGraveyard: true, redCharge: 1,
    })
    if (engine === 'base') {
      expect(events.authority.map(event => event.stage)).toEqual([
        'beforeHealTaken', 'afterPieceKilled', 'onPieceDied',
      ])
      expect(events.authority[0]).toMatchObject({
        victimOnBoard: true, victimInGraveyard: false, redCharge: 0, effectBatchKind: null,
      })
      expect(triggerMessages).toContain('刈命者通过收割恢复了3点生命值')
    } else {
      expect(events.authority.map(event => event.stage)).toEqual([
        'afterPieceKilled', 'onPieceDied', 'beforeHealTaken',
      ])
      expect(events.authority[2]).toMatchObject({
        victimOnBoard: false, victimInGraveyard: true, redCharge: 1, effectBatchKind: 'heal',
      })
      expect(triggerMessages).toContain('刈命者触发了收割')
    }
  })

  it('records Naruto lifecycle, projection, transition, and state hashes', () => {
    const firstState = makeNarutoState()
    const peerState = structuredClone(firstState)
    const candidate = listLegalAIActions(firstState, 'player-red').find(item => (
      item.kind === 'basic-skill'
      && item.action.type === 'useBasicSkill'
      && item.action.skillId === 'naruto-shadow-clone'
      && item.action.selectedOption === 'summon'
      && item.action.targetX === 2
      && item.action.targetY === 1
    ))
    if (!candidate) throw new Error('Missing RED-139 Naruto evidence candidate')
    let run: Run = 'authority'
    const events: Record<Run, SummonEvent[]> = { authority: [], peer: [] }
    const record = (stage: 'before' | 'after', battle: BattleState, context: TriggerContext) => {
      const source = context.sourcePiece as EvidencePiece | undefined
      if (source?.masterPieceId === 'naruto') {
        events[run].push(summonEvent(stage, battle, context, '__unused__'))
      }
    }
    globalTriggerSystem.addRules([
      eventRule('red139-evidence-naruto-before', 'beforePieceSummoned', (battle, context) => {
        record('before', battle, context)
      }),
      eventRule('red139-evidence-naruto-after', 'afterPieceSummoned', (battle, context) => {
        record('after', battle, context)
      }),
    ])
    const authority = aiEnvironmentV1.simulate(firstState, candidate, { rootSeed: ROOT_SEED })
    run = 'peer'
    const peer = aiEnvironmentV1.simulate(peerState, candidate, { rootSeed: ROOT_SEED })
    expect(authority.accepted).toBe(true)
    expect(peer.accepted).toBe(true)
    if (!authority.accepted || !peer.accepted) throw new Error('Naruto evidence transition was rejected')
    expect(peer.stateHash).toBe(authority.stateHash)
    expect(peer.transitionHash).toBe(authority.transitionHash)
    expect(hashStable(peer.trace)).toBe(hashStable(authority.trace))
    expect(events.peer).toEqual(events.authority)
    assertSummonEvents(events.authority, false)
    const final = narutoProjection(authority.state)
    expect(narutoProjection(peer.state)).toEqual(final)
    expect(final).toMatchObject({
      templateId: 'red-naruto', name: '鸣人', ownerPlayerId: 'player-red', faction: 'red',
      x: 2, y: 1, maxHp: 99, currentHp: 99,
      displayMaxHp: 123, displayCurrentHp: 67, displayAttack: 11,
      displayDefense: 4, displayMoveRange: 5,
      attack: 0, defense: 0, moveRange: 0, masterPieceId: 'naruto', noKillCharge: true,
      rules: [
        'rule-naruto-clone-died', 'rule-naruto-clone-immobile', 'rule-naruto-clone-one-hit',
      ],
    })
    expect(Math.abs(final.relativeIndex)).toBe(1)
    expect(final.cloneSkillCooldown).toBe(engine === 'base' ? 3 : 0)
    const messages = authority.trace.actionLog.map(entry => ({
      type: entry.type,
      playerId: entry.playerId,
      turn: entry.turn,
      message: typeof entry.payload?.message === 'string' ? entry.payload.message : null,
    }))
    evidenceCases.naruto = {
      preStateHash: authority.trace.actionTrace?.preStateHash ?? null,
      stateHash: authority.stateHash,
      transitionHash: authority.transitionHash,
      traceHash: hashStable(authority.trace),
      actionHash: authority.trace.actionTrace?.actionHash ?? hashStable(candidate.action),
      candidateActionHash: hashStable(candidate.action),
      peerStateHashEqual: true,
      peerTransitionHashEqual: true,
      peerTraceHashEqual: true,
      randomStreams: authority.trace.actionTrace?.randomStreams ?? [],
      events: events.authority,
      recorderHash: hashStable(events.authority),
      final,
      actionMessages: messages,
      actionMessagesHash: hashStable(messages),
    }
  })

  it('records demon-summon-5 stored restore lifecycle, trace, and state hashes', () => {
    runDemonEvidence('demonRestore', true)
  })

  it('records demon-summon-5 fallback identity, trace, and state hashes', () => {
    runDemonEvidence('demonCreate', false)
  })

  afterAll(() => {
    if (!reportEnabled) return
    expect(Object.keys(evidenceCases).sort()).toEqual([
      'demonCreate', 'demonRestore', 'naruto', 'reap',
    ])
    console.info(`RED139_EVIDENCE ${stableJson({
      schema: 'red-139-effect-batch-evidence/v1',
      engine,
      baseSha: BASE_SHA,
      rootSeed: ROOT_SEED,
      cases: evidenceCases,
    })}`)
  })
})
