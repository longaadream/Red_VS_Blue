import { afterEach, describe, expect, it } from 'vitest'
import { recordBattlePresentation, recordedBattlePresentation, createBattlePresentationQueue, checkpointBattlePresentation, withBattlePresentationSource } from '@/lib/game/battle-presentation-recording'
import { projectBattlePresentationEvents } from '@/lib/game/battle-presentation-events'
import { runBattleAction } from '@/lib/game/battle-runner'
import { dealDamage, healDamage, loadAllSkillsById, loadRuleById, addStatusWithEvents, removeStatusWithEvents } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import { globalTriggerSystem } from '@/lib/game/triggers'
import type { BattleAction, BattleState } from '@/lib/game/turn'
import { makePiece, makeState } from '../helpers/minimal-state'

afterEach(() => globalTriggerSystem.clearRules())

function run(state: BattleState, action: BattleAction) {
  return recordBattlePresentation(state, () => runBattleAction(state, action, { rootSeed: 169 }), result => result.state)
}

describe('ordered committed presentation recording', () => {
  it('gives the real Chaos Control multiple targets and statuses one explicit batch after teleport', () => {
    const caster = makePiece({instanceId:'shadow',x:0,y:0,skills:[{skillId:'shadow-chaos-control',currentCooldown:0,usesRemaining:-1}]})
    const before = makeState({pieces:[caster,
      makePiece({instanceId:'enemy-a',ownerPlayerId:'player-blue',faction:'blue',x:3,y:1}),
      makePiece({instanceId:'enemy-b',ownerPlayerId:'player-blue',faction:'blue',x:4,y:1})]})
    before.players[0].actionPoints=10; before.players[0].chargePoints=10
    before.skillsById=loadAllSkillsById()
    const base: BattleAction={type:'useChargeSkill',playerId:'player-red',pieceId:'shadow',skillId:'shadow-chaos-control'}
    const prepared=prepareAction(before,base)
    if(prepared.kind!=='needTarget') throw new Error('Expected target selection')
    const action={...base,targetX:1,targetY:1,selectionId:prepared.selectionId,stateRevision:prepared.stateRevision} as BattleAction
    const result=run(before,action)
    const events=recordedBattlePresentation(result.state)!
    const statuses=events.filter(e=>e.kind==='statusAdded')
    expect(events[0].kind).toBe('forceMove')
    expect(statuses).toHaveLength(4)
    expect(statuses[0].batchId).toBeTruthy()
    expect(new Set(statuses.map(e=>e.batchId)).size).toBe(1)
    expect(new Set(statuses.flatMap(e=>e.targetPieceIds!)).size).toBe(2)
    expect(result.stateHash).toBe(runBattleAction(before,action,{rootSeed:169}).stateHash)
  })

  it('removes real Kagutsuchi tiles as one batch before applying the target status', () => {
    const caster=makePiece({instanceId:'sasuke',x:0,y:0,skills:[{skillId:'sasuke-kagutsuchi',currentCooldown:0,usesRemaining:-1}]})
    const before=makeState({pieces:[caster,makePiece({instanceId:'target',ownerPlayerId:'player-blue',faction:'blue',x:1,y:1})]})
    before.players[0].actionPoints=10
    before.skillsById=loadAllSkillsById()
    const cells=[{x:1,y:0},{x:2,y:0},{x:3,y:0}]
    before.extensions={amaterasuCells:cells,tileEffects:cells.map(c=>({...c,tileType:'amaterasu',sourceId:'amaterasu'}))}
    const base: BattleAction={type:'useBasicSkill',playerId:'player-red',pieceId:'sasuke',skillId:'sasuke-kagutsuchi'}
    const prepared=prepareAction(before,base)
    if(prepared.kind!=='needTarget') throw new Error('Expected target selection')
    const action={...base,targetPieceId:'target',selectionId:prepared.selectionId,stateRevision:prepared.stateRevision} as BattleAction
    const result=run(before,action)
    const events=recordedBattlePresentation(result.state)!
    expect(events.map(e=>e.kind)).toEqual(['tileEffectRemoved','tileEffectRemoved','tileEffectRemoved','statusAdded'])
    expect(events[0].batchId).toBeTruthy()
    expect(events[0].batchId).toBe(events[2].batchId)
    expect(events[3].batchId).toBeUndefined()
    expect(result.stateHash).toBe(runBattleAction(before,action,{rootSeed:169}).stateHash)
  })

  it('queues explicit status batches while keeping triggers and subsequent batches ordered', () => {
    const state = makeState({ pieces: [makePiece({instanceId: 'a'}), makePiece({instanceId:'b'})] })
    const queue = createBattlePresentationQueue(state)
    recordBattlePresentation(state, () => {
      queue.push('statusAdded', () => {
        for (const piece of state.pieces) addStatusWithEvents(state, piece.instanceId,
          { id:'shield', name:'Shield', type:'divine-shield', currentDuration:-1, currentUses:1, intensity:1, stacks:1, relatedRules:[] })
      })
      queue.push('statusRemoved', () => {
        for (const piece of state.pieces) removeStatusWithEvents(state, piece.instanceId, 'shield')
      })
      queue.push('statusAdded', () => {
        state.pieces[0].statusTags.push({id:'a',type:'buff'} as never)
        checkpointBattlePresentation(state)
        withBattlePresentationSource(state, {ruleId:'reaction'}, () => {
          state.pieces[1].statusTags.push({id:'reaction',type:'buff'} as never)
        })
        state.pieces[0].statusTags.push({id:'b',type:'buff'} as never)
      })
      return state
    }, s => s)
    const events = recordedBattlePresentation(state)!
    expect(events.slice(0,4).map(e => e.kind)).toEqual(['statusAdded','statusAdded','statusRemoved','statusRemoved'])
    expect(events[0].batchId).toBeTruthy()
    expect(events[0].batchId).toBe(events[1].batchId)
    expect(events[2].batchId).toBe(events[3].batchId)
    expect(events[0].batchId).not.toBe(events[2].batchId)
    expect(events.find(e => e.statusId === 'reaction')?.batchId).toBeUndefined()
    expect(events.map(e => e.kind).slice(4)).toEqual(['statusAdded','passive','statusAdded','statusAdded'])
  })

  it('retains an added then removed tile batch and stable identity of unchanged tiles', () => {
    const state = makeState()
    const extensions = state.extensions = { tileEffects: [{x:0,y:0,tileType:'fire',sourceId:'a'}, {x:1,y:0,tileType:'fire',sourceId:'a'}] }
    recordBattlePresentation(state, () => {
      const queue = createBattlePresentationQueue(state)
      queue.push('tileEffectAdded', () => {
        extensions.tileEffects.push({x:2,y:0,tileType:'fire',sourceId:'a'}, {x:3,y:0,tileType:'fire',sourceId:'a'})
      })
      queue.push('tileEffectRemoved', () => {
        extensions.tileEffects = extensions.tileEffects.filter(t => t.x === 1)
      })
      return state
    }, s => s)
    const events = recordedBattlePresentation(state)!
    expect(events.map(e => e.kind)).toEqual(['tileEffectAdded','tileEffectAdded','tileEffectRemoved','tileEffectRemoved','tileEffectRemoved'])
    expect(events[0].batchId).toBe(events[1].batchId)
    expect(events[2].batchId).toBe(events[4].batchId)
    expect(events.every(e => e.targetCell?.x !== 1)).toBe(true)
    expect(events[0].result).toMatchObject({effectId:'fire:2,0:a',effectType:'fire'})
  })

  it('records real Amaterasu as one nine-cell batch without changing state or hash', () => {
    const caster = makePiece({instanceId:'sasuke', x:0,y:0, skills:[{skillId:'sasuke-amaterasu',currentCooldown:0,usesRemaining:-1}]})
    const before = makeState({pieces:[caster], width:6,height:6})
    before.players[0].actionPoints = 10
    before.skillsById = loadAllSkillsById()
    const base: BattleAction = {type:'useBasicSkill',playerId:'player-red',pieceId:'sasuke',skillId:'sasuke-amaterasu'}
    const prepared = prepareAction(before, base)
    if (prepared.kind !== 'needTarget') throw new Error('Expected target selection')
    const action = {...base,targetX:2,targetY:2,selectionId:prepared.selectionId,stateRevision:prepared.stateRevision} as BattleAction
    const plain = runBattleAction(before, action, {rootSeed:169})
    const recorded = run(before,action)
    expect(recorded.state).toEqual(plain.state)
    expect(recorded.stateHash).toBe(plain.stateHash)
    const tiles = projectBattlePresentationEvents({actionId:'amaterasu',command:action,beforeState:before,afterState:recorded.state}).filter(e => e.kind === 'tileEffectAdded')
    expect(tiles).toHaveLength(9)
    expect(tiles[0].batchId).toBeTruthy()
    expect(new Set(tiles.map(e=>e.batchId)).size).toBe(1)
  })

  it('records the real Kenshin skill as three hits with three health values, without altering authority', () => {
    const caster = makePiece({ instanceId: 'kenshin', attack: 4, x: 0, y: 0,
      skills: [{ skillId: 'kenshin-ryusosen', currentCooldown: 0, usesRemaining: -1 }] })
    const target = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 1, y: 0, currentHp: 20 })
    const before = makeState({ pieces: [caster, target] })
    before.skillsById['kenshin-ryusosen'] = loadAllSkillsById()['kenshin-ryusosen']
    const base: BattleAction = { type: 'useBasicSkill', playerId: 'player-red', pieceId: 'kenshin', skillId: 'kenshin-ryusosen' }
    const prepared = prepareAction(before, base)
    if (prepared.kind !== 'needTarget') throw new Error('Expected target selection')
    const action = { ...base, targetPieceId: 'enemy', selectionId: prepared.selectionId, stateRevision: prepared.stateRevision } as BattleAction
    const plain = runBattleAction(before, action, { rootSeed: 169 })
    const recorded = run(before, action)
    expect(recorded.stateHash).toBe(plain.stateHash)
    expect(recorded.state).toEqual(plain.state)
    const events = projectBattlePresentationEvents({ actionId: 'kenshin', command: action, beforeState: before, afterState: recorded.state })
    const hits = events.filter(e => e.kind === 'damage')
    expect(hits.map(e => e.result)).toEqual([{ amount: 3, value: 17 }, { amount: 3, value: 14 }, { amount: 3, value: 11 }])
    expect(new Set(hits.map(e => e.batchId)).size).toBe(3)
    expect(hits.every(e => e.sourcePieceId === 'kenshin')).toBe(true)
  })

  it('records the real Grimmjow response as relocation then alternating enemy and self damage', () => {
    const grimm = makePiece({ instanceId: 'grimm', templateId: 'dark-grimmjow', x: 0, y: 1,
      currentHp: 10, maxHp: 10, attack: 4, rules: [loadRuleById('rule-grimmjow-hunt-after-move', true)!] })
    const enemy = makePiece({ instanceId: 'enemy', ownerPlayerId: 'player-blue', faction: 'blue', x: 3, y: 1, currentHp: 20 })
    const before = makeState({ pieces: [grimm, enemy], currentPlayerId: 'player-blue', width: 6, height: 4 })
    const pending = run(before, { type: 'move', playerId: 'player-blue', pieceId: 'enemy', toX: 2, toY: 1 }).state
    expect(pending.pendingTargetSelection).toBeDefined()
    expect(recordedBattlePresentation(pending)).toEqual([])
    const selection = pending.pendingTargetSelection!
    const action = { type: 'pendingTargetSelect', playerId: 'player-red', targetX: 1, targetY: 1,
      selectionId: selection.selectionId, stateRevision: selection.stateRevision } as BattleAction
    const result = run(pending, action)
    const events = recordedBattlePresentation(result.state)!
    expect(events.filter(e => e.kind === 'forceMove').map(e => e.targetPieceIds)).toEqual([['enemy'], ['grimm']])
    const firstHit = events.findIndex(e => e.kind === 'damage')
    expect(events[firstHit - 1]).toMatchObject({ kind: 'forceMove', targetPieceIds: ['grimm'], result: { fromX: 0, toX: 1 } })
    expect(events.filter(e => e.kind === 'damage').map(e => [e.targetPieceIds?.[0], e.result?.value])).toEqual([
      ['enemy', 17], ['grimm', 9], ['enemy', 14], ['grimm', 8],
    ])
  })

  it('preserves explicit damage/heal batches and damage followed by recovery even when net HP is unchanged', () => {
    const source = makePiece({ instanceId: 'source' })
    const a = makePiece({ instanceId: 'a', currentHp: 10, maxHp: 20 })
    const b = makePiece({ instanceId: 'b', currentHp: 10, maxHp: 20 })
    const state = makeState({ pieces: [source, a, b] })
    recordBattlePresentation(state, () => {
      dealDamage(state.pieces[0], state.pieces.slice(1), 3, 'true', state)
      healDamage(state.pieces[0], state.pieces.slice(1), 3, state)
      return state
    }, s => s)
    const events = recordedBattlePresentation(state)!
    expect(events.map(e => e.kind)).toEqual(['damage', 'damage', 'heal', 'heal'])
    expect(events[0].batchId).toBe(events[1].batchId)
    expect(events[2].batchId).toBe(events[3].batchId)
    expect(events.map(e => e.result?.value)).toEqual([7, 7, 10, 10])
  })

  it('does not retain failed recordings or affect later unrecorded execution', () => {
    const state = makeState({ pieces: [makePiece()] })
    expect(() => recordBattlePresentation(state, () => { throw new Error('failed') }, s => s)).toThrow('failed')
    expect(recordedBattlePresentation(state)).toBeUndefined()
  })
})
