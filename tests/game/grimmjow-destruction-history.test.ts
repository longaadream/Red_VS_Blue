/* eslint-disable @typescript-eslint/no-explicit-any -- Exercises JSON authored rules in the real engine. */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { dealDamage, loadRuleById } from '@/lib/game/skills'
import { RuleRuntime, withRuleRuntime } from '@/lib/game/rule-runtime'
import { globalTriggerSystem } from '@/lib/game/triggers'
import { prepareAction } from '@/lib/game/targeting'
import { runBattleAction } from '@/lib/game/battle-runner'
import { makePiece, makeState } from '@/tests/helpers/minimal-state'
const root = process.env.RVB_GRIMMJOW_QA_ROOT || path.resolve(__dirname, '../..')
const json = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
beforeEach(() => { vi.stubEnv('RVB_PROFILE_ROOT', root); globalTriggerSystem.clearRules() })
afterEach(() => { globalTriggerSystem.clearRules(); vi.unstubAllEnvs() })
function fixture(hp = 10) {
  const grimm: any = makePiece({instanceId:'grimm',templateId:'dark-grimmjow',currentHp:hp,maxHp:hp,attack:4,x:0,y:0}); grimm.name='格里姆乔'
  grimm.rules=json('data/pieces/dark-grimmjow.json').rules.map((id:string)=>loadRuleById(id,true,true))
  grimm.skills=json('data/pieces/dark-grimmjow.json').skills.map((s:any)=>({skillId:s.skillId,currentCooldown:0,usesRemaining:-1}))
  const enemy:any=makePiece({instanceId:'enemy',ownerPlayerId:'player-blue',attack:1,currentHp:100,maxHp:100,x:1,y:0})
  const state:any=makeState({pieces:[grimm,enemy]});state.players[0].actionPoints=20
  for (const id of ['grimmjow-gran-rey-cero','grimmjow-panther-claw']) state.skillsById[id]=json('data/skills/'+id+'.json')
  return {grimm,enemy,state}
}
function damage(run:()=>void) { withRuleRuntime(new RuleRuntime({rootSeed:202,tick:1}),run) }
it('any attributed damage triggers one self hit, regardless of skill identity, without recursive damage',()=>{
  const {grimm,enemy,state}=fixture()
  damage(()=>dealDamage(grimm,enemy,2,'true',state,'new-unlisted-ability'))
  expect(enemy.currentHp).toBe(98);expect(grimm.currentHp).toBe(9)
})
it('AoE charges separately for each damaged target',()=>{
  const {grimm,enemy,state}=fixture();const other:any=makePiece({instanceId:'other',ownerPlayerId:'player-blue',attack:1,currentHp:100,maxHp:100,x:2,y:0});state.pieces.push(other)
  damage(()=>dealDamage(grimm,[enemy,other],2,'true',state,'new-aoe'))
  expect(grimm.currentHp).toBe(8)
})
it('sequential hits charge each time, but zero damage and other attackers do not',()=>{
  const {grimm,enemy,state}=fixture()
  damage(()=>{for(let i=0;i<3;i++)dealDamage(grimm,enemy,1,'true',state,'multi');dealDamage(grimm,enemy,0,'true',state,'zero');dealDamage(enemy,grimm,1,'true',state,'enemy')})
  expect(grimm.currentHp).toBe(6)
})
it('the passive own damage does not trigger itself again',()=>{
  const {grimm,state}=fixture();damage(()=>dealDamage(grimm,grimm,1,'true',state,'grimmjow-destruction-instinct'));expect(grimm.currentHp).toBe(9)
})
it('blocked damage does not charge',()=>{
  const {grimm,enemy,state}=fixture();enemy.rules.push({id:'qa-block',trigger:{type:'beforeDamageTaken'},effect:()=>({success:true,blocked:true})})
  damage(()=>dealDamage(grimm,enemy,3,'physical',state,'blocked'))
  expect(enemy.currentHp).toBe(100);expect(grimm.currentHp).toBe(10)
})
it.each(['move','skill'])('hunting after %s makes two hits and charges only twice',kind=>{
  const {grimm,enemy,state}=fixture();enemy.x=2
  const rule=loadRuleById('rule-grimmjow-hunt-after-'+kind,true,true)!
  damage(()=>rule.effect(state,{rulePiece:grimm,sourcePiece:enemy,selectedTargets:[{type:'cell',x:1,y:0}],reservedCells:[]} as any))
  expect(enemy.currentHp).toBe(94);expect(grimm.currentHp).toBe(8)
})
it('Panther Claw makes five hits and charges five times without the old extra calls',()=>{
  const {grimm,enemy,state}=fixture(20);grimm.statusTags.push({id:'qa-resurreccion',type:'resurreccion',currentDuration:-1,currentUses:-1});grimm.skills.push({skillId:'grimmjow-panther-claw',currentCooldown:0,usesRemaining:-1})
  const base:any={type:'useBasicSkill',playerId:grimm.ownerPlayerId,pieceId:grimm.instanceId,skillId:'grimmjow-panther-claw'}
  const prep:any=prepareAction(state,base);if(prep.kind!=='needTarget')throw Error(JSON.stringify(prep))
  const next=runBattleAction(state,{...base,targetPieceId:enemy.instanceId,selectionId:prep.selectionId,stateRevision:prep.stateRevision},{rootSeed:202}).state
  expect(next.pieces.find((p:any)=>p.instanceId==='grimm')?.currentHp).toBe(15)
  expect(next.pieces.find((p:any)=>p.instanceId==='enemy')?.currentHp).toBe(85)
})
it('a real Gran Rey Cero hitting two enemies charges twice without the old extra self hit',()=>{
  const {grimm,enemy,state}=fixture();const other:any=makePiece({instanceId:'other',ownerPlayerId:'player-blue',attack:1,currentHp:100,maxHp:100,x:2,y:0});state.pieces.push(other)
  const base:any={type:'useBasicSkill',playerId:grimm.ownerPlayerId,pieceId:grimm.instanceId,skillId:'grimmjow-gran-rey-cero'}
  const prep:any=prepareAction(state,base);expect(prep.kind).toBe('needTarget')
  const next=runBattleAction(state,{...base,targetPieceId:other.instanceId,selectionId:prep.selectionId,stateRevision:prep.stateRevision},{rootSeed:202}).state
  expect(next.pieces.find((p:any)=>p.instanceId==='grimm')?.currentHp).toBe(8)
  expect(next.pieces.find((p:any)=>p.instanceId===enemy.instanceId)?.currentHp).toBeLessThan(100)
})
it('self damage death resummons with the passive still attached to the new instance',()=>{
  const {grimm,enemy,state}=fixture(1);damage(()=>dealDamage(grimm,enemy,1,'true',state,'last-hit'))
  const replacement=state.pieces.find((p:any)=>p.templateId==='dark-grimmjow');expect(replacement.instanceId).not.toBe(grimm.instanceId);expect(replacement.currentHp).toBe(10)
  expect(replacement.rules.some((r:any)=>r.id==='rule-grimmjow-destruction-instinct')).toBe(true)
  damage(()=>dealDamage(replacement,enemy,1,'true',state,'after-resummon'));expect(replacement.currentHp).toBe(9)
})
it('low HP Panther Claw stops once self damage kills its transformed caster',()=>{
  const {grimm,enemy,state}=fixture(2);grimm.statusTags.push({id:'qa-resurreccion',type:'resurreccion',currentDuration:-1,currentUses:-1});grimm.skills.push({skillId:'grimmjow-panther-claw',currentCooldown:0,usesRemaining:-1})
  const base:any={type:'useBasicSkill',playerId:grimm.ownerPlayerId,pieceId:grimm.instanceId,skillId:'grimmjow-panther-claw'}
  const prep:any=prepareAction(state,base)
  const next=runBattleAction(state,{...base,targetPieceId:enemy.instanceId,selectionId:prep.selectionId,stateRevision:prep.stateRevision},{rootSeed:202}).state
  expect(next.pieces.some((p:any)=>p.instanceId==='grimm')).toBe(false)
  expect(next.pieces.find((p:any)=>p.instanceId==='enemy')?.currentHp).toBe(94)
})
it('queued AoE self hits do not transfer to the replacement after the original dies',()=>{
  const {grimm,enemy,state}=fixture(1);const other:any=makePiece({instanceId:'other',ownerPlayerId:'player-blue',currentHp:100,x:2,y:0});state.pieces.push(other)
  damage(()=>dealDamage(grimm,[enemy,other],1,'true',state,'aoe-last-hit'))
  const replacement=state.pieces.find((p:any)=>p.templateId==='dark-grimmjow');expect(replacement.instanceId).not.toBe('grimm');expect(replacement.currentHp).toBe(10)
})
it('wires the new rule and removes all four old self-damage call sites',()=>{
  expect(json('data/rules/manifest.json')).toContain('rule-grimmjow-destruction-instinct')
  for(const file of ['skills/grimmjow-gran-rey-cero','skills/grimmjow-panther-claw','rules/rule-grimmjow-hunt-after-move','rules/rule-grimmjow-hunt-after-skill']) {
    const data=json('data/'+file+'.json');expect(data.code||data.skillCode).not.toContain("'grimmjow-destruction-instinct'")
  }
})
