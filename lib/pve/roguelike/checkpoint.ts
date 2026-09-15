import { createHash } from 'node:crypto'
import { canonicalizeJsonV1 } from '../../content-pipeline/core/canonical-json'
import { CooperativeAdventureSession } from './cooperative-session'
import { assertGameProfileCompatibleV1, type GameProfileIdentityV1 } from '../../content-pipeline/runtime/profile-game-identity'
import { RoguelikeAdventureV1Schema } from '../contracts/roguelike-content-v1'
import { adventureBoundary } from '../../game/adventure-boundary'

export type AdventureAggregate = ReturnType<CooperativeAdventureSession['exportAggregate']>
export interface AdventureCheckpoint {
  schemaVersion:'rvb-adventure-checkpoint/v1'
  revision:number
  hash:string
  aggregate:AdventureAggregate
}
export const adventureAggregateHash=(value:AdventureAggregate)=>createHash('sha256').update(canonicalizeJsonV1(value)).digest('hex')
export function createAdventureCheckpoint(session:CooperativeAdventureSession, stable=true):AdventureCheckpoint {
  if(stable&&!session.canSave())throw new Error('请等待所有战区及奖励结算后保存')
  const aggregate=session.exportAggregate()
  return {schemaVersion:'rvb-adventure-checkpoint/v1',revision:aggregate.revision,hash:adventureAggregateHash(aggregate),aggregate}
}
export function restoreAdventureCheckpoint(value:unknown,profile:GameProfileIdentityV1,stable=true) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('冒险存档无效')
  const record=value as AdventureCheckpoint
  if(record.schemaVersion!=='rvb-adventure-checkpoint/v1'||!Number.isSafeInteger(record.revision)||record.revision<0
    ||!record.aggregate||record.aggregate.revision!==record.revision||record.hash!==adventureAggregateHash(record.aggregate))throw new Error('冒险存档版本或校验不匹配')
  const data=record.aggregate
  assertGameProfileCompatibleV1(data.profile,profile)
  RoguelikeAdventureV1Schema.parse(data.content);RoguelikeAdventureV1Schema.parse(data.campaign)
  if(!Number.isInteger(data.actIndex)||data.actIndex<0||data.actIndex>(data.campaign.nextActs?.length??0))throw new Error('存档幕数无效')
  for(const state of [data.state,data.initial]){
    const world=adventureBoundary(state),coop=world?.coop
    if(!coop||coop.humanIds.length<1||coop.humanIds.length>4||new Set(coop.humanIds).size!==coop.humanIds.length
      ||state.players.length!==coop.humanIds.length+1||!Array.isArray(state.pieces)||!Array.isArray(state.graveyard)
      ||!state.players.some(p=>p.playerId===state.turn.currentPlayerId))throw new Error('存档玩家状态无效')
    const pieces=[...state.pieces,...state.graveyard,...Object.values(coop.parties).flatMap(p=>p.reserves)]
    if(new Set(pieces.map(p=>p.instanceId)).size!==pieces.length||pieces.some(p=>!Number.isFinite(p.currentHp)||!Number.isFinite(p.maxHp)||!state.players.some(x=>x.playerId===p.ownerPlayerId)))throw new Error('存档棋子状态无效')
    for(const id of coop.humanIds)if(!coop.parties[id]||!data.personal[id]||!Number.isSafeInteger(data.personal[id].coins)||data.personal[id].coins<0)throw new Error('存档个人资源无效')
  }
  const session=CooperativeAdventureSession.restoreAggregate(data)
  if(stable&&!session.canSave())throw new Error('存档不在安全结算边界')
  return session
}
