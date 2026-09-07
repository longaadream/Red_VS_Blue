/* eslint-disable @typescript-eslint/no-explicit-any -- Production JSON rules exercised with minimal battle fixtures. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { runBattleAction, replayBattle, hashBattleState } from '@/lib/game/battle-runner'
import { addPieceStatus, expireOwnerStatuses, removePieceStatusSource } from '@/lib/game/status-lifecycle'
import { getPositionChangeRejection, getNormalMoveRejection } from '@/lib/game/spatial'
import { dealDamage, executeSkillFunction, executeCardFunction, loadAllSkillsById, loadRuleById, addPlayerStatusWithEvents, expirePlayerStatuses } from '@/lib/game/skills'
import { changePiecePositions, assertRestrictedPositionsUnchanged } from '@/lib/game/position-change'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { makePiece, makeState } from '../helpers/minimal-state'

const json = (group: string, id: string) => JSON.parse(readFileSync(`data/${group}/${id}.json`, 'utf8'))
beforeEach(() => globalTriggerSystem.clearRules())
function fixture() {
  const state = makeState({ pieces: [makePiece({ instanceId: 'source' }), makePiece({
    instanceId: 'enemy', ownerPlayerId: 'player-blue', x: 2,
  })] }) as any
  state.skillsById = loadAllSkillsById()
  return state
}
function applyStatus(state: any, status: any) {
  const skill = { ...json('skills', 'naruto-sage-mode'), id: 'test-status',
    code: `function executeSkill() { return { success: addStatusEffectById(sourcePiece.instanceId, ${JSON.stringify(status)}) }; }` }
  return executeSkillFunction(skill, { piece: state.pieces[0], battle: state, skill, target: null, targetPosition: null }, state)
}

describe('RED-192 rule dictionary', () => {
  it('floors fractional card healing and ignores display wording when merging the same effect', () => {
    const state = fixture(), source = state.pieces[0]
    source.templateId = 'hashirama-edo'
    source.currentHp = 99
    source.maxHp = 100
    expect(executeCardFunction(json('cards', 'hashirama-edo-nature-heal'), 'player-red', state).success).toBe(true)
    expect(source.currentHp).toBe(99) // floor(1 missing HP * 0.8) = 0
    addPieceStatus(state, source, { id: 'one', type: 'silenced', description: 'first wording', currentDuration: 1 })
    addPieceStatus(state, source, { id: 'two', type: 'silenced', description: 'second wording', currentDuration: 1 })
    expect(source.statusTags).toHaveLength(1)
    expect(source.statusTags[0].remainingDuration).toBe(2)
  })
  it('settles both deaths and soul fragments before reviving two cores without ending the battle', () => {
    const state = fixture(), caster = state.pieces[0]
    caster.isCore = true
    const second = makePiece({ instanceId: 'enemy-two', ownerPlayerId: 'player-blue', x: 3 }) as any
    state.pieces.push(second)
    for (const target of [state.pieces[1], second]) {
      target.isCore = true
      target.currentHp = 2
      target.attack = 20
      target.statusTags = [{ id: 'covenant', type: 'lich-covenant' }, { id: 'root', type: 'root' }]
      target.rules = [loadRuleById('rule-arthas-lich-covenant')]
      target.initialDefinition = { stats: { maxHp: 10, attack: 3, defense: 0, moveRange: 3 }, skills: [], rules: [], statusTags: [] }
    }
    state.players[0].rules = [loadRuleById('rule-soul-fracture-player')]
    const skill = { ...json('skills', 'fireball'), id: 'two-core-deaths', actionPointCost: 1, targeting: { steps: [] },
      code: "function executeSkill() { dealDamage(sourcePiece, battle.pieces.filter(function(piece) { return piece.ownerPlayerId !== sourcePiece.ownerPlayerId; }), 99, 'true', battle, 'two-core-deaths'); return { success: true }; }" }
    caster.skills = [{ skillId: skill.id, currentCooldown: 0 }]
    state.skillsById[skill.id] = skill
    const result = runBattleAction(state, { type: 'useBasicSkill', playerId: 'player-red', pieceId: caster.instanceId, skillId: skill.id }, { rootSeed: 192 }).state
    expect(result.graveyard).toHaveLength(2)
    expect(result.players[0].hand.filter(card => card.cardId === 'soul-fragment')).toHaveLength(2)
    expect(result.pieces.filter(piece => piece.ownerPlayerId === 'player-blue')).toHaveLength(2)
    for (const piece of result.pieces.filter(piece => piece.ownerPlayerId === 'player-blue')) {
      expect(piece).toMatchObject({ currentHp: 10, attack: 4, isCore: true })
      expect(piece.statusTags.map(tag => tag.type)).toEqual(['undead-body'])
    }
    expect(result.actions?.filter(action => action.type === 'chargeCrystalDropped')).toHaveLength(2)
    expect(result.terminalResult).toBeUndefined()
  })
  it('rejects teleporting into a reserved landing without moving any piece', () => {
    const state = fixture(), before = state.pieces.map((piece: any) => [piece.x, piece.y])
    state.extensions.tileEffects = [{ type: 'tails-flight-reservation', x: 1, y: 0 }]
    expect(() => changePiecePositions(state, [{ pieceId: 'source', x: 1, y: 0 }], 'teleport')).toThrow('illegal landing')
    expect(state.pieces.map((piece: any) => [piece.x, piece.y])).toEqual(before)
  })
  it('retains the new grant timing when an older merged source is revoked', () => {
    const state = fixture(), source = state.pieces[0]
    addPieceStatus(state, source, { id: 'old', type: 'silenced', currentDuration: 1, sourceId: 'old' })
    state.turn.turnNumber = 3
    addPieceStatus(state, source, { id: 'new', type: 'silenced', currentDuration: 1, sourceId: 'new' })
    removePieceStatusSource(source, 'old')
    expireOwnerStatuses(state, 'player-red')
    expect(source.statusTags[0]).toMatchObject({ remainingDuration: 1, expiresAfterTurn: 5 })
    state.turn.turnNumber = 5
    expireOwnerStatuses(state, 'player-red')
    expect(source.statusTags).toHaveLength(0)
  })
  it('preserves Bankai per-battle usage through a real death and revival', () => {
    const state = fixture(), source = state.pieces[0]
    source.skills = [{ skillId: 'ichigo-bankai-tensa-zangetsu', currentCooldown: 0, usesRemaining: -1 }]
    source.initialDefinition = { stats: { maxHp: 10, attack: 3, defense: 0, moveRange: 3 },
      skills: structuredClone(source.skills), rules: [], statusTags: [] }
    state.players[0].chargePoints = 3
    const action = { type: 'useChargeSkill', playerId: 'player-red', pieceId: source.instanceId, skillId: 'ichigo-bankai-tensa-zangetsu' } as const
    const cast = runBattleAction(state, action, { rootSeed: 192 }).state as any
    const target = cast.pieces[0]
    target.currentHp = 5
    target.statusTags.push({ id: 'covenant', type: 'lich-covenant' })
    target.rules.push(loadRuleById('rule-arthas-lich-covenant'))
    dealDamage(cast.pieces[1], target, 99, 'true', cast)
    const revived = cast.pieces.find((piece: any) => piece.ownerPlayerId === 'player-red')
    expect(cast.graveyard.some((piece: any) => piece.instanceId === target.instanceId)).toBe(true)
    expect(revived).toMatchObject({ attack: 4, currentHp: 10, limitedSkillUses: { 'ichigo-bankai-tensa-zangetsu': 0 } })
    expect(revived.statusTags.some((tag: any) => tag.type === 'ichigo-bankai')).toBe(false)
    expect(() => runBattleAction(cast, { ...action, pieceId: revived.instanceId }, { rootSeed: 192 })).toThrow('per-battle uses')
  })

  it('does not borrow a friendly piece as the source of Holy Smite', () => {
    const state = fixture(), target = state.pieces[1]
    target.statusTags = [{ id: 'ice', type: 'icebound-fortitude' }]
    target.rules = [loadRuleById('rule-arthas-icebound'), loadRuleById('rule-arthas-icebound-retaliate')]
    state.pieces[0].rules = [{ id: 'piece-only-boost', trigger: { type: 'beforeDamageDealt' },
      effect: (_state: any, context: any) => { if (context.sourcePiece?.instanceId === 'source') context.damage += 100; return { success: true } } }]
    const result = executeCardFunction(json('cards', 'holy-smite'), 'player-red', state)
    expect(result.success).toBe(true)
    expect(target.currentHp).toBe(98)
    expect(state.pieces[0].statusTags).toHaveLength(0)
  })

  it('stacks all three Nano Boost values through the real skill and trigger', () => {
    const state = fixture(), source = state.pieces[0]
    const ally = makePiece({ instanceId: 'ally', x: 1 }) as any
    state.pieces.push(ally)
    const skill = json('skills', 'nano-boost')
    for (let i = 0; i < 2; i++) {
      const result = executeSkillFunction(skill, { piece: source, target: ally, targetPosition: { x: 1, y: 0 },
        targets: [{ info: ally, pos: { x: 1, y: 0 } }], battle: state, skill } as any, state)
      expect(result.success).toBe(true)
    }
    expect(ally.defense).toBe(6)
    expect(ally.moveRange).toBe(5)
    expect(ally.statusTags.filter((tag: any) => tag.type === 'nano-boost')).toHaveLength(1)
    expect(dealDamage(ally, state.pieces[1], 3, 'true', state).damage).toBe(5)
  })

  it('gives player statuses the same turn-end timer and permits removal of imprisoned pieces', () => {
    const state = fixture()
    addPlayerStatusWithEvents(state, 'player-red', { id: 'p', type: 'silenced', currentDuration: 1 })
    expirePlayerStatuses(state, 'player-red')
    expect(state.players[0].statusTags).toHaveLength(1)
    state.turn.turnNumber = 3
    expirePlayerStatuses(state, 'player-red')
    expect(state.players[0].statusTags).toHaveLength(0)
    state.pieces[0].statusTags = [{ id: 'p', type: 'imprisoned' }]
    const after = { ...state, pieces: [state.pieces[1]] }
    expect(() => assertRestrictedPositionsUnchanged(state, after)).not.toThrow()
  })

  it('validates an entire swap before moving either piece and exposes its before event', () => {
    const state = fixture(), before = state.pieces.map((p: any) => ({ x: p.x, y: p.y }))
    state.pieces[1].statusTags = [{ id: 'p', type: 'imprisoned' }]
    expect(() => changePiecePositions(state, [{ pieceId: 'source', x: 2, y: 0 }, { pieceId: 'enemy', x: 0, y: 0 }], 'swap')).toThrow()
    expect(state.pieces.map((p: any) => ({ x: p.x, y: p.y }))).toEqual(before)
    state.pieces[1].statusTags = []
    changePiecePositions(state, [{ pieceId: 'source', x: 2, y: 0 }, { pieceId: 'enemy', x: 0, y: 0 }], 'swap')
    expect(state.pieces[0].x).toBe(2)
    expect(state.pieces[1].x).toBe(0)
  })
  it('expires blood oath at exactly three following holder turn ends without a source tick', () => {
    const state = fixture(), piece = state.pieces[0]
    piece.rules = [loadRuleById('rule-blood-oath-tick')]
    addPieceStatus(state, piece, { id: 'oath', type: 'blood-oath', currentDuration: 3, sourcePlayerId: 'player-blue' })
    for (const turn of [1, 2, 3, 4, 5, 6]) {
      state.turn.turnNumber = turn
      state.turn.currentPlayerId = turn % 2 ? 'player-red' : 'player-blue'
      globalTriggerSystem.checkTriggers(state, { type: 'endTurn', playerId: state.turn.currentPlayerId })
      expireOwnerStatuses(state, state.turn.currentPlayerId)
      expect(piece.statusTags).toHaveLength(1)
    }
    state.turn.turnNumber = 7; state.turn.currentPlayerId = 'player-red'
    expireOwnerStatuses(state, 'player-red')
    expect(piece.statusTags).toHaveLength(0)
  })

  it('coexists for different payloads or expiries and revokes only the requested source', () => {
    const state = fixture(), piece = state.pieces[0]
    for (const [id, intensity, damageType] of [['a', 2, 'physical'], ['b', 3, 'magical']] as const) {
      addPieceStatus(state, piece, { id, type: 'damage-buff', intensity, damageType, currentDuration: 2 })
    }
    expect(piece.statusTags).toHaveLength(2)
    addPieceStatus(state, piece, { id: 'c', type: 'damage-buff', intensity: 3, damageType: 'physical', currentDuration: 1 })
    expect(piece.statusTags).toHaveLength(3)
    piece.statusTags = []; piece.rules = [{ id: 'shared' }, { id: 'source-a' }, { id: 'source-b' }]
    addPieceStatus(state, piece, { id: 'silence-a', type: 'silenced', sourceId: 'a', currentDuration: 2, relatedRules: ['shared', 'source-a'] })
    addPieceStatus(state, piece, { id: 'silence-b', type: 'silenced', sourceId: 'b', currentDuration: 1, relatedRules: ['shared', 'source-b'] })
    expect(piece.statusTags).toHaveLength(1)
    removePieceStatusSource(piece, 'b')
    expect(piece.statusTags[0].remainingDuration).toBe(2)
    expect(piece.rules.map((rule: any) => rule.id)).toEqual(['shared', 'source-a'])
  })

  it('floors every mitigation step, preserves minimum damage, and freezes only after HP loss', () => {
    const state = fixture(), target = state.pieces[1]
    target.statusTags = [{ id: 'ice', type: 'icebound-fortitude' }]
    target.rules = [loadRuleById('rule-arthas-icebound'), loadRuleById('rule-arthas-icebound-retaliate')]
    target.shield = 2
    expect(dealDamage(state.pieces[0], target, 4, 'true', state).damage).toBe(0)
    expect(state.pieces[0].statusTags).toHaveLength(0)
    expect(dealDamage(state.pieces[0], target, 1, 'true', state).damage).toBe(1)
    expect(state.pieces[0].statusTags[0].type).toBe('freeze')
    state.pieces[0].statusTags = []
    expect(dealDamage({ kind: 'player', instanceId: 'player-rule', ownerPlayerId: 'player-red', name: '玩家规则' }, target, 4, 'true', state).damage).toBe(2)
    expect(state.pieces[0].statusTags).toHaveLength(0)
    target.rules = [0, 1].map(index => ({ id: 'reduce-' + index, priority: index, trigger: { type: 'beforeDamageTaken' }, effect: (_state: any, context: any) => { context.damage *= 0.9; return { success: true } } }))
    expect(dealDamage(state.pieces[0], target, 3, 'true', state).damage).toBe(1)
  })

  it('root blocks walking only and imprisonment blocks other board movement', () => {
    const state = fixture(), piece = state.pieces[0]
    piece.statusTags = [{ id: 'root', type: 'root' }]
    expect(getNormalMoveRejection(state, piece, { x: 1, y: 0 })?.code).toBe('movement-restricted')
    expect(getPositionChangeRejection(piece, 'teleport')).toBeNull()
    piece.statusTags = [{ id: 'prison', type: 'imprisoned' }]
    for (const kind of ['walk', 'dash', 'teleport', 'push', 'pull', 'swap'] as const) expect(getPositionChangeRejection(piece, kind)).not.toBeNull()
  })

  it('rejects old pins before execution and even an empty replay without mutation', () => {
    const state = fixture()
    state.extensions.battleProfile = { schemaVersion: 'rvb-battle-profile-pin/v1', rootSeed: 192,
      profileIdentity: { schemaVersion: 'rvb-game-profile-identity/v1', engineAbi: 'v1', runnerRevision: 'rvb-battle-runner/v1', resolvedProfileHash: 'a'.repeat(64), authorityContentHash: 'b'.repeat(64) } }
    const before = hashBattleState(state)
    expect(() => runBattleAction(state, { type: 'endTurn', playerId: 'player-red' })).toThrow('unsupported rule revision')
    expect(() => replayBattle({ initialState: state, actions: [] })).toThrow('unsupported rule revision')
    expect(hashBattleState(state)).toBe(before)
  })
  it('caps actual damage at HP lost without losing the resolved damage', () => {
    const state = fixture()
    state.pieces[1].currentHp = 2
    const result = dealDamage(state.pieces[0], state.pieces[1], 10, 'true', state, 'test')
    expect(result.damage).toBe(2)
    expect((result as any).resolvedDamage).toBe(10)
  })

  it('does not expire a newly applied duration-one status at the current owner turn end', () => {
    const state = fixture()
    applyStatus(state, { id: 'test-duration', type: 'silence', currentDuration: 1 })
    const next = runBattleAction(state, { type: 'endTurn', playerId: 'player-red' }, { rootSeed: 192 }).state
    expect(next.pieces[0].statusTags.some((tag: any) => tag.type === 'silence')).toBe(true)
  })

  it('does not duplicate divine shield and adds silence duration', () => {
    const state = fixture()
    applyStatus(state, { id: 'first-shield', type: 'divine-shield', currentDuration: -1 })
    applyStatus(state, { id: 'second-shield', type: 'divine-shield', currentDuration: -1 })
    expect(state.pieces[0].statusTags.filter((tag: any) => tag.type === 'divine-shield')).toHaveLength(1)
    applyStatus(state, { id: 'first-silence', type: 'silence', currentDuration: 2 })
    applyStatus(state, { id: 'second-silence', type: 'silence', currentDuration: 1 })
    const tags = state.pieces[0].statusTags.filter((tag: any) => tag.type === 'silence')
    expect(tags).toHaveLength(1)
    expect(tags[0].remainingDuration).toBe(3)
  })

  it('advances Naruto and clones together only at the owner turn start, completing zero once', () => {
    const state = fixture()
    const naruto = state.pieces[0]
    naruto.statusTags = [{ id: 'sage', type: 'sage-mode', stacks: 2 }]
    naruto.rules = [loadRuleById('rule-naruto-sage-tick'), loadRuleById('rule-naruto-clone-endturn-charge')]
    state.pieces.push(makePiece({ instanceId: 'clone', x: 1, statusTags: [{ type: 'naruto-clone' }] }))
    globalTriggerSystem.checkTriggers(state, { type: 'endTurn', playerId: 'player-red' })
    expect(naruto.statusTags[0].stacks).toBe(2)
    globalTriggerSystem.checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' })
    expect(naruto.statusTags.some((tag: any) => tag.type === 'sage-mode')).toBe(false)
    expect(state.players[0].actionPoints).toBe(5)
    expect(state.players[0].chargePoints).toBe(1)
    globalTriggerSystem.checkTriggers(state, { type: 'beginTurn', playerId: 'player-red' })
    expect(state.players[0].actionPoints).toBe(5)
  })
})
