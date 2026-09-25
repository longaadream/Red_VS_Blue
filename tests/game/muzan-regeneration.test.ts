/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-authored rules are exercised through the trusted rule runtime. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'

import { runBattleAction } from '@/lib/game/battle-runner'
import { addPieceStatus, removePieceStatusSource } from '@/lib/game/status-lifecycle'
import { dealDamage, loadAllSkillsById, loadRuleById } from '@/lib/game/skills'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as any
const loadSkill = () => readJson('data/skills/muzan-flesh-regeneration.json')
const loadRegenRules = () => [
  loadRuleById('rule-muzan-regeneration-damage', true),
  loadRuleById('rule-muzan-regeneration-end', true),
].filter(Boolean) as any[]

function makeRegenerationState(currentHp = 10) {
  const muzan = makePiece({
    instanceId: 'muzan',
    templateId: 'dark-muzan',
    currentHp,
    maxHp: 15,
    rules: loadRegenRules(),
  }) as any
  const attacker = makePiece({
    instanceId: 'attacker',
    ownerPlayerId: 'player-blue',
    faction: 'blue',
    x: 1,
    attack: 5,
  }) as any
  const state = makeState({ pieces: [muzan, attacker], turnNumber: 1 }) as any
  state.skillsById = loadAllSkillsById()
  return { state, muzan, attacker }
}

function endGlobalTurn(state: any, playerId = 'player-blue') {
  return globalTriggerSystem.checkTriggers(state, {
    type: 'endTurn',
    playerId,
    turnNumber: state.turn.turnNumber,
  })
}

beforeEach(() => globalTriggerSystem.clearRules())

describe('Muzan flesh regeneration', () => {
  it('publishes a passive with the global-end wording and per-battle cap', () => {
    const skill = loadSkill()
    expect(skill).toMatchObject({
      id: 'muzan-flesh-regeneration',
      kind: 'passive',
      usesPerBattle: 3,
    })
    expect(skill.description).toContain('每个全局回合结束时')
    expect(skill.description).toContain('每局最多成功恢复3次')
  })

  it('heals on every global turn end, then stops at three successful heals', () => {
    const { state, muzan } = makeRegenerationState()

    endGlobalTurn(state, 'player-blue')
    expect(muzan.currentHp).toBe(12)
    // A repeated dispatch for the same global turn must not heal twice.
    endGlobalTurn(state, 'player-red')
    expect(muzan.currentHp).toBe(12)

    state.turn.turnNumber = 2
    endGlobalTurn(state, 'player-red')
    expect(muzan.currentHp).toBe(14)
    state.turn.turnNumber = 3
    endGlobalTurn(state, 'player-blue')
    expect(muzan.currentHp).toBe(15)
    state.turn.turnNumber = 4
    endGlobalTurn(state, 'player-blue')
    expect(muzan.currentHp).toBe(15)

    const records = state.extensions.flowState as any[]
    expect(records.find(record => record.name === 'successfulHeals')?.value).toBe(3)
    expect(records.find(record => record.name === 'lastCheckTurn')?.value).toBe(4)
  })

  it('does not regenerate after actual HP loss, but full shielding counts as no injury', () => {
    const { state, muzan, attacker } = makeRegenerationState()

    expect(dealDamage(attacker, muzan, 2, 'true', state, 'test-hit').damage).toBe(2)
    expect(muzan.currentHp).toBe(8)
    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(8)

    state.turn.turnNumber = 2
    muzan.shield = 10
    expect(dealDamage(attacker, muzan, 4, 'true', state, 'test-shielded-hit').damage).toBe(0)
    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(10)
  })

  it('does not heal damage dealt before the host receives the regeneration rules', () => {
    const { state, muzan, attacker } = makeRegenerationState()
    muzan.rules = []
    expect(dealDamage(attacker, muzan, 2, 'true', state, 'pre-injection-hit').damage).toBe(2)
    expect(muzan.currentHp).toBe(8)
    muzan.rules = loadRegenRules()

    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(8)
    expect((state.extensions.flowState as any[] | undefined)?.find(record => record.name === 'successfulHeals')).toBeUndefined()
  })

  it('treats a full shielded hit before injection as no injury', () => {
    const { state, muzan, attacker } = makeRegenerationState()
    muzan.rules = []
    muzan.shield = 10
    expect(dealDamage(attacker, muzan, 4, 'true', state, 'pre-injection-shielded-hit').damage).toBe(0)
    expect(muzan.currentHp).toBe(10)
    muzan.rules = loadRegenRules()

    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(12)
    expect((state.extensions.flowState as any[]).find(record => record.name === 'successfulHeals')?.value).toBe(1)
  })

  it('does not spend a use when healing is blocked and can heal on a later end', () => {
    const { state, muzan } = makeRegenerationState()
    muzan.rules.unshift(loadRuleById('rule-shishio-no-heal', true))

    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(10)
    expect((state.extensions.flowState as any[]).find(record => record.name === 'successfulHeals')).toBeUndefined()

    muzan.statusTags = []
    muzan.rules = loadRegenRules()
    state.turn.turnNumber = 2
    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(12)
    expect((state.extensions.flowState as any[]).find(record => record.name === 'successfulHeals')?.value).toBe(1)
  })

  it('keeps the per-piece count when statuses are cleared and gives each host its own cap', () => {
    const { state, muzan } = makeRegenerationState()
    const host = makePiece({
      instanceId: 'host',
      ownerPlayerId: 'player-red',
      currentHp: 10,
      maxHp: 15,
      rules: loadRegenRules(),
    }) as any
    state.pieces.push(host)

    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(12)
    expect(host.currentHp).toBe(12)
    addPieceStatus(state, muzan, { id: 'temporary', type: 'temporary', currentDuration: 1, sourceId: 'test' })
    removePieceStatusSource(muzan, 'test')

    state.turn.turnNumber = 2
    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(14)
    expect(host.currentHp).toBe(14)
    state.turn.turnNumber = 3
    endGlobalTurn(state)
    expect(muzan.currentHp).toBe(15)
    expect(host.currentHp).toBe(15)
    state.turn.turnNumber = 4
    endGlobalTurn(state)
    expect((state.extensions.flowState as any[]).filter(record => record.name === 'successfulHeals'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ entityId: 'muzan', value: 3 }),
        expect.objectContaining({ entityId: 'host', value: 3 }),
      ]))
  })

  it('runs the real endTurn action through the runner', () => {
    const { state, muzan } = makeRegenerationState()
    const next = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 216 }).state
    expect(next.pieces.find(piece => piece.instanceId === muzan.instanceId)?.currentHp).toBe(12)
    expect(next.turn.phase).toBe('end')
  })
})
