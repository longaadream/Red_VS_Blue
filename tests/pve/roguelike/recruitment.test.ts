import { describe, expect, it } from 'vitest'
import { AdventureSession, createAdventureState } from '@/lib/pve/roguelike/session'
import { adventureContent, HUMAN, ENEMY } from '@/lib/pve/roguelike/content'
import { generateAdventureContent } from '@/lib/pve/roguelike/generation'
import { adventureBoundary } from '@/lib/game/adventure-boundary'
import { runBattleActionIsolated } from '@/lib/game/battle-runner'
import { getServerGameProfileIdentityV1 } from '@/lib/content-pipeline/runtime/profile-game-identity'
import { loadAllSkillsById } from '@/lib/game/skills'
import { prepareAction } from '@/lib/game/targeting'
import type { BattleAction } from '@/lib/game/turn'

const captainId = `${HUMAN}-1`
async function fixture(cost = 15) {
  const content = structuredClone(adventureContent)
  content.recruitment = { ...content.recruitment!, cost, pieceIds: ['reaper', 'ana', 'liadrin'], candidates: 3 }
  // Put a real searchable source next to the real recruitment facility for a short integration path.
  content.sites.find(s => s.id === 'supply')!.x = 3; content.sites.find(s => s.id === 'supply')!.y = 26
  const state = runBattleActionIsolated(await createAdventureState(getServerGameProfileIdentityV1(), content), { type: 'beginPhase' }).state
  state.pieces.find(p => p.instanceId === captainId)!.x = 3
  state.pieces.find(p => p.instanceId === captainId)!.y = 27
  return { content, state, session: new AdventureSession(state, content) }
}
describe('map recruitment authority', () => {
  it('uses actual search coins, joins reserve with rules, and rejects duplicates, stale and invalid choices atomically', async () => {
    const { session } = await fixture()
    const before = session.snapshot()
    expect(() => session.interact('recruit-camp', 'recruit', captainId, 0, 'reaper')).toThrow('金币')
    expect(() => session.interact('recruit-camp', 'recruit', captainId, 0, 'pve-arthas')).toThrow('候选')
    expect(session.snapshot()).toEqual(before)
    session.interact('supply', 'search', captainId, 0)
    const hired = session.interact('recruit-camp', 'recruit', captainId, 1, 'reaper')
    const recruit = hired.deployment.pieces.find(p => p.templateId === 'reaper')!
    expect(recruit).toMatchObject({ isCore: true, currentHp: 13, x: null, y: null, ownerPlayerId: HUMAN })
    expect(recruit.initialDefinition?.rules).toContain('rule-reap')
    expect(recruit.rules.some(rule => rule.id === 'rule-reap')).toBe(true)
    expect(hired.state.pieces.filter(p => p.ownerPlayerId === HUMAN)).toHaveLength(1)
    expect(hired.world.coins).toBe(0)
    expect(hired.state.players[0].actionPoints).toBe(2)
    const after = session.snapshot()
    expect(() => session.interact('recruit-camp', 'recruit', captainId, 1, 'ana')).toThrow('过期')
    expect(() => session.interact('recruit-camp', 'recruit', captainId, 2, 'ana')).toThrow('已招募')
    expect(session.snapshot()).toEqual(after)
  })
  it('rejects distant and in-battle recruitment before spending anything', async () => {
    const { state, content } = await fixture(0)
    state.pieces[0].x = 15; state.pieces[0].y = 23
    const distant = new AdventureSession(state, content), before = distant.snapshot()
    expect(() => distant.interact('recruit-camp', 'recruit', captainId, 0, 'ana')).toThrow('相邻')
    expect(distant.snapshot()).toEqual(before)
    adventureBoundary(state)!.activeZone = content.zones[0]
    const fighting = new AdventureSession(state, content)
    expect(() => fighting.interact('recruit-camp', 'recruit', captainId, 0, 'ana')).toThrow('封锁')
  })
  it('deploys a recruit natively, then restores its template and wounds after a real victory', async () => {
    const { session, content } = await fixture(0)
    const hired = session.interact('recruit-camp', 'recruit', captainId, 0, 'reaper')
    const id = hired.deployment.pieces.find(p => p.templateId === 'reaper')!.instanceId
    // Move using native actions along the original authored road, retaining this session's roster baseline.
    for (const [toX,toY] of [[3,26],[8,26],[10,26]]) session.human({ type:'move', playerId:HUMAN, pieceId:captainId, toX, toY }, session.snapshot().revision)
    expect(session.snapshot().world.active).toBe('gate')
    const placed = session.human({type:'deployReservePiece',playerId:HUMAN,pieceId:id,expectedDeploymentRevision:session.snapshot().deployment.revision,toX:11,toY:26},session.snapshot().revision)
    expect(placed.state.players[0].actionPoints).toBe(1)
    expect(placed.state.pieces.find(p=>p.instanceId===id)?.rules.some(r=>r.id==='rule-reap')).toBe(true)
    // Recreate the exact world baseline plus progression to isolate the real terminal skill transaction.
    // The session remains the owner; the test narrows the private state only for the fixture's lethal shot.
    const owner = session as unknown as { state: typeof placed.state }
    const ally = owner.state.pieces.find(p=>p.instanceId===id)!
    ally.x=15; ally.y=23; ally.currentHp=6; ally.attack=99
    const target = owner.state.pieces.find(p=>p.instanceId===`${ENEMY}-1`)!
    target.currentHp=1
    owner.state.players[0].actionPoints=10; owner.state.skillsById=loadAllSkillsById()
    const base:BattleAction={type:'useBasicSkill',playerId:HUMAN,pieceId:id,skillId:'hellfire-shotgun'}
    const prepared=prepareAction(owner.state,base)
    if(prepared.kind!=='needTarget')throw new Error('Expected shotgun targeting')
    const won=session.human({...base,targetX:16,targetY:23,selectionId:prepared.selectionId,stateRevision:prepared.stateRevision} as BattleAction,session.snapshot().revision)
    expect(won.world.cleared).toContain(content.zones[0].id)
    const returned=won.deployment.pieces.find(p=>p.instanceId===id)!
    expect(returned).toMatchObject({templateId:'reaper',attack:4,x:null,y:null,isCore:true})
    expect(returned.currentHp).toBeLessThan(returned.maxHp)
    expect(returned.currentHp).toBeGreaterThanOrEqual(6) // Native reap may heal the real hit.
    expect(returned.rules.some(r=>r.id==='rule-reap')).toBe(true)
    expect(won.state.pieces.filter(p=>p.ownerPlayerId===HUMAN).map(p=>p.instanceId)).toEqual([captainId])
  }, 15000)
  it('charges increasing dismissal costs and never removes the captain', async () => {
    const { session }=await fixture(0)
    session.interact('supply','search',captainId,0)
    const hired=session.interact('recruit-camp','recruit',captainId,1,'ana')
    const id=hired.deployment.pieces.find(p=>p.templateId==='ana')!.instanceId
    session.human({type:'move',playerId:HUMAN,pieceId:captainId,toX:5,toY:27},2)
    const before=session.snapshot()
    expect(()=>session.interact('camp','dismiss',captainId,before.revision,captainId)).toThrow('队长')
    expect(session.snapshot()).toEqual(before)
    const removed=session.interact('camp','dismiss',captainId,before.revision,id)
    expect(removed.world.coins).toBe(5);expect(removed.world.recruitment?.dismissPrice).toBe(20)
    expect(removed.deployment.pieces.some(p=>p.instanceId===id)).toBe(false)
    const after = session.snapshot()
    expect(()=>session.interact('camp','dismiss',captainId,removed.revision,`${HUMAN}-2`)).toThrow('金币')
    expect(session.snapshot()).toEqual(after)
  })
  it('isolates two generated sessions and exposes their own seed, sites and authoritative legal moves', async () => {
    const one=generateAdventureContent(adventureContent,42),two=generateAdventureContent(adventureContent,43)
    const first=new AdventureSession(await createAdventureState(getServerGameProfileIdentityV1(),one),one)
    const initial=first.snapshot()
    const second=new AdventureSession(await createAdventureState(getServerGameProfileIdentityV1(),two),two)
    expect(first.snapshot()).toEqual(initial)
    expect(initial.world.sites).toEqual(one.sites);expect(second.snapshot().world.sites).toEqual(two.sites)
    expect(initial.world.seed).toBe(42);expect(second.snapshot().world.seed).toBe(43)
    expect(initial.state.map.tiles).not.toEqual(second.snapshot().state.map.tiles)
  })
})
